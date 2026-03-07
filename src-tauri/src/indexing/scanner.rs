use std::path::Path;

use rusqlite::Connection;
use walkdir::WalkDir;

use super::parser::parse_note;
use super::db;

/// Scan all markdown files in the vault and index them.
pub fn scan_vault(vault_path: &Path, conn: &Connection) -> Result<(), String> {
    let mut count: usize = 0;

    // Wrap in a single RAII transaction for performance and safety
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    for entry in WalkDir::new(vault_path)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Skip hidden dirs and .oxidenote
            !name.starts_with('.') && name != "node_modules"
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        // Only index .md files
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("md") {
            continue;
        }

        if let Err(e) = index_single_file(vault_path, path, &tx) {
            tracing::warn!("Failed to index {}: {}", path.display(), e);
        } else {
            count += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    tracing::info!("Indexed {} notes", count);
    Ok(())
}

/// Index a single file into the database.
pub fn index_single_file(
    vault_path: &Path,
    file_path: &Path,
    conn: &Connection,
) -> Result<(), String> {
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| e.to_string())?;

    let rel_path = file_path
        .strip_prefix(vault_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .to_string();

    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let parsed = parse_note(&content, &file_name);

    let modified_at = std::fs::metadata(file_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d %H:%M:%S").to_string()
        });

    db::upsert_note(
        conn,
        &rel_path,
        &parsed.title,
        &parsed.content,
        parsed.created_at.as_deref(),
        modified_at.as_deref(),
        parsed.frontmatter_json.as_deref(),
        &parsed.tags,
        &parsed.links,
    )
    .map_err(|e| e.to_string())
}

/// Remove a file from the index.
pub fn remove_from_index(
    vault_path: &Path,
    file_path: &Path,
    conn: &Connection,
) -> Result<(), String> {
    let rel_path = file_path
        .strip_prefix(vault_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .to_string();

    db::delete_note(conn, &rel_path).map_err(|e| e.to_string())
}
