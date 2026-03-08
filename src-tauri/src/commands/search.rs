use serde::Serialize;
use tauri::State;

use crate::indexing::db;
use crate::state::AppState;

// ── 知识图谱数据结构 ────────────────────────────────────────

/// 图谱节点，对应一篇笔记
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
}

/// 图谱连边，表示一条 WikiLink 引用关系
#[derive(Debug, Clone, Serialize)]
pub struct GraphLink {
    pub source: String,
    pub target: String,
}

/// 完整的图谱数据（节点 + 连边）
#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("No vault opened")]
    NoVault,
    #[error("Index not available")]
    NoIndex,
    #[error("Search error: {0}")]
    Internal(String),
}

impl Serialize for SearchError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Full-text search across all indexed notes.
#[tauri::command]
pub async fn search_notes(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    // 使用读连接避免阻塞写操作
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::search_fts(conn, &query).map_err(|e| SearchError::Internal(e.to_string()))
}

/// Search notes by filename/title.
#[tauri::command]
pub async fn search_by_filename(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::search_by_filename(conn, &query).map_err(|e| SearchError::Internal(e.to_string()))
}

/// Get all notes that link to the specified note path.
/// Considers both direct path/stem matches and frontmatter aliases.
#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::BacklinkResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    // WikiLinks can reference either the full path or just the filename
    let file_stem = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(path.clone());

    // Try both the relative path and the stem
    let mut results = db::get_backlinks(conn, &path)
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    // 使用 HashSet 实现 O(1) 去重，避免 O(n²) 的 .any() 线性扫描
    let mut seen: std::collections::HashSet<String> =
        results.iter().map(|r| r.path.clone()).collect();

    if file_stem != path {
        let by_stem = db::get_backlinks(conn, &file_stem)
            .map_err(|e| SearchError::Internal(e.to_string()))?;
        for r in by_stem {
            if seen.insert(r.path.clone()) {
                results.push(r);
            }
        }
    }

    // Also find backlinks that target any of this note's aliases
    let alias_map = db::query_all_aliases(conn)
        .map_err(|e| SearchError::Internal(e.to_string()))?;
    let my_aliases: Vec<&String> = alias_map
        .iter()
        .filter(|(_, note_path)| *note_path == &path)
        .map(|(alias, _)| alias)
        .collect();
    for alias in my_aliases {
        let by_alias = db::get_backlinks(conn, alias)
            .map_err(|e| SearchError::Internal(e.to_string()))?;
        for r in by_alias {
            if seen.insert(r.path.clone()) {
                results.push(r);
            }
        }
    }

    Ok(results)
}

/// Re-index a single note (called after saves).
#[tauri::command]
pub async fn reindex_note(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), SearchError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(SearchError::NoVault)?;
    let file_path = vault.join(&path);

    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    if file_path.exists() {
        crate::indexing::scanner::index_single_file(vault, &file_path, conn)
            .map_err(SearchError::Internal)
    } else {
        crate::indexing::scanner::remove_from_index(vault, &file_path, conn)
            .map_err(SearchError::Internal)
    }
}

/// 获取知识图谱数据 — 所有笔记节点及其 WikiLink 连边
///
/// 从索引数据库中查询所有笔记和链接关系，
/// 构建前端 force-graph 所需的 { nodes, links } 数据结构。
/// 链接解析同时支持 path/stem 匹配和 frontmatter alias 匹配。
#[tauri::command]
pub async fn get_graph_data(
    state: State<'_, AppState>,
) -> Result<GraphData, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    // 查询所有笔记节点（含时间戳）
    let mut node_stmt = conn
        .prepare("SELECT path, title, created_at, modified_at FROM notes ORDER BY path")
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    let nodes: Vec<GraphNode> = node_stmt
        .query_map([], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                created_at: row.get(2)?,
                modified_at: row.get(3)?,
            })
        })
        .map_err(|e| SearchError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    // 构建路径集合，用于过滤有效连边
    let node_ids: std::collections::HashSet<&str> =
        nodes.iter().map(|n| n.id.as_str()).collect();

    // 构建 file_stem → path 映射，用于 O(1) WikiLink 解析
    let stem_to_path: std::collections::HashMap<String, &str> = nodes
        .iter()
        .filter_map(|n| {
            let stem = std::path::Path::new(&n.id)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())?;
            Some((stem, n.id.as_str()))
        })
        .collect();

    // 构建 alias → path 映射，用于 alias-aware 链接解析
    let alias_to_path = db::query_all_aliases(conn)
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    // 查询所有链接关系
    let mut link_stmt = conn
        .prepare(
            "SELECT n.path, l.target_path FROM links l
             JOIN notes n ON n.id = l.source_id",
        )
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    let links: Vec<GraphLink> = link_stmt
        .query_map([], |row| {
            Ok(GraphLink {
                source: row.get(0)?,
                target: row.get(1)?,
            })
        })
        .map_err(|e| SearchError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        // 仅保留两端都存在的连边，依次尝试 path → stem → alias 解析
        .filter_map(|mut link| {
            if !node_ids.contains(link.source.as_str()) {
                return None;
            }
            // 直接路径匹配
            if node_ids.contains(link.target.as_str()) {
                return Some(link);
            }
            // file_stem 匹配
            if let Some(&full_path) = stem_to_path.get(&link.target) {
                link.target = full_path.to_string();
                return Some(link);
            }
            // Alias 匹配
            if let Some(resolved) = alias_to_path.get(&link.target.to_lowercase()) {
                if node_ids.contains(resolved.as_str()) {
                    link.target = resolved.clone();
                    return Some(link);
                }
            }
            None
        })
        .collect();

    Ok(GraphData { nodes, links })
}

/// List all tags with note counts.
#[tauri::command]
pub async fn list_all_tags(
    state: State<'_, AppState>,
) -> Result<Vec<db::TagCount>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;
    db::list_all_tags(conn).map_err(|e| SearchError::Internal(e.to_string()))
}

/// Search notes by tag.
#[tauri::command]
pub async fn search_by_tag(
    tag: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;
    db::search_by_tag(conn, &tag).map_err(|e| SearchError::Internal(e.to_string()))
}

/// Return a random note from the vault index.
#[tauri::command]
pub async fn get_random_note(
    state: State<'_, AppState>,
) -> Result<Option<db::SearchResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;
    db::get_random_note(conn).map_err(|e| SearchError::Internal(e.to_string()))
}

/// A single task item extracted from vault notes.
#[derive(Debug, Clone, Serialize)]
pub struct TaskItem {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub done: bool,
}

/// Scan all vault .md files for task checkbox items (- [ ] / - [x]).
#[tauri::command]
pub async fn list_tasks(
    state: State<'_, AppState>,
) -> Result<Vec<TaskItem>, SearchError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(SearchError::NoVault)?;

    let mut tasks = Vec::new();
    collect_tasks(vault, vault, &mut tasks)?;
    Ok(tasks)
}

/// Recursively walk a directory and extract task items from .md files.
fn collect_tasks(
    root: &std::path::Path,
    dir: &std::path::Path,
    tasks: &mut Vec<TaskItem>,
) -> Result<(), SearchError> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        // Skip hidden directories like .oxidenote
        if path.file_name().map_or(false, |n| n.to_string_lossy().starts_with('.')) {
            continue;
        }
        if path.is_dir() {
            collect_tasks(root, &path, tasks)?;
        } else if path.extension().map_or(false, |ext| ext == "md") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                let rel_path = path.strip_prefix(root).unwrap_or(&path);
                let rel_str = rel_path.to_string_lossy().to_string();
                for (i, line) in content.lines().enumerate() {
                    let trimmed = line.trim();
                    if let Some(text) = trimmed.strip_prefix("- [ ] ") {
                        tasks.push(TaskItem {
                            path: rel_str.clone(),
                            line: i + 1,
                            text: text.to_string(),
                            done: false,
                        });
                    } else if let Some(text) = trimmed.strip_prefix("- [x] ").or_else(|| trimmed.strip_prefix("- [X] ")) {
                        tasks.push(TaskItem {
                            path: rel_str.clone(),
                            line: i + 1,
                            text: text.to_string(),
                            done: true,
                        });
                    }
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Block-level reference commands
// ============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct BlockResult {
    pub block_id: String,
    pub line_number: i64,
    pub content: String,
    pub block_type: String,
}

/// Get all blocks for a note (used for autocomplete).
#[tauri::command]
pub async fn get_note_blocks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<BlockResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    let blocks = db::get_note_blocks(conn, &path)
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    Ok(blocks
        .into_iter()
        .map(|b| BlockResult {
            block_id: b.block_id,
            line_number: b.line_number,
            content: b.content,
            block_type: b.block_type,
        })
        .collect())
}

/// Get content of a specific block (used for embedding).
#[tauri::command]
pub async fn get_block_content(
    note_path: String,
    block_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::get_block_content(conn, &note_path, &block_id)
        .map_err(|e| SearchError::Internal(e.to_string()))
}

/// Get backlinks to a specific block.
#[tauri::command]
pub async fn get_block_backlinks(
    note_path: String,
    block_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::get_block_backlinks(conn, &note_path, &block_id)
        .map_err(|e| SearchError::Internal(e.to_string()))
}
