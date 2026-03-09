//! Agent tools — 5 vault-scoped operations available to the LLM during agent execution.
//!
//! All tools validate paths via the vault boundary check before filesystem access.
//! Read-only tools acquire the read_db lock per call and release immediately.
//! `vault_write` buffers changes unless `auto_apply` is true.

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use similar::{ChangeTag, TextDiff};
use walkdir::WalkDir;

use super::types::{ChangeAction, ProposedChange};
use crate::indexing::{db, scanner};
use crate::llm::types::ToolCall;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("No index available")]
    NoIndex,
    #[error("Path outside vault: {0}")]
    AccessDenied(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Unknown tool: {0}")]
    UnknownTool(String),
    #[error("Missing argument: {0}")]
    MissingArg(String),
    #[error("Write limit exceeded")]
    WriteLimitExceeded,
}



// ── Tool dispatch ───────────────────────────────────────────

/// Execute a tool call, returning a text result for the LLM context.
///
/// - Read-only tools acquire the `read_db` lock per call and release immediately.
/// - `vault_write` buffers changes in `pending_writes` unless `auto_apply` is true.
/// - `max_writes` caps the number of write operations per agent run.
pub async fn execute_tool(
    tool_call: &ToolCall,
    vault_path: &Path,
    read_db: &Arc<Mutex<Option<Connection>>>,
    pending_writes: &Arc<Mutex<Vec<ProposedChange>>>,
    auto_apply: bool,
    db: &Arc<Mutex<Option<Connection>>>,
    max_writes: u8,
) -> Result<String, ToolError> {
    match tool_call.tool.as_str() {
        "vault_read" => tool_vault_read(tool_call, vault_path).await,
        "vault_search" => {
            let guard = read_db.lock();
            let conn = guard.as_ref().ok_or(ToolError::NoIndex)?;
            tool_vault_search(tool_call, conn)
        }
        "vault_list" => tool_vault_list(tool_call, vault_path),
        "vault_link" => {
            let guard = read_db.lock();
            let conn = guard.as_ref().ok_or(ToolError::NoIndex)?;
            tool_vault_link(tool_call, conn)
        }
        "vault_write" => {
            tool_vault_write(tool_call, vault_path, pending_writes, auto_apply, db, max_writes)
                .await
        }
        _ => Err(ToolError::UnknownTool(tool_call.tool.clone())),
    }
}

// ── vault_read ──────────────────────────────────────────────

/// Read a note's content by vault-relative path
async fn tool_vault_read(tool_call: &ToolCall, vault_path: &Path) -> Result<String, ToolError> {
    let rel_path = tool_call
        .args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::MissingArg("path".into()))?;

    let full_path = validate_path(vault_path, rel_path)?;

    let content = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    Ok(content)
}

// ── vault_search ────────────────────────────────────────────

/// Search notes by keyword using FTS5
fn tool_vault_search(tool_call: &ToolCall, conn: &Connection) -> Result<String, ToolError> {
    let query = tool_call
        .args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::MissingArg("query".into()))?;

    let limit = tool_call
        .args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize;

    let results =
        db::search_fts(conn, query).map_err(|e| ToolError::Io(e.to_string()))?;

    // Respect limit (FTS query returns up to 50 by default)
    let limited: Vec<_> = results.into_iter().take(limit).collect();

    // Format results as readable text for the LLM
    let mut output = format!("Found {} results for '{}':\n", limited.len(), query);
    for r in &limited {
        output.push_str(&format!("- [{}] {}: {}\n", r.path, r.title, r.snippet));
    }

    Ok(output)
}

// ── vault_list ──────────────────────────────────────────────

/// List notes and folders in the vault
fn tool_vault_list(tool_call: &ToolCall, vault_path: &Path) -> Result<String, ToolError> {
    let folder = tool_call
        .args
        .get("folder")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let recursive = tool_call
        .args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let target_dir = if folder.is_empty() {
        vault_path.to_path_buf()
    } else {
        let full = validate_path(vault_path, folder)?;
        full
    };

    if !target_dir.is_dir() {
        return Err(ToolError::Io(format!("Not a directory: {}", folder)));
    }

    let max_depth = if recursive { usize::MAX } else { 1 };

    let mut entries = Vec::new();
    for entry in WalkDir::new(&target_dir)
        .max_depth(max_depth)
        .min_depth(1)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|e| ToolError::Io(e.to_string()))?;
        let rel = entry
            .path()
            .strip_prefix(vault_path)
            .unwrap_or(entry.path());

        // Skip hidden files/directories
        if rel
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            continue;
        }

        let suffix = if entry.file_type().is_dir() { "/" } else { "" };
        entries.push(format!("{}{}", rel.display(), suffix));

        // Hard cap to prevent unbounded output
        if entries.len() >= 500 {
            break;
        }
    }

    let truncated = if entries.len() >= 500 {
        " (truncated at 500 entries)"
    } else {
        ""
    };
    let mut output = format!("Contents of '{}':\n", if folder.is_empty() { "/" } else { folder });
    for e in &entries {
        output.push_str(&format!("  {}\n", e));
    }
    output.push_str(&format!("Total: {} entries{}", entries.len(), truncated));

    Ok(output)
}

// ── vault_link ──────────────────────────────────────────────

/// Query backlinks and outlinks for a note
fn tool_vault_link(tool_call: &ToolCall, conn: &Connection) -> Result<String, ToolError> {
    let path = tool_call
        .args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::MissingArg("path".into()))?;

    let direction = tool_call
        .args
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("both");

    let mut output = format!("Links for '{}':\n", path);

    // Backlinks
    if direction == "backlinks" || direction == "both" {
        let backlinks =
            db::get_backlinks(conn, path).map_err(|e| ToolError::Io(e.to_string()))?;
        output.push_str(&format!("\nBacklinks ({}):\n", backlinks.len()));
        for bl in &backlinks {
            output.push_str(&format!("  ← [{}] {}\n", bl.path, bl.title));
        }
    }

    // Outlinks
    if direction == "outlinks" || direction == "both" {
        let outlinks =
            db::get_outlinks(conn, path).map_err(|e| ToolError::Io(e.to_string()))?;
        output.push_str(&format!("\nOutlinks ({}):\n", outlinks.len()));
        for ol in &outlinks {
            output.push_str(&format!("  → {}\n", ol));
        }
    }

    Ok(output)
}

// ── vault_write ─────────────────────────────────────────────

/// Write or modify a note. Buffers changes for approval unless `auto_apply` is true.
async fn tool_vault_write(
    tool_call: &ToolCall,
    vault_path: &Path,
    pending_writes: &Arc<Mutex<Vec<ProposedChange>>>,
    auto_apply: bool,
    db: &Arc<Mutex<Option<Connection>>>,
    max_writes: u8,
) -> Result<String, ToolError> {
    let rel_path = tool_call
        .args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::MissingArg("path".into()))?;

    let content = tool_call
        .args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::MissingArg("content".into()))?;

    let full_path = validate_path(vault_path, rel_path)?;

    // Enforce write limit
    {
        let writes = pending_writes.lock();
        if writes.len() >= max_writes as usize {
            return Err(ToolError::WriteLimitExceeded);
        }
    }

    // Read existing content (if file exists) to generate diff
    let existing = tokio::fs::read_to_string(&full_path).await.ok();

    let action = if existing.is_some() {
        ChangeAction::Modify
    } else {
        ChangeAction::Create
    };

    // Generate unified diff for review
    let diff = if let Some(ref old) = existing {
        let text_diff = TextDiff::from_lines(old.as_str(), content);
        let mut diff_output = String::new();
        for change in text_diff.iter_all_changes() {
            let sign = match change.tag() {
                ChangeTag::Delete => "-",
                ChangeTag::Insert => "+",
                ChangeTag::Equal => " ",
            };
            diff_output.push_str(&format!("{}{}", sign, change));
        }
        Some(diff_output)
    } else {
        None
    };

    let description = match action {
        ChangeAction::Create => format!("Create new note: {}", rel_path),
        _ => format!("Modify note: {}", rel_path),
    };

    let proposed = ProposedChange {
        path: rel_path.to_string(),
        action,
        content: Some(content.to_string()),
        diff,
        description: description.clone(),
    };

    if auto_apply {
        // Write to disk immediately
        if let Some(parent) = full_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError::Io(e.to_string()))?;
        }
        tokio::fs::write(&full_path, content)
            .await
            .map_err(|e| ToolError::Io(e.to_string()))?;

        // Reindex for immediate consistency
        let db_guard = db.lock();
        if let Some(conn) = db_guard.as_ref() {
            let _ = scanner::index_single_file(vault_path, &full_path, conn);
        }

        // Still record the change for the summary
        pending_writes.lock().push(proposed);

        Ok(format!("Written and indexed: {}", rel_path))
    } else {
        // Buffer for approval
        pending_writes.lock().push(proposed);
        Ok(format!("Buffered write to '{}' — pending approval", rel_path))
    }
}

// ── Path validation ─────────────────────────────────────────

/// Validate that a vault-relative path resolves within the vault boundary.
/// Prevents directory traversal attacks (e.g. `../../../etc/passwd`).
fn validate_path(vault_path: &Path, rel_path: &str) -> Result<std::path::PathBuf, ToolError> {
    let full_path = vault_path.join(rel_path);

    // For existing paths, use canonical comparison
    if full_path.exists() {
        let canonical_base = vault_path
            .canonicalize()
            .map_err(|e| ToolError::Io(e.to_string()))?;
        let canonical_target = full_path
            .canonicalize()
            .map_err(|e| ToolError::Io(e.to_string()))?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err(ToolError::AccessDenied(rel_path.into()));
        }
        Ok(canonical_target)
    } else {
        // For new paths, validate the parent directory
        let parent = full_path
            .parent()
            .ok_or_else(|| ToolError::Io("Invalid path".into()))?;

        // If parent doesn't exist yet, check the topmost existing ancestor
        let mut check = parent.to_path_buf();
        while !check.exists() {
            check = match check.parent() {
                Some(p) => p.to_path_buf(),
                None => return Err(ToolError::Io("Invalid path ancestry".into())),
            };
        }

        let canonical_base = vault_path
            .canonicalize()
            .map_err(|e| ToolError::Io(e.to_string()))?;
        let canonical_ancestor = check
            .canonicalize()
            .map_err(|e| ToolError::Io(e.to_string()))?;
        if !canonical_ancestor.starts_with(&canonical_base) {
            return Err(ToolError::AccessDenied(rel_path.into()));
        }
        Ok(full_path)
    }
}
