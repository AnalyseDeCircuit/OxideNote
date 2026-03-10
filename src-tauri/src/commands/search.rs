use std::sync::LazyLock;

use serde::Serialize;
use tauri::State;

use crate::indexing::db;
use crate::state::AppState;

// ── 知识图谱数据结构 ────────────────────────────────────────

/// Graph node representing a note or block
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    /// When true, this node represents a block rather than a note
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_block: Option<bool>,
}

/// Graph edge representing a WikiLink or block reference
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

/// Build the knowledge graph: note nodes + WikiLink edges.
/// When `include_blocks` is true, also includes block nodes and block reference edges.
#[tauri::command]
pub async fn get_graph_data(
    include_blocks: Option<bool>,
    state: State<'_, AppState>,
) -> Result<GraphData, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    // 查询所有笔记节点（含时间戳）
    let mut node_stmt = conn
        .prepare("SELECT path, title, created_at, modified_at FROM notes ORDER BY path")
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    let mut nodes: Vec<GraphNode> = node_stmt
        .query_map([], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                created_at: row.get(2)?,
                modified_at: row.get(3)?,
                is_block: None,
            })
        })
        .map_err(|e| SearchError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    // Path set for filtering valid edges
    let node_ids: std::collections::HashSet<&str> =
        nodes.iter().map(|n| n.id.as_str()).collect();

    // file_stem → path map for O(1) WikiLink resolution
    let stem_to_path: std::collections::HashMap<String, &str> = nodes
        .iter()
        .filter_map(|n| {
            let stem = std::path::Path::new(&n.id)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())?;
            Some((stem, n.id.as_str()))
        })
        .collect();

    // alias → path map for alias-aware link resolution
    let alias_to_path = db::query_all_aliases(conn)
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    // Query all note-level links
    let mut link_stmt = conn
        .prepare(
            "SELECT n.path, l.target_path FROM links l
             JOIN notes n ON n.id = l.source_id",
        )
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    let mut links: Vec<GraphLink> = link_stmt
        .query_map([], |row| {
            Ok(GraphLink {
                source: row.get(0)?,
                target: row.get(1)?,
            })
        })
        .map_err(|e| SearchError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        // Keep only edges where both endpoints exist (path → stem → alias)
        .filter_map(|mut link| {
            if !node_ids.contains(link.source.as_str()) {
                return None;
            }
            if node_ids.contains(link.target.as_str()) {
                return Some(link);
            }
            if let Some(&full_path) = stem_to_path.get(&link.target) {
                link.target = full_path.to_string();
                return Some(link);
            }
            if let Some(resolved) = alias_to_path.get(&link.target.to_lowercase()) {
                if node_ids.contains(resolved.as_str()) {
                    link.target = resolved.clone();
                    return Some(link);
                }
            }
            None
        })
        .collect();

    // ── Optional: include block nodes and block reference edges ──
    if include_blocks.unwrap_or(false) {
        // Query all blocks as nodes (id = "note_path#^block_id")
        let mut block_stmt = conn
            .prepare(
                "SELECT n.path, b.block_id, b.content, b.block_type, n.created_at
                 FROM blocks b
                 JOIN notes n ON n.id = b.note_id
                 ORDER BY n.path, b.line_number",
            )
            .map_err(|e| SearchError::Internal(e.to_string()))?;

        let block_nodes: Vec<GraphNode> = block_stmt
            .query_map([], |row| {
                let note_path: String = row.get(0)?;
                let block_id: String = row.get(1)?;
                let content: String = row.get(2)?;
                let created_at: Option<String> = row.get(4)?;
                // Block node id uses "path#^blockId" format
                let id = format!("{}#^{}", note_path, block_id);
                // Truncate content for display title (char-safe for multi-byte)
                let truncated: String = content.chars().take(37).collect();
                let title = if truncated.len() < content.len() {
                    format!("^{}: {}…", block_id, truncated)
                } else {
                    format!("^{}: {}", block_id, content)
                };
                Ok(GraphNode {
                    id,
                    title,
                    created_at,
                    modified_at: None,
                    is_block: Some(true),
                })
            })
            .map_err(|e| SearchError::Internal(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        // Add edge from note → its block (containment)
        for bn in &block_nodes {
            if let Some(note_path) = bn.id.split("#^").next() {
                if node_ids.contains(note_path) {
                    links.push(GraphLink {
                        source: note_path.to_string(),
                        target: bn.id.clone(),
                    });
                }
            }
        }

        // Build block node id set for reference edge filtering
        let block_node_ids: std::collections::HashSet<&str> =
            block_nodes.iter().map(|n| n.id.as_str()).collect();

        // Query block reference edges (note → note#^block)
        let mut blink_stmt = conn
            .prepare(
                "SELECT n.path, bl.target_note_path, bl.target_block_id
                 FROM block_links bl
                 JOIN notes n ON n.id = bl.source_id
                 WHERE bl.target_block_id IS NOT NULL AND bl.target_block_id != ''",
            )
            .map_err(|e| SearchError::Internal(e.to_string()))?;

        let block_ref_links: Vec<GraphLink> = blink_stmt
            .query_map([], |row| {
                let source: String = row.get(0)?;
                let target_path: String = row.get(1)?;
                let target_block: String = row.get(2)?;
                Ok(GraphLink {
                    source,
                    target: format!("{}#^{}", target_path, target_block),
                })
            })
            .map_err(|e| SearchError::Internal(e.to_string()))?
            .filter_map(|r| r.ok())
            .filter(|link| {
                node_ids.contains(link.source.as_str())
                    && block_node_ids.contains(link.target.as_str())
            })
            .collect();

        links.extend(block_ref_links);
        nodes.extend(block_nodes);
    }

    Ok(GraphData { nodes, links })
}

/// Build a local knowledge graph centered on a specific note.
/// Returns only nodes within `depth` hops of the center note.
#[tauri::command]
pub async fn get_local_graph(
    center_path: String,
    depth: Option<u32>,
    state: State<'_, AppState>,
) -> Result<GraphData, SearchError> {
    // Start with the full graph (without blocks for performance)
    let full = get_graph_data(Some(false), state).await?;
    let max_depth = depth.unwrap_or(2).min(5);

    // Build adjacency index (bidirectional) using owned Strings for BFS
    let mut adjacency: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for link in &full.links {
        adjacency.entry(link.source.clone()).or_default().push(link.target.clone());
        adjacency.entry(link.target.clone()).or_default().push(link.source.clone());
    }

    // Resolve center: try exact path first, then stem match
    let center_id = if full.nodes.iter().any(|n| n.id == center_path) {
        center_path.clone()
    } else {
        let stem = std::path::Path::new(&center_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(center_path.clone());
        full.nodes
            .iter()
            .find(|n| {
                std::path::Path::new(&n.id)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
                    == stem
            })
            .map(|n| n.id.clone())
            .unwrap_or(center_path)
    };

    // BFS to collect reachable node ids within max_depth (owned Strings)
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<(String, u32)> = std::collections::VecDeque::new();
    visited.insert(center_id.clone());
    queue.push_back((center_id, 0));

    while let Some((node_id, d)) = queue.pop_front() {
        if d >= max_depth {
            continue;
        }
        if let Some(neighbors) = adjacency.get(&node_id) {
            for neighbor in neighbors {
                if visited.insert(neighbor.clone()) {
                    queue.push_back((neighbor.clone(), d + 1));
                }
            }
        }
    }

    // Filter nodes and links to the visited set
    let nodes: Vec<GraphNode> = full.nodes.into_iter().filter(|n| visited.contains(&n.id)).collect();
    let links: Vec<GraphLink> = full.links
        .into_iter()
        .filter(|l| visited.contains(&l.source) && visited.contains(&l.target))
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
/// When `hierarchical` is true, also matches descendant tags (e.g. `dev` matches `dev/rust`).
#[tauri::command]
pub async fn search_by_tag(
    tag: String,
    hierarchical: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;
    db::search_by_tag(conn, &tag, hierarchical.unwrap_or(false))
        .map_err(|e| SearchError::Internal(e.to_string()))
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
    pub due_date: Option<String>,
    pub priority: Option<String>,
}

/// Regex to extract due date from task text: `@2026-03-09`
static TASK_DUE_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"@(\d{4}-\d{2}-\d{2})").unwrap());

/// Regex to extract priority from task text: `!high`, `!medium`, `!low`
static TASK_PRIORITY_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"!(high|medium|low)").unwrap());

/// Scan all vault .md files for task checkbox items (- [ ] / - [x]).
/// Extracts inline metadata: `@YYYY-MM-DD` for due dates, `!high/medium/low` for priority.
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
        } else if path.extension().and_then(|e| e.to_str()).map_or(false, |ext| super::util::is_supported_extension(ext)) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                let rel_path = path.strip_prefix(root).unwrap_or(&path);
                let rel_str = rel_path.to_string_lossy().to_string();
                for (i, line) in content.lines().enumerate() {
                    let trimmed = line.trim();
                    let (text, done) = if let Some(t) = trimmed.strip_prefix("- [ ] ") {
                        (t, false)
                    } else if let Some(t) = trimmed.strip_prefix("- [x] ").or_else(|| trimmed.strip_prefix("- [X] ")) {
                        (t, true)
                    } else {
                        continue;
                    };

                    // Extract due date (@YYYY-MM-DD)
                    let due_date = TASK_DUE_RE.captures(text).map(|c| c[1].to_string());
                    // Extract priority (!high/!medium/!low)
                    let priority = TASK_PRIORITY_RE.captures(text).map(|c| c[1].to_string());
                    // Clean display text: remove metadata markers
                    let clean_text = TASK_DUE_RE.replace_all(text, "");
                    let clean_text = TASK_PRIORITY_RE.replace_all(&clean_text, "");
                    let clean_text = clean_text.trim().to_string();

                    tasks.push(TaskItem {
                        path: rel_str.clone(),
                        line: i + 1,
                        text: clean_text,
                        done,
                        due_date,
                        priority,
                    });
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Advanced search with structured filters
// ============================================================================

/// Advanced search combining FTS, tag, and path filters.
/// Frontend parses `tag:xxx path:yyy query` and sends structured filters.
#[tauri::command]
pub async fn advanced_search(
    query: Option<String>,
    tag_filter: Option<String>,
    path_filter: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::advanced_search(conn, query.as_deref(), tag_filter.as_deref(), path_filter.as_deref())
        .map_err(|e| SearchError::Internal(e.to_string()))
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

// ── Semantic graph data (AI-enhanced knowledge graph) ───────

/// Semantic edge representing embedding-based similarity between two notes
#[derive(Debug, Clone, Serialize)]
pub struct SemanticEdge {
    pub source: String,
    pub target: String,
    pub similarity: f64,
}

/// A group of notes clustered by semantic proximity
#[derive(Debug, Clone, Serialize)]
pub struct SemanticCluster {
    pub id: usize,
    pub label: String,
    pub note_paths: Vec<String>,
}

/// A suggested link based on embedding similarity
#[derive(Debug, Clone, Serialize)]
pub struct SuggestedLink {
    pub from: String,
    pub to: String,
    pub similarity: f64,
    pub reason: String,
}

/// Full semantic graph data for AI-enhanced visualization
#[derive(Debug, Clone, Serialize)]
pub struct SemanticGraphData {
    pub nodes: Vec<GraphNode>,
    pub structural_links: Vec<GraphLink>,
    pub semantic_edges: Vec<SemanticEdge>,
    pub clusters: Vec<SemanticCluster>,
    pub orphans: Vec<String>,
    pub suggested_links: Vec<SuggestedLink>,
}

/// Get AI-enhanced graph data with semantic similarity edges.
/// Computes cosine similarity between note embeddings and returns
/// structural links, semantic edges, clusters, orphans, and suggested links.
#[tauri::command]
pub async fn get_semantic_graph_data(
    similarity_threshold: Option<f64>,
    state: State<'_, AppState>,
) -> Result<SemanticGraphData, SearchError> {
    let threshold = similarity_threshold.unwrap_or(0.75);

    // Get structural graph first
    let structural = get_graph_data(Some(false), state.clone()).await?;

    // Load embeddings inside the lock, then release it before heavy computation
    let note_embeddings = {
        let db_guard = state.read_db.lock();
        let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;
        db::get_note_mean_embeddings(conn)
            .map_err(|e| SearchError::Internal(e.to_string()))?
    }; // lock released here

    // Build existing link set for suggested links filtering
    let existing_links: std::collections::HashSet<(String, String)> = structural
        .links
        .iter()
        .map(|l| (l.source.clone(), l.target.clone()))
        .collect();

    // Build connected set for orphan detection
    let mut connected: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for link in &structural.links {
        connected.insert(&link.source);
        connected.insert(&link.target);
    }

    let orphans: Vec<String> = structural
        .nodes
        .iter()
        .filter(|n| !connected.contains(n.id.as_str()))
        .map(|n| n.id.clone())
        .collect();

    // Offload O(n²) pairwise computation to a blocking thread
    let structural_nodes = structural.nodes.clone();
    let structural_links = structural.links.clone();
    let (semantic_edges, suggested_links, clusters) = tokio::task::spawn_blocking(move || {
        let paths: Vec<&String> = note_embeddings.keys().collect();
        let mut semantic_edges: Vec<SemanticEdge> = Vec::new();
        let mut suggested_links: Vec<SuggestedLink> = Vec::new();

        // Pairwise similarity computation
        for i in 0..paths.len() {
            for j in (i + 1)..paths.len() {
                let a = &note_embeddings[paths[i]];
                let b = &note_embeddings[paths[j]];
                if a.len() != b.len() {
                    continue;
                }
                let sim = db::cosine_similarity_pub(a, b) as f64;
                if sim >= threshold {
                    semantic_edges.push(SemanticEdge {
                        source: paths[i].clone(),
                        target: paths[j].clone(),
                        similarity: sim,
                    });

                    // Suggest link if not already structurally linked
                    let forward = (paths[i].clone(), paths[j].clone());
                    let backward = (paths[j].clone(), paths[i].clone());
                    if !existing_links.contains(&forward) && !existing_links.contains(&backward) {
                        suggested_links.push(SuggestedLink {
                            from: paths[i].clone(),
                            to: paths[j].clone(),
                            similarity: sim,
                            reason: format!("Semantic similarity: {:.0}%", sim * 100.0),
                        });
                    }
                }
            }
        }

        // Sort suggested links by similarity (highest first), limit to 20
        suggested_links.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
        suggested_links.truncate(20);

        // Simple epsilon-neighborhood clustering from semantic edges
        let clusters = build_semantic_clusters(&semantic_edges, &structural_nodes);

        (semantic_edges, suggested_links, clusters)
    })
    .await
    .map_err(|e| SearchError::Internal(format!("Computation task failed: {}", e)))?;

    Ok(SemanticGraphData {
        nodes: structural.nodes,
        structural_links: structural.links,
        semantic_edges,
        clusters,
        orphans,
        suggested_links,
    })
}

/// Build clusters from semantic edges using connected-components algorithm
fn build_semantic_clusters(edges: &[SemanticEdge], nodes: &[GraphNode]) -> Vec<SemanticCluster> {
    use std::collections::{HashMap, HashSet, VecDeque};

    // Build adjacency from semantic edges
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in edges {
        adj.entry(&e.source).or_default().push(&e.target);
        adj.entry(&e.target).or_default().push(&e.source);
    }

    // Only cluster nodes that appear in semantic edges
    let mut visited: HashSet<&str> = HashSet::new();
    let mut clusters: Vec<SemanticCluster> = Vec::new();

    // Node title lookup for cluster labeling
    let title_map: HashMap<&str, &str> = nodes
        .iter()
        .map(|n| (n.id.as_str(), n.title.as_str()))
        .collect();

    for node in adj.keys() {
        if visited.contains(node) {
            continue;
        }

        // BFS from this node to find connected component
        let mut component: Vec<String> = Vec::new();
        let mut queue: VecDeque<&str> = VecDeque::new();
        queue.push_back(node);
        visited.insert(node);

        while let Some(current) = queue.pop_front() {
            component.push(current.to_string());
            if let Some(neighbors) = adj.get(current) {
                for &neighbor in neighbors {
                    if visited.insert(neighbor) {
                        queue.push_back(neighbor);
                    }
                }
            }
        }

        // Only keep clusters with 2+ members
        if component.len() >= 2 {
            // Label: use the shortest title in the cluster as representative
            let label = component
                .iter()
                .filter_map(|p| title_map.get(p.as_str()))
                .min_by_key(|t| t.len())
                .map(|t| format!("{}…", t))
                .unwrap_or_else(|| format!("Cluster {}", clusters.len() + 1));

            clusters.push(SemanticCluster {
                id: clusters.len(),
                label,
                note_paths: component,
            });
        }
    }

    clusters
}
