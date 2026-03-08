use std::path::Path;

use serde::Serialize;
use tauri::State;
use walkdir::WalkDir;

use crate::indexing::{db, scanner};
use crate::state::AppState;

#[derive(Debug, thiserror::Error)]
pub enum HealthError {
    #[error("No vault opened")]
    NoVault,
    #[error("No index available")]
    NoIndex,
    #[error("IO error: {0}")]
    #[allow(dead_code)] // 保留用于未来可能的文件系统错误场景
    Io(String),
    #[error("DB error: {0}")]
    Db(String),
}

impl Serialize for HealthError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Summary of a vault health check.
#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    /// Files on disk but missing from the index.
    pub unindexed_files: Vec<String>,
    /// Indexed paths whose files no longer exist on disk.
    pub orphaned_entries: Vec<String>,
    /// WikiLinks that point to non-existent notes.
    pub broken_links: Vec<BrokenLink>,
    /// Total notes on disk.
    pub total_files: usize,
    /// Total notes in index.
    pub total_indexed: usize,
    /// Whether the FTS table row count matches the notes table.
    pub fts_consistent: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrokenLink {
    /// The note containing the broken link.
    pub source: String,
    /// The target path that doesn't resolve to any note.
    pub target: String,
}

/// Run a read-only health check on the vault index.
/// Uses the read connection to avoid blocking write operations.
#[tauri::command]
pub async fn vault_health_check(
    state: State<'_, AppState>,
) -> Result<HealthReport, HealthError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(HealthError::NoVault)?;
    let disk_files = collect_disk_files(base);

    // 使用读连接
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(HealthError::NoIndex)?;

    build_health_report(conn, &disk_files)
}

/// Repair the vault index: remove orphans, index missing files, rebuild FTS if inconsistent.
/// All repair operations are wrapped in a single transaction to avoid nested tx issues.
#[tauri::command]
pub async fn repair_vault(
    state: State<'_, AppState>,
) -> Result<HealthReport, HealthError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(HealthError::NoVault)?.clone();
    drop(vault_path);

    let disk_files = collect_disk_files(&base);

    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(HealthError::NoIndex)?;

    // 先在写连接上获取当前状态
    let report = build_health_report(conn, &disk_files)?;

    // 所有修复操作包在一个事务中，使用 raw 版本避免嵌套事务
    let tx = conn.unchecked_transaction()
        .map_err(|e| HealthError::Db(e.to_string()))?;

    // 删除孤立索引条目
    for path in &report.orphaned_entries {
        db::delete_note_raw(&tx, path)
            .map_err(|e| HealthError::Db(e.to_string()))?;
    }

    // 索引未收录的文件
    for rel_path in &report.unindexed_files {
        let full_path = base.join(rel_path);
        if let Err(e) = scanner::index_single_file_raw(&base, &full_path, &tx) {
            tracing::warn!("Repair: failed to index {}: {}", rel_path, e);
        }
    }

    // FTS 不一致时重建 — 清除后在同一事务内重新扫描
    if !report.fts_consistent {
        tx.execute_batch("DELETE FROM notes_fts")
            .map_err(|e| HealthError::Db(e.to_string()))?;
        if let Err(e) = scanner::scan_vault_raw(&base, &tx) {
            tracing::warn!("FTS rebuild scan failed: {}", e);
        }
    }

    tx.commit().map_err(|e| HealthError::Db(e.to_string()))?;

    // 修复完成后返回最新报告
    let fresh_disk = collect_disk_files(&base);
    build_health_report(conn, &fresh_disk)
}

/// Collect all .md files on disk as vault-relative paths.
fn collect_disk_files(base: &Path) -> std::collections::HashSet<String> {
    let mut disk_files = std::collections::HashSet::new();
    for entry in WalkDir::new(base)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        disk_files.insert(rel);
    }
    disk_files
}

/// Build a health report from a database connection and the set of on-disk files.
fn build_health_report(
    conn: &rusqlite::Connection,
    disk_files: &std::collections::HashSet<String>,
) -> Result<HealthReport, HealthError> {
    // Collect all indexed paths
    let mut indexed_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT path FROM notes")
            .map_err(|e| HealthError::Db(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| HealthError::Db(e.to_string()))?;
        for row in rows {
            if let Ok(p) = row {
                indexed_paths.insert(p);
            }
        }
    }

    let unindexed_files: Vec<String> = disk_files
        .difference(&indexed_paths)
        .cloned()
        .collect();

    let orphaned_entries: Vec<String> = indexed_paths
        .difference(disk_files)
        .cloned()
        .collect();

    let broken_links = find_broken_links(conn, disk_files)
        .map_err(|e| HealthError::Db(e.to_string()))?;

    let notes_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| HealthError::Db(e.to_string()))?;
    let fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes_fts", [], |row| row.get(0))
        .map_err(|e| HealthError::Db(e.to_string()))?;

    Ok(HealthReport {
        total_files: disk_files.len(),
        total_indexed: indexed_paths.len(),
        unindexed_files,
        orphaned_entries,
        broken_links,
        fts_consistent: notes_count == fts_count,
    })
}

/// Check whether a link target resolves to any note.
/// Considers full path match, filename stem match, and frontmatter aliases.
fn find_broken_links(
    conn: &rusqlite::Connection,
    disk_files: &std::collections::HashSet<String>,
) -> Result<Vec<BrokenLink>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.path, l.target_path FROM links l JOIN notes n ON n.id = l.source_id"
    )?;

    // Build a set of filename stems for WikiLink resolution
    let stems: std::collections::HashSet<String> = disk_files
        .iter()
        .filter_map(|p| {
            std::path::Path::new(p)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
        })
        .collect();

    // Build alias set for resolution (lowercase alias → exists)
    let alias_map = db::query_all_aliases(conn).unwrap_or_default();

    let results = stmt
        .query_map([], |row| {
            let source: String = row.get(0)?;
            let target: String = row.get(1)?;
            Ok((source, target))
        })?
        .filter_map(|r| r.ok())
        .filter(|(_, target)| {
            let target_lower = target.to_lowercase();

            // 1. Full path match
            if disk_files.iter().any(|p| p.to_lowercase() == target_lower) {
                return false;
            }
            // 2. Filename stem match
            let stem = std::path::Path::new(target)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| target_lower.clone());
            if stems.contains(&stem) {
                return false;
            }
            // 3. Alias match — link target resolves to a note via its alias
            if alias_map.contains_key(&target_lower) {
                return false;
            }
            true
        })
        .map(|(source, target)| BrokenLink { source, target })
        .collect();

    Ok(results)
}
