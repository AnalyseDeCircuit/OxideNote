//! Tauri commands for semantic search (embedding-based).
//!
//! Provides three commands:
//!   - `semantic_search`      — embed a query string, then cosine-search the index
//!   - `rebuild_embeddings`   — re-embed all notes in the vault
//!   - `get_embedding_status` — return indexing statistics for the frontend

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::indexing::{db, embeddings};
use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("No vault opened")]
    NoVault,
    #[error("Index not available")]
    NoIndex,
    #[error("Embedding not configured")]
    NotConfigured,
    #[error("Embedding error: {0}")]
    Internal(String),
}

impl Serialize for EmbeddingError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── Config persistence (stored in <vault>/.oxidenote/embedding_config.json) ──

fn config_path(vault: &std::path::Path) -> std::path::PathBuf {
    vault.join(".oxidenote").join("embedding_config.json")
}

fn load_config(vault: &std::path::Path) -> Option<embeddings::EmbeddingConfig> {
    let path = config_path(vault);
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_config(vault: &std::path::Path, config: &embeddings::EmbeddingConfig) -> Result<(), String> {
    let dir = vault.join(".oxidenote");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(vault), json).map_err(|e| e.to_string())?;

    // Ensure .oxidenote/.gitignore excludes sensitive files
    let gitignore_path = dir.join(".gitignore");
    if !gitignore_path.exists() {
        let _ = std::fs::write(&gitignore_path, "embedding_config.json\n");
    } else {
        // Append entry if not already present
        if let Ok(content) = std::fs::read_to_string(&gitignore_path) {
            if !content.contains("embedding_config.json") {
                let _ = std::fs::write(
                    &gitignore_path,
                    format!("{}\nembedding_config.json\n", content.trim_end()),
                );
            }
        }
    }

    Ok(())
}

// ── Tauri command: save_embedding_config ─────────────────────

/// Save the embedding provider configuration to the vault
#[tauri::command]
pub async fn save_embedding_config(
    config: embeddings::EmbeddingConfig,
    state: State<'_, AppState>,
) -> Result<(), EmbeddingError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(EmbeddingError::NoVault)?;
    save_config(vault, &config).map_err(EmbeddingError::Internal)
}

/// Load the current embedding configuration
#[tauri::command]
pub async fn load_embedding_config(
    state: State<'_, AppState>,
) -> Result<Option<embeddings::EmbeddingConfig>, EmbeddingError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(EmbeddingError::NoVault)?;
    Ok(load_config(vault))
}

// ── Tauri command: semantic_search ──────────────────────────

/// Semantic search result returned to frontend
#[derive(Debug, Clone, Serialize)]
pub struct SemanticSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f32,
}

/// Embed a natural-language query, then search by cosine similarity.
#[tauri::command]
pub async fn semantic_search(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SemanticSearchResult>, EmbeddingError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(EmbeddingError::NoVault)?;

    let config = load_config(vault).ok_or(EmbeddingError::NotConfigured)?;
    if config.api_url.is_empty() {
        return Err(EmbeddingError::NotConfigured);
    }

    // Embed the query text
    let query_texts = vec![query];
    let embeddings_result = embeddings::embed_texts(&config, &query_texts)
        .await
        .map_err(EmbeddingError::Internal)?;

    if embeddings_result.is_empty() {
        return Err(EmbeddingError::Internal("No embedding returned for query".into()));
    }
    let query_vec = &embeddings_result[0];

    // Search the index
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(EmbeddingError::NoIndex)?;

    let results = db::search_embeddings(conn, query_vec, 20, 0.3)
        .map_err(|e| EmbeddingError::Internal(e.to_string()))?;

    Ok(results
        .into_iter()
        .map(|r| SemanticSearchResult {
            path: r.path,
            title: r.title,
            snippet: r.snippet,
            score: r.score,
        })
        .collect())
}

// ── Tauri command: rebuild_embeddings ────────────────────────

/// Rebuild result summary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildResult {
    pub embedded: usize,
    pub chunks: usize,
    pub errors: Vec<String>,
}

/// Re-embed all notes in the vault. Processes notes in batches.
/// This is a blocking operation — the frontend should show progress.
#[tauri::command]
pub async fn rebuild_embeddings(
    state: State<'_, AppState>,
) -> Result<RebuildResult, EmbeddingError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(EmbeddingError::NoVault)?;

    let config = load_config(vault).ok_or(EmbeddingError::NotConfigured)?;
    if config.api_url.is_empty() {
        return Err(EmbeddingError::NotConfigured);
    }

    // Collect all .md files from the vault
    let files = collect_md_files(vault).map_err(EmbeddingError::Internal)?;

    let mut total_embedded = 0usize;
    let mut total_chunks = 0usize;
    let mut errors = Vec::new();

    // Process files in batches to limit API calls
    const BATCH_SIZE: usize = 10;

    for batch in files.chunks(BATCH_SIZE) {
        // Read content and chunk each file
        let mut batch_entries: Vec<(String, Vec<String>)> = Vec::new();

        for file_path in batch {
            let rel_path = file_path
                .strip_prefix(vault)
                .unwrap_or(file_path)
                .to_string_lossy()
                .to_string();

            match std::fs::read_to_string(file_path) {
                Ok(content) => {
                    let chunks = embeddings::chunk_text(&content);
                    if !chunks.is_empty() {
                        batch_entries.push((rel_path, chunks));
                    }
                }
                Err(e) => {
                    errors.push(format!("{}: {}", file_path.display(), e));
                }
            }
        }

        if batch_entries.is_empty() {
            continue;
        }

        // Flatten all chunks for one API call
        let all_chunks: Vec<String> = batch_entries
            .iter()
            .flat_map(|(_, chunks)| chunks.iter().cloned())
            .collect();

        match embeddings::embed_texts(&config, &all_chunks).await {
            Ok(all_embeddings) => {
                let now = chrono::Utc::now().to_rfc3339();
                let mut emb_idx = 0;

                for (rel_path, chunks) in &batch_entries {
                    // Acquire DB lock per-file to avoid starving other writers
                    let db_guard = state.db.lock();
                    let conn = match db_guard.as_ref() {
                        Some(c) => c,
                        None => {
                            errors.push("DB not available".into());
                            emb_idx += chunks.len();
                            continue;
                        }
                    };

                    // Clear old embeddings for this note
                    if let Err(e) = db::delete_note_embeddings(conn, rel_path) {
                        errors.push(format!("{}: {}", rel_path, e));
                        emb_idx += chunks.len();
                        drop(db_guard);
                        continue;
                    }

                    for (chunk_i, chunk_text) in chunks.iter().enumerate() {
                        if emb_idx >= all_embeddings.len() {
                            break;
                        }
                        let emb = &all_embeddings[emb_idx];
                        if let Err(e) = db::upsert_embedding(
                            conn,
                            rel_path,
                            chunk_i as i64,
                            chunk_text,
                            emb,
                            &config.model,
                            &now,
                        ) {
                            errors.push(format!("{} chunk {}: {}", rel_path, chunk_i, e));
                        } else {
                            total_chunks += 1;
                        }
                        emb_idx += 1;
                    }
                    total_embedded += 1;
                    // db_guard dropped here — lock released between files
                }
            }
            Err(e) => {
                for (path, _) in &batch_entries {
                    errors.push(format!("{}: {}", path, e));
                }
            }
        }
    }

    Ok(RebuildResult {
        embedded: total_embedded,
        chunks: total_chunks,
        errors,
    })
}

// ── Tauri command: get_embedding_status ──────────────────────

/// Embedding index status for frontend display
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingStatusResult {
    pub total_notes: i64,
    pub embedded_notes: i64,
    pub total_chunks: i64,
    pub model_name: Option<String>,
    pub configured: bool,
}

/// Get the current embedding index status
#[tauri::command]
pub async fn get_embedding_status(
    state: State<'_, AppState>,
) -> Result<EmbeddingStatusResult, EmbeddingError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(EmbeddingError::NoVault)?;

    let configured = load_config(vault)
        .map(|c| !c.api_url.is_empty())
        .unwrap_or(false);

    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(EmbeddingError::NoIndex)?;

    let status = db::get_embedding_status(conn)
        .map_err(|e| EmbeddingError::Internal(e.to_string()))?;

    Ok(EmbeddingStatusResult {
        total_notes: status.total_notes,
        embedded_notes: status.embedded_notes,
        total_chunks: status.total_chunks,
        model_name: status.model_name,
        configured,
    })
}

// ── Helper: collect .md files ───────────────────────────────

fn collect_md_files(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut files = Vec::new();
    collect_md_recursive(dir, dir, &mut files)?;
    Ok(files)
}

fn collect_md_recursive(
    root: &std::path::Path,
    dir: &std::path::Path,
    files: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip hidden directories
        if path.file_name().map_or(false, |n| n.to_string_lossy().starts_with('.')) {
            continue;
        }
        if path.is_dir() {
            collect_md_recursive(root, &path, files)?;
        } else if path.extension().map_or(false, |ext| ext == "md") {
            files.push(path);
        }
    }
    Ok(())
}
