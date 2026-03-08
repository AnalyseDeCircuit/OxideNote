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

use serde::Serialize;
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
        // Only include non-markdown embeds (images, pdfs, etc.)
        if !name.ends_with(".md") {
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
