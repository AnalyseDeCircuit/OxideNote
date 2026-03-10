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

use crate::commands::note::validate_inside_vault_public;
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
        validate_inside_vault_public(vault, &path).map_err(|_| TypstError::AccessDenied)?;

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

        // Collect warnings regardless of success/failure
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
        validate_inside_vault_public(vault, &source_path).map_err(|_| TypstError::AccessDenied)?;

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
