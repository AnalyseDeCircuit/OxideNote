//! Typst compiler integration — embedded compilation of `.typ` documents.
//!
//! Implements `typst::World` via `OxideWorld`, which resolves files relative
//! to the vault root. Font discovery uses `fontdb` to scan system font dirs.
//! Compile results are returned as SVG pages (for preview) or PDF bytes (for export).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use fontdb::Database as FontDatabase;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

// Required for chrono NaiveDate/NaiveTime method access
use chrono::{Datelike, Timelike};

use crate::commands::note::validate_inside_vault;
use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum TypstError {
    #[error("No vault opened")]
    NoVault,
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Compilation failed: {0}")]
    CompileError(String),
}

impl Serialize for TypstError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// ── Diagnostic output ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TypstDiagnostic {
    /// 1-based line number
    pub line: usize,
    /// 1-based column
    pub column: usize,
    /// Severity: "error" or "warning"
    pub severity: String,
    /// Human-readable message
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TypstCompileResult {
    /// SVG strings, one per page
    pub pages: Vec<String>,
    /// Compilation diagnostics (errors and warnings)
    pub diagnostics: Vec<TypstDiagnostic>,
    /// Compilation time in milliseconds
    pub compile_time_ms: u64,
    /// Source mapping: each page maps to (start_line, end_line) in the source (1-based)
    pub source_mapping: Vec<(usize, usize)>,
}

// ── Shared font state ───────────────────────────────────────

/// Shared font state built once per app session and reused across compilations.
/// Font discovery is expensive (~100-500ms), so we cache it in AppState.
pub struct FontState {
    book: LazyHash<FontBook>,
    fonts: Vec<FontSlot>,
}

/// A lazily-loaded font slot. Stores the raw bytes once loaded.
struct FontSlot {
    path: PathBuf,
    index: u32,
    font: once_cell::sync::OnceCell<Option<Font>>,
}

impl FontState {
    /// Build font state by scanning system font directories.
    pub fn new() -> Self {
        let mut fontdb = FontDatabase::new();
        fontdb.load_system_fonts();

        let mut book = FontBook::new();
        let mut fonts = Vec::new();

        for face in fontdb.faces() {
            let path = match &face.source {
                fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _) => path.clone(),
                _ => continue,
            };

            if let Some(info) = FontInfo::new(
                &std::fs::read(&path).unwrap_or_else(|e| {
                    tracing::warn!("Failed to read font file {}: {}", path.display(), e);
                    Vec::new()
                }),
                face.index,
            ) {
                book.push(info);
                fonts.push(FontSlot {
                    path,
                    index: face.index,
                    font: once_cell::sync::OnceCell::new(),
                });
            }
        }

        Self {
            book: LazyHash::new(book),
            fonts,
        }
    }

    /// Get a font by its index in the font book.
    fn font(&self, index: usize) -> Option<Font> {
        let slot = self.fonts.get(index)?;
        slot.font
            .get_or_init(|| {
                let data = std::fs::read(&slot.path).ok()?;
                Font::new(Bytes::new(data), slot.index)
            })
            .clone()
    }
}

// ── OxideWorld ──────────────────────────────────────────────

/// Implements `typst::World` for OxideNote.
/// Resolves source/binary files relative to a vault root directory.
struct OxideWorld {
    /// Root directory for file resolution (vault root)
    root: PathBuf,
    /// FileId of the main entry .typ file
    main_id: FileId,
    /// Shared library instance
    library: LazyHash<Library>,
    /// Shared font state (book + fonts)
    font_state: Arc<FontState>,
    /// Source file cache — maps FileId to parsed Source
    sources: Mutex<HashMap<FileId, Source>>,
    /// Binary file cache — maps FileId to raw bytes
    files: Mutex<HashMap<FileId, Bytes>>,
}

impl OxideWorld {
    /// Create a new world rooted at `root` with `main_path` as the entry file.
    /// `main_path` should be relative to `root`.
    fn new(root: PathBuf, main_path: &str, font_state: Arc<FontState>) -> Self {
        let main_id = FileId::new(None, VirtualPath::new(main_path));
        Self {
            root,
            main_id,
            library: LazyHash::new(Library::builder().build()),
            font_state,
            sources: Mutex::new(HashMap::new()),
            files: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve a FileId to an absolute filesystem path.
    fn resolve_path(&self, id: FileId) -> FileResult<PathBuf> {
        let vpath = id.vpath();
        // VirtualPath::as_rooted_path() returns a path with leading /
        let rel = vpath
            .as_rooted_path()
            .strip_prefix("/")
            .unwrap_or(vpath.as_rooted_path());
        let full = self.root.join(rel);

        // Security: verify the resolved path stays within vault root
        let canonical_root = self.root.canonicalize().map_err(|_| FileError::AccessDenied)?;
        if full.exists() {
            let canonical = full.canonicalize().map_err(|_| FileError::NotFound(full.clone()))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(FileError::AccessDenied);
            }
            Ok(canonical)
        } else {
            // For files that don't exist, validate the parent
            if let Some(parent) = full.parent() {
                if parent.exists() {
                    let canonical_parent = parent
                        .canonicalize()
                        .map_err(|_| FileError::NotFound(full.clone()))?;
                    if !canonical_parent.starts_with(&canonical_root) {
                        return Err(FileError::AccessDenied);
                    }
                }
            }
            Err(FileError::NotFound(full))
        }
    }

    /// Read and cache a source file.
    fn read_source(&self, id: FileId) -> FileResult<Source> {
        // Check cache first
        if let Some(source) = self.sources.lock().get(&id) {
            return Ok(source.clone());
        }
        let path = self.resolve_path(id)?;
        let text = std::fs::read_to_string(&path).map_err(|_| FileError::NotFound(path))?;
        let source = Source::new(id, text);
        self.sources.lock().insert(id, source.clone());
        Ok(source)
    }

    /// Read and cache a binary file.
    fn read_file(&self, id: FileId) -> FileResult<Bytes> {
        // Check cache first
        if let Some(bytes) = self.files.lock().get(&id) {
            return Ok(bytes.clone());
        }
        let path = self.resolve_path(id)?;
        let data = std::fs::read(&path).map_err(|_| FileError::NotFound(path))?;
        let bytes = Bytes::new(data);
        self.files.lock().insert(id, bytes.clone());
        Ok(bytes)
    }
}

impl World for OxideWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.font_state.book
    }

    fn main(&self) -> FileId {
        self.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.read_source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.read_file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.font_state.font(index)
    }

    fn today(&self, offset: Option<i64>) -> Option<Datetime> {
        let now = chrono::Local::now();
        let naive = match offset {
            Some(hours) => {
                let tz = chrono::FixedOffset::east_opt((hours as i32) * 3600)?;
                now.with_timezone(&tz).naive_local()
            }
            None => now.naive_local(),
        };
        Datetime::from_ymd_hms(
            naive.year(),
            naive.month() as u8,
            naive.day() as u8,
            naive.hour() as u8,
            naive.minute() as u8,
            naive.second() as u8,
        )
    }
}

// ── Tauri commands ──────────────────────────────────────────

/// Compile a .typ file and return SVG pages with diagnostics.
#[tauri::command]
pub async fn compile_typst_to_svg(
    path: String,
    state: State<'_, AppState>,
) -> Result<TypstCompileResult, TypstError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(TypstError::NoVault)?;

    // Validate path stays inside vault
    let _full_path =
        validate_inside_vault(vault, &path).map_err(|_| TypstError::AccessDenied)?;

    // Initialize font state lazily (cached in AppState for reuse)
    let font_state = state.get_or_init_fonts();

    let vault_owned = vault.clone();
    let path_owned = path.clone();

    // Run CPU-bound compilation on a blocking thread
    let result = tokio::task::spawn_blocking(move || {
        let start = Instant::now();
        let world = OxideWorld::new(vault_owned, &path_owned, font_state);

        let warned = typst::compile::<typst::layout::PagedDocument>(&world);
        let elapsed = start.elapsed().as_millis() as u64;

        // Read main source for building source mapping
        let main_source = world.source(world.main_id).ok();
        let total_lines = main_source
            .as_ref()
            .map(|s| s.text().lines().count().max(1))
            .unwrap_or(1);

        // Collect warnings regardless of success/failure
        let mut all_diagnostics = Vec::new();
        for w in &warned.warnings {
            if let Some(d) = extract_single_diagnostic(&world, w) {
                all_diagnostics.push(d);
            }
        }

        match warned.output {
            Ok(document) => {
                let page_count = document.pages.len().max(1);
                let source_mapping = build_source_mapping(total_lines, page_count);

                let pages: Vec<String> = document
                    .pages
                    .iter()
                    .map(|page| typst_svg::svg(page))
                    .collect();

                TypstCompileResult {
                    pages,
                    diagnostics: all_diagnostics,
                    compile_time_ms: elapsed,
                    source_mapping,
                }
            }
            Err(errors) => {
                for e in &errors {
                    if let Some(d) = extract_single_diagnostic(&world, e) {
                        all_diagnostics.push(d);
                    }
                }
                TypstCompileResult {
                    pages: Vec::new(),
                    diagnostics: all_diagnostics,
                    compile_time_ms: elapsed,
                    source_mapping: Vec::new(),
                }
            }
        }
    })
    .await
    .map_err(|e| TypstError::CompileError(e.to_string()))?;

    Ok(result)
}

/// Compile a .typ file and write PDF to the specified output path.
#[tauri::command]
pub async fn compile_typst_to_pdf(
    source_path: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<(), TypstError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(TypstError::NoVault)?;

    // Validate source stays inside vault
    let _full =
        validate_inside_vault(vault, &source_path).map_err(|_| TypstError::AccessDenied)?;

    // Output path validation: ensure it's a .pdf extension to prevent misuse.
    // The output path comes from a native save dialog so the user explicitly chose it.
    if !output_path.to_lowercase().ends_with(".pdf") {
        return Err(TypstError::Io("Output path must have .pdf extension".into()));
    }

    let font_state = state.get_or_init_fonts();
    let vault_owned = vault.clone();
    let source_owned = source_path.clone();
    let output_owned = output_path.clone();

    tokio::task::spawn_blocking(move || {
        let world = OxideWorld::new(vault_owned, &source_owned, font_state);

        let warned = typst::compile::<typst::layout::PagedDocument>(&world);
        let document = warned.output.map_err(|errs| {
            let messages: Vec<String> = errs.iter().map(|e| e.message.to_string()).collect();
            TypstError::CompileError(messages.join("; "))
        })?;

        let pdf_options = typst_pdf::PdfOptions::default();
        let pdf_bytes = typst_pdf::pdf(&document, &pdf_options).map_err(|errs| {
            let messages: Vec<String> = errs.iter().map(|e| e.message.to_string()).collect();
            TypstError::CompileError(messages.join("; "))
        })?;

        std::fs::write(&output_owned, &pdf_bytes)
            .map_err(|e| TypstError::Io(e.to_string()))?;

        Ok::<(), TypstError>(())
    })
    .await
    .map_err(|e| TypstError::CompileError(e.to_string()))??;

    Ok(())
}

/// Maximum content size for inline Typst compilation (64 KB)
const MAX_INLINE_CONTENT_BYTES: usize = 64 * 1024;

/// Compile inline Typst content (e.g. from ```typst code blocks in Markdown)
/// and return SVG output. Does not require a file path — content is compiled
/// as a virtual in-memory document.
#[tauri::command]
pub async fn compile_typst_content(
    content: String,
    state: State<'_, AppState>,
) -> Result<TypstCompileResult, TypstError> {
    if content.len() > MAX_INLINE_CONTENT_BYTES {
        return Err(TypstError::CompileError(format!(
            "Inline content exceeds maximum size ({} bytes)",
            MAX_INLINE_CONTENT_BYTES
        )));
    }

    let font_state = state.get_or_init_fonts();

    // Vault root is required for resolving #import paths
    let vault_path = state.vault_path.read().clone();
    let root = vault_path.ok_or(TypstError::NoVault)?;

    tokio::task::spawn_blocking(move || {
        let start = Instant::now();

        // Create a virtual world with an in-memory main source
        let main_path = "__inline__.typ";
        let main_id = FileId::new(None, VirtualPath::new(main_path));
        let world = OxideWorld {
            root,
            main_id,
            library: LazyHash::new(Library::builder().build()),
            font_state,
            sources: Mutex::new(HashMap::from([(
                main_id,
                Source::new(main_id, content),
            )])),
            files: Mutex::new(HashMap::new()),
        };

        let warned = typst::compile::<typst::layout::PagedDocument>(&world);
        let elapsed = start.elapsed().as_millis() as u64;

        let mut all_diagnostics = Vec::new();
        for w in &warned.warnings {
            if let Some(d) = extract_single_diagnostic(&world, w) {
                all_diagnostics.push(d);
            }
        }

        match warned.output {
            Ok(document) => {
                let pages: Vec<String> = document
                    .pages
                    .iter()
                    .map(|page| typst_svg::svg(page))
                    .collect();
                TypstCompileResult {
                    pages,
                    diagnostics: all_diagnostics,
                    compile_time_ms: elapsed,
                    source_mapping: Vec::new(), // inline blocks don't need mapping
                }
            }
            Err(errors) => {
                for e in &errors {
                    if let Some(d) = extract_single_diagnostic(&world, e) {
                        all_diagnostics.push(d);
                    }
                }
                TypstCompileResult {
                    pages: Vec::new(),
                    diagnostics: all_diagnostics,
                    compile_time_ms: elapsed,
                    source_mapping: Vec::new(),
                }
            }
        }
    })
    .await
    .map_err(|e| TypstError::CompileError(e.to_string()))
}

/// Compile a .typ file and return only diagnostics (no SVG/PDF output).
/// Designed for agent tool usage where we only need error/warning feedback.
pub async fn compile_diagnostics_only(
    vault_path: PathBuf,
    rel_path: String,
    font_state: Arc<FontState>,
) -> Result<Vec<TypstDiagnostic>, TypstError> {
    tokio::task::spawn_blocking(move || {
        let world = OxideWorld::new(vault_path, &rel_path, font_state);
        let warned = typst::compile::<typst::layout::PagedDocument>(&world);

        let mut diagnostics = Vec::new();
        for w in &warned.warnings {
            if let Some(d) = extract_single_diagnostic(&world, w) {
                diagnostics.push(d);
            }
        }
        if let Err(errors) = &warned.output {
            for e in errors {
                if let Some(d) = extract_single_diagnostic(&world, e) {
                    diagnostics.push(d);
                }
            }
        }
        Ok(diagnostics)
    })
    .await
    .map_err(|e| TypstError::CompileError(e.to_string()))?
}

/// Build a heuristic source-line → page mapping.
/// Distributes source lines evenly across pages (1-based line numbers).
fn build_source_mapping(total_lines: usize, page_count: usize) -> Vec<(usize, usize)> {
    if page_count == 0 || total_lines == 0 {
        return Vec::new();
    }
    let lines_per_page = total_lines as f64 / page_count as f64;
    (0..page_count)
        .map(|i| {
            let start = (i as f64 * lines_per_page).floor() as usize + 1;
            let end = ((i + 1) as f64 * lines_per_page).ceil() as usize;
            (start, end.min(total_lines))
        })
        .collect()
}

/// Extract a single diagnostic from a SourceDiagnostic.
fn extract_single_diagnostic(
    world: &OxideWorld,
    diag: &typst::diag::SourceDiagnostic,
) -> Option<TypstDiagnostic> {
    let span = diag.span;
    let id = span.id()?;
    let source = world.source(id).ok()?;
    let range = source.range(span)?;
    let line = source.lines().byte_to_line(range.start)?;
    let column = source.lines().byte_to_column(range.start)?;
    let severity = match diag.severity {
        typst::diag::Severity::Error => "error",
        typst::diag::Severity::Warning => "warning",
    };
    Some(TypstDiagnostic {
        line: line + 1,
        column: column + 1,
        severity: severity.to_string(),
        message: diag.message.to_string(),
    })
}

// ── BibTeX parsing ──────────────────────────────────────────

/// A parsed BibTeX entry for citation autocomplete
#[derive(Debug, Clone, Serialize)]
pub struct BibEntry {
    /// Citation key (e.g. "knuth1984")
    pub key: String,
    /// Entry type (article, book, inproceedings, etc.)
    pub entry_type: String,
    /// Title of the work
    pub title: String,
    /// Author(s)
    pub author: String,
    /// Publication year
    pub year: String,
}

/// Scan the vault for .bib files and parse all citation entries.
/// Returns a flat list of BibEntry from all .bib files found.
#[tauri::command]
pub async fn list_bib_entries(
    state: State<'_, AppState>,
) -> Result<Vec<BibEntry>, TypstError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.ok_or(TypstError::NoVault)?;

    tokio::task::spawn_blocking(move || {
        let mut entries = Vec::new();

        // Walk vault directory for .bib files
        for entry in walkdir::WalkDir::new(&vault)
            .max_depth(10)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "bib") {
                if let Ok(content) = std::fs::read_to_string(path) {
                    parse_bib_entries(&content, &mut entries);
                }
            }
        }

        Ok(entries)
    })
    .await
    .map_err(|e| TypstError::CompileError(e.to_string()))?
}

/// Parse BibTeX entries from raw .bib file content.
/// Handles nested braces correctly (e.g. `title = {The {LaTeX} Companion}`).
fn parse_bib_entries(content: &str, out: &mut Vec<BibEntry>) {
    // Match @type{key, ... } blocks
    let entry_re = regex::Regex::new(
        r"(?i)@(\w+)\s*\{\s*([^,\s]+)\s*,"
    ).expect("valid regex");

    // Match field name before `=`, used to locate field starts
    let field_name_re = regex::Regex::new(
        r"(?i)\b(title|author|year)\s*="
    ).expect("valid regex");

    for entry_match in entry_re.find_iter(content) {
        let caps = match entry_re.captures(&content[entry_match.start()..]) {
            Some(c) => c,
            None => continue,
        };

        let entry_type = caps[1].to_lowercase();
        let key = caps[2].to_string();

        // Skip @comment, @preamble, @string pseudo-entries
        if matches!(entry_type.as_str(), "comment" | "preamble" | "string") {
            continue;
        }

        // Find the closing brace for this entry by counting brace depth
        let start = entry_match.start();
        let after_key = start + caps[0].len();
        let mut depth = 1i32;
        let mut end = after_key;
        for (i, ch) in content[after_key..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = after_key + i;
                        break;
                    }
                }
                _ => {}
            }
        }

        let body = &content[after_key..end];

        let mut title = String::new();
        let mut author = String::new();
        let mut year = String::new();

        for field_match in field_name_re.find_iter(body) {
            let fcaps = match field_name_re.captures(&body[field_match.start()..]) {
                Some(c) => c,
                None => continue,
            };
            let field_name = fcaps[1].to_lowercase();
            let after_eq = field_match.start() + fcaps[0].len();

            // Extract the field value using brace-depth counting or quote matching
            let value = extract_bib_field_value(&body[after_eq..]);

            match field_name.as_str() {
                "title" => title = value,
                "author" => author = value,
                "year" => year = value,
                _ => {}
            }
        }

        out.push(BibEntry {
            key,
            entry_type,
            title,
            author,
            year,
        });
    }
}

/// Extract a BibTeX field value from text after the `=` sign.
/// Handles {nested {braces}}, "quoted strings", and bare numbers.
fn extract_bib_field_value(text: &str) -> String {
    let trimmed = text.trim_start();

    if trimmed.starts_with('{') {
        // Brace-delimited: count depth to handle nesting
        let mut depth = 0i32;
        let mut start = 0;
        let mut end = 0;
        for (i, ch) in trimmed.char_indices() {
            match ch {
                '{' => {
                    if depth == 0 { start = i + 1; }
                    depth += 1;
                }
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        trimmed[start..end].trim().to_string()
    } else if trimmed.starts_with('"') {
        // Quote-delimited: find matching close quote
        let inner = &trimmed[1..];
        let close = inner.find('"').unwrap_or(inner.len());
        inner[..close].trim().to_string()
    } else {
        // Bare value (e.g. year = 2024) — take until comma/newline/brace
        let end = trimmed.find(|c: char| c == ',' || c == '}' || c == '\n')
            .unwrap_or(trimmed.len());
        trimmed[..end].trim().to_string()
    }
}

// ── LaTeX external compilation ──────────────────────────────

/// Whitelisted LaTeX compiler binaries (prevent arbitrary command execution)
const ALLOWED_LATEX_COMPILERS: &[&str] = &["pdflatex", "xelatex", "lualatex", "latexmk"];

#[derive(Debug, Clone, Serialize)]
pub struct LatexCompileResult {
    pub pdf_path: String,
    pub diagnostics: Vec<LatexDiagnostic>,
    pub log_output: String,
    pub compile_time_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LatexDiagnostic {
    pub line: Option<usize>,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedCompiler {
    pub name: String,
    pub path: String,
}

/// Detect available LaTeX compilers on the system via `which`.
#[tauri::command]
pub async fn detect_latex_compilers() -> Result<Vec<DetectedCompiler>, TypstError> {
    let mut found = Vec::new();
    for &name in ALLOWED_LATEX_COMPILERS {
        if let Ok(path) = which::which(name) {
            found.push(DetectedCompiler {
                name: name.to_string(),
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    Ok(found)
}

/// Compile a .tex file using an external LaTeX compiler.
/// Spawns the compiler in a subprocess, captures output, parses log for errors.
#[tauri::command]
pub async fn compile_latex(
    source_path: String,
    compiler: Option<String>,
    state: State<'_, AppState>,
) -> Result<LatexCompileResult, TypstError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(TypstError::NoVault)?;
    let full_path =
        validate_inside_vault(vault, &source_path).map_err(|_| TypstError::AccessDenied)?;

    // Resolve compiler: use provided, or auto-detect first available
    let compiler_name = compiler.unwrap_or_else(|| "xelatex".to_string());
    if !ALLOWED_LATEX_COMPILERS.contains(&compiler_name.as_str()) {
        return Err(TypstError::CompileError(format!(
            "Compiler '{}' is not allowed. Use one of: {}",
            compiler_name,
            ALLOWED_LATEX_COMPILERS.join(", ")
        )));
    }

    // Verify compiler exists
    let compiler_path = which::which(&compiler_name)
        .map_err(|_| TypstError::CompileError(format!(
            "Compiler '{}' not found in PATH. Please install a TeX distribution.",
            compiler_name
        )))?;

    let output_dir = full_path
        .parent()
        .ok_or_else(|| TypstError::Io("Cannot determine output directory".into()))?
        .to_path_buf();

    let start = std::time::Instant::now();

    // Spawn compiler process
    let output = tokio::process::Command::new(&compiler_path)
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        .arg("-no-shell-escape")
        .arg("-output-directory")
        .arg(&output_dir)
        .arg(&full_path)
        .current_dir(&output_dir)
        .output()
        .await
        .map_err(|e| TypstError::Io(format!("Failed to spawn {}: {}", compiler_name, e)))?;

    let elapsed = start.elapsed().as_millis() as u64;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined_log = format!("{}\n{}", stdout, stderr);

    // Parse diagnostics from log output
    let diagnostics = parse_latex_log(&combined_log);

    // Determine PDF output path (same name, .pdf extension)
    let pdf_name = full_path
        .file_stem()
        .map(|s| format!("{}.pdf", s.to_string_lossy()))
        .unwrap_or_default();
    let pdf_full_path = output_dir.join(&pdf_name);

    // Return relative path within vault
    let pdf_rel = pdf_full_path
        .strip_prefix(vault)
        .unwrap_or(&pdf_full_path)
        .to_string_lossy()
        .to_string();

    Ok(LatexCompileResult {
        pdf_path: pdf_rel,
        diagnostics,
        log_output: combined_log.chars().take(8000).collect(), // Truncate log
        compile_time_ms: elapsed,
    })
}

/// Parse LaTeX log output for error/warning lines.
/// Line numbers are extracted from `l.NNN` patterns appearing in lines
/// immediately following `! ` error markers.
fn parse_latex_log(log: &str) -> Vec<LatexDiagnostic> {
    use std::sync::LazyLock;
    static LINE_PATTERN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"l\.(\d+)").expect("valid regex"));

    let mut diagnostics = Vec::new();
    let lines: Vec<&str> = log.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("! ") {
            // Search forward in the next few lines for `l.NNN` line number
            let line_num = lines[i + 1..std::cmp::min(i + 5, lines.len())]
                .iter()
                .find_map(|subsequent| {
                    LINE_PATTERN
                        .captures(subsequent)
                        .and_then(|c| c[1].parse::<usize>().ok())
                });
            diagnostics.push(LatexDiagnostic {
                line: line_num,
                severity: "error".to_string(),
                message: trimmed.strip_prefix("! ").unwrap_or(trimmed).to_string(),
            });
        } else if trimmed.contains("LaTeX Warning:") {
            diagnostics.push(LatexDiagnostic {
                line: None,
                severity: "warning".to_string(),
                message: trimmed.to_string(),
            });
        }
    }
    diagnostics
}

// ── Template system ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DocumentTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    /// "typst" or "latex"
    pub format: String,
    /// "builtin" or "user"
    pub source: String,
    pub content: String,
}

/// Built-in templates (embedded at compile time)
fn builtin_templates() -> Vec<DocumentTemplate> {
    vec![
        DocumentTemplate {
            id: "typst-blank".into(),
            name: "Blank Document".into(),
            description: "Empty Typst document".into(),
            format: "typst".into(),
            source: "builtin".into(),
            content: "#set page(paper: \"a4\")\n#set text(font: \"New Computer Modern\", size: 11pt)\n\n".into(),
        },
        DocumentTemplate {
            id: "typst-paper".into(),
            name: "Academic Paper".into(),
            description: "IEEE-style academic paper".into(),
            format: "typst".into(),
            source: "builtin".into(),
            content: r#"#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1")

#align(center)[
  #text(size: 16pt, weight: "bold")[Paper Title]
  #v(0.5em)
  #text(size: 12pt)[Author Name]
  #v(0.3em)
  #text(size: 10pt, style: "italic")[Institution]
]

#v(1em)
*Abstract.* #lorem(80)

= Introduction
#lorem(100)

= Method
#lorem(100)

= Results
#lorem(80)

= Conclusion
#lorem(60)
"#.into(),
        },
        DocumentTemplate {
            id: "typst-slides".into(),
            name: "Presentation Slides".into(),
            description: "Simple slide deck".into(),
            format: "typst".into(),
            source: "builtin".into(),
            content: r#"#set page(paper: "presentation-16-9")
#set text(font: "New Computer Modern", size: 20pt)

#align(center + horizon)[
  #text(size: 36pt, weight: "bold")[Presentation Title]
  #v(1em)
  Author Name
  #v(0.5em)
  #text(size: 14pt)[#datetime.today().display()]
]

#pagebreak()
#heading[Introduction]
- Point one
- Point two
- Point three

#pagebreak()
#heading[Content]
#lorem(40)

#pagebreak()
#align(center + horizon)[
  #text(size: 28pt, weight: "bold")[Thank You]
]
"#.into(),
        },
        DocumentTemplate {
            id: "typst-letter".into(),
            name: "Letter".into(),
            description: "Formal letter".into(),
            format: "typst".into(),
            source: "builtin".into(),
            content: r#"#set page(paper: "a4", margin: (x: 2.5cm, y: 2cm))
#set text(font: "New Computer Modern", size: 11pt)

#align(right)[
  Your Name \
  Your Address \
  City, Postal Code \
  #datetime.today().display()
]

#v(2em)
Recipient Name \
Recipient Address \
City, Postal Code

#v(1.5em)
Dear Sir/Madam,

#v(0.5em)
#lorem(60)

#v(0.5em)
#lorem(40)

#v(1em)
Sincerely,

#v(2em)
_Your Name_
"#.into(),
        },
        DocumentTemplate {
            id: "typst-resume".into(),
            name: "Resume / CV".into(),
            description: "Clean resume layout".into(),
            format: "typst".into(),
            source: "builtin".into(),
            content: r#"#set page(paper: "a4", margin: (x: 2cm, y: 1.5cm))
#set text(font: "New Computer Modern", size: 10pt)

#align(center)[
  #text(size: 18pt, weight: "bold")[Your Name]
  #v(0.3em)
  email\@example.com · +1 234 567 890 · City, Country
]

#line(length: 100%)

== Education
*University Name* #h(1fr) 2020 -- 2024 \
B.Sc. in Computer Science

== Experience
*Company Name* — _Position_ #h(1fr) 2024 -- Present \
- Accomplishment one \
- Accomplishment two

== Skills
*Languages:* Rust, TypeScript, Python \
*Tools:* Git, Docker, Linux
"#.into(),
        },
        DocumentTemplate {
            id: "latex-blank".into(),
            name: "Blank Document".into(),
            description: "Empty LaTeX document".into(),
            format: "latex".into(),
            source: "builtin".into(),
            content: "\\documentclass[a4paper,11pt]{article}\n\\usepackage[utf8]{inputenc}\n\n\\begin{document}\n\n\n\\end{document}\n".into(),
        },
        DocumentTemplate {
            id: "latex-paper".into(),
            name: "Academic Paper".into(),
            description: "Article-class academic paper".into(),
            format: "latex".into(),
            source: "builtin".into(),
            content: r#"\documentclass[a4paper,11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Paper Title}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Abstract text goes here.
\end{abstract}

\section{Introduction}
Introduction text.

\section{Method}
Method description.

\section{Results}
Results.

\section{Conclusion}
Conclusion.

\bibliographystyle{plain}
\end{document}
"#.into(),
        },
        DocumentTemplate {
            id: "latex-slides".into(),
            name: "Presentation (Beamer)".into(),
            description: "Beamer slide deck".into(),
            format: "latex".into(),
            source: "builtin".into(),
            content: r#"\documentclass{beamer}
\usetheme{Madrid}
\usepackage[utf8]{inputenc}

\title{Presentation Title}
\author{Author Name}
\date{\today}

\begin{document}

\begin{frame}
\titlepage
\end{frame}

\begin{frame}{Introduction}
\begin{itemize}
  \item Point one
  \item Point two
  \item Point three
\end{itemize}
\end{frame}

\begin{frame}{Content}
Content goes here.
\end{frame}

\begin{frame}
\centering
\Huge Thank You
\end{frame}

\end{document}
"#.into(),
        },
    ]
}

/// List available document templates (builtin + user-defined).
#[tauri::command]
pub async fn list_templates(
    format: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentTemplate>, TypstError> {
    let mut templates = builtin_templates();

    // Load user templates from <vault>/.oxidenote/templates/
    let vault_path = state.vault_path.read().clone();
    if let Some(vault) = vault_path.as_ref() {
        let user_dir = vault.join(".oxidenote").join("templates");
        if user_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&user_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let fmt = match ext {
                        "typ" => "typst",
                        "tex" => "latex",
                        _ => continue,
                    };
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        let name = path.file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("Custom")
                            .to_string();
                        templates.push(DocumentTemplate {
                            id: format!("user-{}", name),
                            name: name.clone(),
                            description: "User template".into(),
                            format: fmt.into(),
                            source: "user".into(),
                            content,
                        });
                    }
                }
            }
        }
    }

    // Filter by format if specified
    if let Some(fmt) = format {
        templates.retain(|t| t.format == fmt);
    }

    Ok(templates)
}
