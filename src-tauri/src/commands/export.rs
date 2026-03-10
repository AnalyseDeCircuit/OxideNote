/**
 * Export module — bundle export (markdown + referenced attachments → zip).
 *
 * Scans the note content for image/file references (Markdown ![](path) and WikiLink ![[file]]),
 * resolves them relative to the vault, and packages everything into a zip archive.
 */

use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::state::AppState;
use super::util::{validate_path_inside_vault, PathValidationError};

// Precompiled regex patterns for attachment extraction (compiled once, reused)
static RE_MD_IMG: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"!\[(?:[^\]]*)\]\(([^)]+)\)").unwrap());
static RE_WIKI_EMBED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"!\[\[([^\]]+)\]\]").unwrap());

// Matches <img ... src="..." ...> in rendered HTML for image inlining.
// Uses a word boundary ((?-u:\b)) before src to avoid matching data-src or similar.
static RE_IMG_SRC: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"<img\s[^>]*(?-u:\b)src="([^"]+)"[^>]*>"#).unwrap());

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("No vault opened")]
    NoVault,
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Zip error: {0}")]
    Zip(String),
}

impl Serialize for ExportError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<PathValidationError> for ExportError {
    fn from(e: PathValidationError) -> Self {
        match e {
            PathValidationError::AccessDenied => ExportError::AccessDenied,
            PathValidationError::Io(msg) => ExportError::Io(msg),
        }
    }
}

/// Extract attachment paths referenced in Markdown content.
/// Matches: ![alt](path), ![[wikilink]]
fn extract_attachments(content: &str) -> Vec<String> {
    let mut paths = Vec::new();

    // Standard Markdown images: ![...](path)
    for cap in RE_MD_IMG.captures_iter(content) {
        let p = cap[1].trim();
        // Skip external URLs
        if !p.starts_with("http://") && !p.starts_with("https://") && !p.starts_with("data:") {
            paths.push(p.to_string());
        }
    }

    // WikiLink embeds: ![[filename]]
    for cap in RE_WIKI_EMBED.captures_iter(content) {
        let name = cap[1].trim();
        // Only include non-note embeds (images, pdfs, etc.)
        if !crate::commands::util::is_supported_note_file(name) {
            paths.push(name.to_string());
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

/// Find the actual file path for an attachment reference.
/// Checks relative to the note's directory, then vault root, then searches vault-wide.
fn resolve_attachment(vault: &Path, note_dir: &Path, reference: &str) -> Option<PathBuf> {
    // Try relative to note directory
    let relative = note_dir.join(reference);
    if relative.is_file() {
        return Some(relative);
    }

    // Try relative to vault root
    let from_root = vault.join(reference);
    if from_root.is_file() {
        return Some(from_root);
    }

    // Search by filename in vault (for WikiLink style references)
    let target_name = Path::new(reference)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase());

    if let Some(target) = target_name {
        for entry in walkdir::WalkDir::new(vault)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.to_lowercase() == target {
                        return Some(entry.path().to_path_buf());
                    }
                }
            }
        }
    }

    None
}

/// Export a note with its attachments as a zip archive.
#[tauri::command]
pub async fn export_note_bundle(
    path: String,
    save_path: String,
    state: State<'_, AppState>,
) -> Result<(), ExportError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(ExportError::NoVault)?;
    let note_path = validate_path_inside_vault(vault, &path)?;

    // Read note content
    let content = fs::read_to_string(&note_path)
        .map_err(|e| ExportError::Io(e.to_string()))?;

    let note_dir = note_path.parent().unwrap_or(vault);
    let note_filename = note_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".to_string());

    // Extract and resolve attachment paths
    let attachment_refs = extract_attachments(&content);
    let mut resolved: Vec<(String, PathBuf)> = Vec::new();
    // Track used names to handle collisions (e.g. images/cat.png and backup/cat.png)
    let mut name_counts: HashMap<String, usize> = HashMap::new();

    for r in &attachment_refs {
        if let Some(real_path) = resolve_attachment(vault, note_dir, r) {
            // Validate it's inside vault for security
            if let Ok(canonical) = real_path.canonicalize() {
                if let Ok(canonical_base) = vault.canonicalize() {
                    if canonical.starts_with(&canonical_base) {
                        let base_name = real_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| r.clone());

                        // Deduplicate filenames: append _1, _2, etc. on collision
                        let count = name_counts.entry(base_name.clone()).or_insert(0);
                        let final_name = if *count == 0 {
                            base_name.clone()
                        } else {
                            let stem = Path::new(&base_name).file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_else(|| base_name.clone());
                            let ext = Path::new(&base_name).extension()
                                .map(|e| format!(".{}", e.to_string_lossy()))
                                .unwrap_or_default();
                            format!("{}_{}{}", stem, count, ext)
                        };
                        *count += 1;

                        resolved.push((final_name, real_path));
                    }
                }
            }
        }
    }

    // Build zip in memory
    let buf = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // Add note file
    zip.start_file(&note_filename, options)
        .map_err(|e| ExportError::Zip(e.to_string()))?;
    zip.write_all(content.as_bytes())
        .map_err(|e| ExportError::Zip(e.to_string()))?;

    // Add attachments into "attachments/" subdirectory
    for (name, file_path) in &resolved {
        let zip_path = format!("attachments/{}", name);
        zip.start_file(&zip_path, options)
            .map_err(|e| ExportError::Zip(e.to_string()))?;
        let data = fs::read(file_path)
            .map_err(|e| ExportError::Io(e.to_string()))?;
        zip.write_all(&data)
            .map_err(|e| ExportError::Zip(e.to_string()))?;
    }

    let result = zip.finish().map_err(|e| ExportError::Zip(e.to_string()))?;
    let bytes = result.into_inner();

    // Write to file
    fs::write(&save_path, &bytes)
        .map_err(|e| ExportError::Io(e.to_string()))?;

    Ok(())
}

// ── Static site publishing ──────────────────────────────────

/// A single page in the static site (rendered by frontend, written by backend).
#[derive(Debug, Deserialize)]
pub struct SitePage {
    /// Relative path for the output file (e.g. "notes/hello.html")
    pub path: String,
    /// Rendered HTML content
    pub html: String,
}

/// Publish a set of pre-rendered HTML pages to an output directory.
/// The frontend renders markdown → HTML; this command handles file writes.
#[tauri::command]
pub async fn publish_static_site(
    output_dir: String,
    pages: Vec<SitePage>,
    index_html: String,
) -> Result<usize, ExportError> {
    let output = PathBuf::from(&output_dir);

    // Ensure output directory exists
    fs::create_dir_all(&output)
        .map_err(|e| ExportError::Io(e.to_string()))?;

    // Write index.html
    fs::write(output.join("index.html"), &index_html)
        .map_err(|e| ExportError::Io(e.to_string()))?;

    let mut count = 0;
    for page in &pages {
        // Sanitize path: prevent directory traversal
        let rel = Path::new(&page.path);
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }

        let target = output.join(rel);

        // Create parent directories if needed
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| ExportError::Io(e.to_string()))?;
        }

        fs::write(&target, &page.html)
            .map_err(|e| ExportError::Io(e.to_string()))?;
        count += 1;
    }

    Ok(count)
}

// ── Print via system browser ────────────────────────────────

/// Guess MIME type from file extension for data URI embedding.
fn mime_for_extension(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Replace local image references in HTML with inline base64 data URIs.
///
/// Scans for `<img src="...">` tags where src is a local (non-URL) path,
/// resolves the file relative to the vault (note dir → vault root → vault-wide search),
/// reads the file, and replaces the src with `data:{mime};base64,{data}`.
fn inline_images(html: &str, vault: &Path, note_dir: &Path) -> String {
    use base64::Engine;

    let mut result = html.to_string();
    // Collect matches first to avoid borrow issues during replacement
    let matches: Vec<(String, String)> = RE_IMG_SRC
        .captures_iter(html)
        .filter_map(|cap| {
            let full_match = cap[0].to_string();
            let src = cap[1].to_string();
            // Skip external URLs and data URIs
            if src.starts_with("http://")
                || src.starts_with("https://")
                || src.starts_with("data:")
            {
                return None;
            }
            Some((full_match, src))
        })
        .collect();

    for (full_tag, src) in matches {
        // Decode percent-encoded characters in the path
        let decoded_src = percent_decode_path(&src);
        if let Some(file_path) = resolve_attachment(vault, note_dir, &decoded_src) {
            // Verify the file is inside the vault for security
            if let (Ok(canonical), Ok(canonical_base)) =
                (file_path.canonicalize(), vault.canonicalize())
            {
                if canonical.starts_with(&canonical_base) {
                    if let Ok(bytes) = fs::read(&file_path) {
                        let ext = file_path
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("png");
                        let mime = mime_for_extension(ext);
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let data_uri = format!("data:{};base64,{}", mime, b64);
                        // Replace only the src="..." attribute to avoid corrupting
                        // other attributes (e.g. alt) that may contain the same value
                        let old_attr = format!("src=\"{}\"", src);
                        let new_attr = format!("src=\"{}\"", data_uri);
                        let new_tag = full_tag.replacen(&old_attr, &new_attr, 1);
                        result = result.replacen(&full_tag, &new_tag, 1);
                    }
                }
            }
        }
    }

    result
}

/// Percent-decode a path string, correctly handling multi-byte UTF-8 sequences.
/// E.g. "%E4%B8%AD" → "中", "%20" → " "
fn percent_decode_path(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut iter = input.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let hi = iter.next();
            let lo = iter.next();
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    if let (Some(hv), Some(lv)) = (hex_val(h), hex_val(l)) {
                        bytes.push(hv << 4 | lv);
                    } else {
                        // Invalid hex digits — preserve all three bytes as-is
                        bytes.push(b'%');
                        bytes.push(h);
                        bytes.push(l);
                    }
                }
                (Some(h), None) => {
                    // Truncated at end — preserve consumed bytes
                    bytes.push(b'%');
                    bytes.push(h);
                }
                _ => {
                    bytes.push(b'%');
                }
            }
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Write rendered HTML to a temp file and open it in the system browser.
///
/// Local image references (relative paths in `<img src="...">`) are resolved
/// against the vault and inlined as base64 data URIs so images display correctly
/// when the HTML is opened from the temp directory.
///
/// The auto-print script is injected before `</body>` so the browser triggers
/// the native print dialog on load.
///
/// **Security note**: The caller (frontend) must sanitize the HTML content
/// with DOMPurify before invoking this command.
///
/// Old temp files (oxidenote-print-*.html) are cleaned up on each call.
#[tauri::command]
pub async fn print_html(
    html_content: String,
    note_path: String,
    state: State<'_, AppState>,
) -> Result<(), ExportError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(ExportError::NoVault)?;

    // Determine note directory for resolving relative image paths
    let note_full = vault.join(&note_path);
    let note_dir = note_full.parent().unwrap_or(vault);

    // Inline local images as base64 data URIs
    let html_with_images = inline_images(&html_content, vault, note_dir);

    let temp_dir = std::env::temp_dir();

    // Clean up previous print temp files to avoid accumulation
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("oxidenote-print-") && name.ends_with(".html") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    let timestamp = chrono::Utc::now().timestamp_millis();
    let filename = format!("oxidenote-print-{}.html", timestamp);
    let temp_path = temp_dir.join(&filename);

    // Inject an auto-print script that triggers the browser's print dialog.
    // Use replacen to only replace the first occurrence of </body>.
    let printable_html = if html_with_images.contains("</body>") {
        html_with_images.replacen(
            "</body>",
            "<script>window.addEventListener('load',function(){window.print()});</script></body>",
            1,
        )
    } else {
        format!(
            "{}<script>window.addEventListener('load',function(){{window.print()}});</script>",
            html_with_images
        )
    };

    std::fs::write(&temp_path, &printable_html)
        .map_err(|e| ExportError::Io(e.to_string()))?;

    // Open the temp file in the system default browser
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&temp_path)
            .spawn()
            .map_err(|e| ExportError::Io(e.to_string()))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &temp_path.display().to_string()])
            .spawn()
            .map_err(|e| ExportError::Io(e.to_string()))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&temp_path)
            .spawn()
            .map_err(|e| ExportError::Io(e.to_string()))?;
    }

    Ok(())
}
