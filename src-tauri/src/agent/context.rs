//! Agent context building — assembles vault information for the LLM prompt.

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use walkdir::WalkDir;

use super::types::AgentTask;
use crate::indexing::db;

/// Assembled vault context for the agent's system prompt
#[derive(Debug, Clone)]
pub struct AgentContext {
    /// Summary: note count, tag cloud, folder structure
    pub vault_summary: String,
    /// Relevant note excerpts (based on scope)
    pub relevant_notes: String,
}

/// Build context about the vault for the agent's system prompt.
/// Budget allocation:
/// - 40% vault summary (file list, stats, tag cloud)
/// - 30% relevant notes (scoped by task)
/// - 30% reserved for task-specific context + tool results
pub async fn build_agent_context(
    task: &AgentTask,
    vault_path: &Path,
    read_db: &Arc<Mutex<Option<Connection>>>,
) -> Result<AgentContext, String> {
    // Vault summary: file count, folder structure, top tags
    let vault_summary = build_vault_summary(vault_path, read_db)?;

    // Relevant notes based on scope
    let relevant_notes = build_relevant_notes(task, vault_path, read_db).await?;

    Ok(AgentContext {
        vault_summary,
        relevant_notes,
    })
}

/// Build a text summary of the vault structure and metadata
fn build_vault_summary(
    vault_path: &Path,
    read_db: &Arc<Mutex<Option<Connection>>>,
) -> Result<String, String> {
    let mut summary = String::new();

    // Count notes
    let mut note_count = 0usize;
    let mut folders = Vec::new();
    for entry in WalkDir::new(vault_path)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            !e.file_name()
                .to_string_lossy()
                .starts_with('.')
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file()
            && entry.path().extension().and_then(|e| e.to_str()).map_or(false, |ext| crate::commands::util::is_supported_extension(ext))
        {
            note_count += 1;
        } else if entry.file_type().is_dir() {
            let rel = entry
                .path()
                .strip_prefix(vault_path)
                .unwrap_or(entry.path());
            folders.push(rel.display().to_string());
        }
    }

    summary.push_str(&format!("Vault: {} notes", note_count));
    if !folders.is_empty() {
        let display_folders: Vec<&str> = folders.iter().take(20).map(|s| s.as_str()).collect();
        summary.push_str(&format!(
            "\nFolders: {}{}",
            display_folders.join(", "),
            if folders.len() > 20 {
                format!(" (+{} more)", folders.len() - 20)
            } else {
                String::new()
            }
        ));
    }

    // Top tags
    let guard = read_db.lock();
    if let Some(conn) = guard.as_ref() {
        if let Ok(tags) = db::list_all_tags(conn) {
            let top_tags: Vec<String> = tags.iter().take(15).map(|t| {
                format!("#{} ({})", t.tag, t.count)
            }).collect();
            if !top_tags.is_empty() {
                summary.push_str(&format!("\nTop tags: {}", top_tags.join(", ")));
            }
        }
    }

    Ok(summary)
}

/// Build relevant note excerpts based on the task scope
async fn build_relevant_notes(
    task: &AgentTask,
    vault_path: &Path,
    read_db: &Arc<Mutex<Option<Connection>>>,
) -> Result<String, String> {
    let mut notes_text = String::new();

    match task.scope.as_deref() {
        // Single note scope — validate path and cap content size
        Some(path) if !path.is_empty() && !path.ends_with('/') => {
            let full_path = vault_path.join(path);
            validate_scope_path(&full_path, vault_path)?;
            if full_path.is_file() {
                let content = tokio::fs::read_to_string(&full_path)
                    .await
                    .map_err(|e| e.to_string())?;
                // Cap single-note content to avoid token budget overflow
                let truncated = truncate_content(&content, 8000);
                notes_text.push_str(&format!("=== {} ===\n{}\n", path, truncated));
            }
        }
        // Folder scope — validate path
        Some(folder) if !folder.is_empty() => {
            let folder_path = vault_path.join(folder.trim_end_matches('/'));
            validate_scope_path(&folder_path, vault_path)?;
            if folder_path.is_dir() {
                let mut count = 0;
                for entry in WalkDir::new(&folder_path)
                    .min_depth(1)
                    .max_depth(2)
                    .into_iter()
                    .filter_entry(|e| {
                        !e.file_name()
                            .to_string_lossy()
                            .starts_with('.')
                    })
                {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entry.file_type().is_file()
                        && entry.path().extension().and_then(|e| e.to_str()).map_or(false, |ext| crate::commands::util::is_supported_extension(ext))
                    {
                        let rel = entry
                            .path()
                            .strip_prefix(vault_path)
                            .unwrap_or(entry.path());
                        let content = tokio::fs::read_to_string(entry.path())
                            .await
                            .unwrap_or_default();
                        // Truncate to 2000 chars per note for context budget
                        let truncated = if content.len() > 2000 {
                            let boundary = content.floor_char_boundary(2000);
                            format!("{}...", &content[..boundary])
                        } else {
                            content
                        };
                        notes_text.push_str(&format!(
                            "=== {} ===\n{}\n\n",
                            rel.display(),
                            truncated
                        ));
                        count += 1;
                        if count >= 20 {
                            notes_text.push_str("(truncated: more notes in folder)\n");
                            break;
                        }
                    }
                }
            }
        }
        // Entire vault — provide metadata listing only (too large for full content)
        _ => {
            let guard = read_db.lock();
            if let Some(conn) = guard.as_ref() {
                // List note paths, titles, and modification dates
                let mut stmt = conn
                    .prepare(
                        "SELECT path, title, modified_at FROM notes \
                         ORDER BY modified_at DESC LIMIT 50",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        ))
                    })
                    .map_err(|e| e.to_string())?;

                notes_text.push_str("Recent notes (sorted by modification date):\n");
                for row in rows {
                    if let Ok((path, title, modified)) = row {
                        // Show date portion for time-aware tasks like DailyReview
                        if modified.is_empty() {
                            notes_text.push_str(&format!(
                                "  - {} ({})\n",
                                title, path
                            ));
                        } else {
                            let date_display = if modified.len() >= 10 {
                                &modified[..10]
                            } else {
                                &modified
                            };
                            notes_text.push_str(&format!(
                                "  - {} ({}) [modified: {}]\n",
                                title, path, date_display
                            ));
                        }
                    }
                }
            }
        }
    }

    Ok(notes_text)
}

/// Validate that a scope-derived path is within the vault boundary.
/// Prevents path traversal via malicious scope values.
fn validate_scope_path(path: &Path, vault_path: &Path) -> Result<(), String> {
    let canonical_base = vault_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve vault path: {}", e))?;

    if path.exists() {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve scope path: {}", e))?;
        if !canonical.starts_with(&canonical_base) {
            return Err("Scope path is outside the vault boundary".into());
        }
    } else {
        // For non-existent paths, walk up to the topmost existing ancestor
        let mut ancestor = path.to_path_buf();
        while !ancestor.exists() {
            if let Some(parent) = ancestor.parent() {
                ancestor = parent.to_path_buf();
            } else {
                return Err("Scope path has no valid ancestor".into());
            }
        }
        let canonical_ancestor = ancestor
            .canonicalize()
            .map_err(|e| format!("Cannot resolve ancestor: {}", e))?;
        if !canonical_ancestor.starts_with(&canonical_base) {
            return Err("Scope path is outside the vault boundary".into());
        }
    }
    Ok(())
}

/// Truncate content to a maximum character count at a word boundary
fn truncate_content(content: &str, max_chars: usize) -> &str {
    if content.len() <= max_chars {
        return content;
    }
    // Find a safe boundary (avoid splitting multi-byte chars)
    match content.char_indices().nth(max_chars) {
        Some((idx, _)) => &content[..idx],
        None => content,
    }
}
