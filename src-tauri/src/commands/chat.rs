//! Tauri commands for AI chat streaming.
//!
//! Handles LLM communication across 9 providers (OpenAI, Claude, Ollama,
//! DeepSeek, Gemini, Moonshot, Groq, OpenRouter, Custom). The streaming
//! pipeline: build request → send HTTP → parse SSE/JSON-lines → emit
//! Tauri events → frontend renders incrementally.
//!
//! Also provides RAG context building (backlinks + semantic search) and
//! dynamic model listing via provider APIs.
//!
//! Shared LLM types and HTTP logic are in `crate::llm` — this module
//! is a thin wrapper adding streaming and Tauri event emission.

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::indexing::{db, embeddings};
use crate::llm::client::{fallback_context_window, truncate_chars, LlmError};
use crate::state::AppState;

// Re-export shared types so existing frontend API stays compatible
pub use crate::llm::types::{
    ChatConfig, ChatMessage, ChatProvider, ModelInfo, StreamChunk, TokenUsage,
};

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("No vault opened")]
    NoVault,
    #[error("Index not available")]
    NoIndex,
    #[error("Network error: {0}")]
    Network(String),
    #[error("Provider error: {0}")]
    Provider(String),
    #[error("Request aborted")]
    Aborted,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl Serialize for ChatError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for ChatError {
    fn from(e: reqwest::Error) -> Self {
        ChatError::Network(e.to_string())
    }
}

impl From<LlmError> for ChatError {
    fn from(e: LlmError) -> Self {
        match e {
            LlmError::Network(s) => ChatError::Network(s),
            LlmError::Provider(s) => ChatError::Provider(s),
            LlmError::Aborted => ChatError::Aborted,
            LlmError::Parse(s) => ChatError::Internal(s),
        }
    }
}

// ── Chat stream command ─────────────────────────────────────

/// Fire-and-forget streaming command. Results arrive via "chat-stream-chunk" events.
/// The frontend calls `chatAbort(requestId)` to cancel.
#[tauri::command]
pub async fn chat_stream(
    request_id: String,
    messages: Vec<ChatMessage>,
    config: ChatConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), ChatError> {
    // Create abort channel
    let (abort_tx, abort_rx) = tokio::sync::watch::channel(false);
    {
        let mut senders = state.abort_senders.lock();
        senders.insert(request_id.clone(), abort_tx);
    }

    let req_id = request_id.clone();
    let abort_map = Arc::clone(&state.abort_senders);

    // Spawn the streaming task so the command returns immediately
    tokio::spawn(async move {
        let result = execute_stream(&req_id, &messages, &config, &app, abort_rx).await;

        // Emit final chunk on error
        if let Err(e) = result {
            let _ = app.emit(
                "chat-stream-chunk",
                StreamChunk {
                    request_id: req_id.clone(),
                    content: String::new(),
                    reasoning: String::new(),
                    done: true,
                    error: Some(e.to_string()),
                    usage: None,
                },
            );
        }

        // Clean up abort sender
        {
            let mut senders = abort_map.lock();
            senders.remove(&req_id);
        }
    });

    Ok(())
}

/// Abort an in-progress chat stream
#[tauri::command]
pub async fn chat_abort(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<(), ChatError> {
    let senders = state.abort_senders.lock();
    if let Some(tx) = senders.get(&request_id) {
        let _ = tx.send(true);
    }
    Ok(())
}

// ── Stream execution ────────────────────────────────────────

/// Core streaming logic: build request, send with retry, parse response
async fn execute_stream(
    request_id: &str,
    messages: &[ChatMessage],
    config: &ChatConfig,
    app: &AppHandle,
    mut abort_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), ChatError> {
    let response = crate::llm::send_with_retry(messages, config).await?;

    match config.provider {
        ChatProvider::Ollama => {
            parse_ollama_stream(request_id, response, app, &mut abort_rx).await
        }
        ChatProvider::Claude => {
            parse_claude_sse(request_id, response, app, &mut abort_rx).await
        }
        _ => {
            // OpenAI-compatible: OpenAI, DeepSeek, Gemini, Moonshot, Groq, OpenRouter, Custom
            parse_openai_sse(request_id, response, config, app, &mut abort_rx).await
        }
    }
}

// ── SSE / JSON-lines parsing ────────────────────────────────

/// Parse OpenAI-compatible SSE stream (DeepSeek, Gemini, Moonshot, Groq, OpenRouter, Custom)
async fn parse_openai_sse(
    request_id: &str,
    response: reqwest::Response,
    _config: &ChatConfig,
    app: &AppHandle,
    abort_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), ChatError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut usage: Option<TokenUsage> = None;

    loop {
        tokio::select! {
            _ = abort_rx.changed() => {
                if *abort_rx.borrow() {
                    let _ = app.emit("chat-stream-chunk", StreamChunk {
                        request_id: request_id.to_string(),
                        content: String::new(),
                        reasoning: String::new(),
                        done: true,
                        error: Some("Aborted".into()),
                        usage: None,
                    });
                    return Err(ChatError::Aborted);
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let text = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&text);

                        // Process complete SSE lines
                        while let Some(line_end) = buffer.find('\n') {
                            let line = buffer[..line_end].trim().to_string();
                            buffer = buffer[line_end + 1..].to_string();

                            if line.is_empty() || line.starts_with(':') {
                                continue;
                            }

                            if line == "data: [DONE]" {
                                let _ = app.emit("chat-stream-chunk", StreamChunk {
                                    request_id: request_id.to_string(),
                                    content: String::new(),
                                    reasoning: String::new(),
                                    done: true,
                                    error: None,
                                    usage,
                                });
                                return Ok(());
                            }

                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    let mut content = String::new();
                                    let mut reasoning = String::new();

                                    // Extract content delta
                                    if let Some(delta) = json.pointer("/choices/0/delta") {
                                        if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
                                            content = c.to_string();
                                        }
                                        // DeepSeek / Moonshot reasoning_content field
                                        if let Some(r) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
                                            reasoning = r.to_string();
                                        }
                                        // OpenRouter uses "reasoning" field
                                        if reasoning.is_empty() {
                                            if let Some(r) = delta.get("reasoning").and_then(|v| v.as_str()) {
                                                reasoning = r.to_string();
                                            }
                                        }
                                    }

                                    // Extract usage from final chunk
                                    if let Some(u) = json.get("usage") {
                                        if let Ok(token_usage) = serde_json::from_value::<TokenUsage>(u.clone()) {
                                            usage = Some(token_usage);
                                        }
                                    }

                                    if !content.is_empty() || !reasoning.is_empty() {
                                        let _ = app.emit("chat-stream-chunk", StreamChunk {
                                            request_id: request_id.to_string(),
                                            content,
                                            reasoning,
                                            done: false,
                                            error: None,
                                            usage: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        return Err(ChatError::Network(e.to_string()));
                    }
                    None => {
                        // Stream ended without [DONE] marker
                        let _ = app.emit("chat-stream-chunk", StreamChunk {
                            request_id: request_id.to_string(),
                            content: String::new(),
                            reasoning: String::new(),
                            done: true,
                            error: None,
                            usage,
                        });
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Parse Claude SSE stream (Anthropic-specific event types)
async fn parse_claude_sse(
    request_id: &str,
    response: reqwest::Response,
    app: &AppHandle,
    abort_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), ChatError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut usage: Option<TokenUsage> = None;
    let mut current_event_type = String::new();

    loop {
        tokio::select! {
            _ = abort_rx.changed() => {
                if *abort_rx.borrow() {
                    let _ = app.emit("chat-stream-chunk", StreamChunk {
                        request_id: request_id.to_string(),
                        content: String::new(),
                        reasoning: String::new(),
                        done: true,
                        error: Some("Aborted".into()),
                        usage: None,
                    });
                    return Err(ChatError::Aborted);
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let text = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&text);

                        while let Some(line_end) = buffer.find('\n') {
                            let line = buffer[..line_end].trim().to_string();
                            buffer = buffer[line_end + 1..].to_string();

                            if line.is_empty() {
                                continue;
                            }

                            // Track event type
                            if let Some(evt) = line.strip_prefix("event: ") {
                                current_event_type = evt.to_string();
                                continue;
                            }

                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    match current_event_type.as_str() {
                                        "content_block_delta" => {
                                            let mut content = String::new();
                                            let mut reasoning = String::new();

                                            if let Some(delta) = json.get("delta") {
                                                let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                                match delta_type {
                                                    "text_delta" => {
                                                        content = delta.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                    }
                                                    "thinking_delta" => {
                                                        reasoning = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                    }
                                                    _ => {}
                                                }
                                            }

                                            if !content.is_empty() || !reasoning.is_empty() {
                                                let _ = app.emit("chat-stream-chunk", StreamChunk {
                                                    request_id: request_id.to_string(),
                                                    content,
                                                    reasoning,
                                                    done: false,
                                                    error: None,
                                                    usage: None,
                                                });
                                            }
                                        }
                                        "message_delta" => {
                                            // Final message with usage
                                            if let Some(u) = json.get("usage") {
                                                let input = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                                let output = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                                usage = Some(TokenUsage {
                                                    prompt_tokens: input,
                                                    completion_tokens: output,
                                                    total_tokens: input + output,
                                                });
                                            }
                                        }
                                        "message_stop" => {
                                            let _ = app.emit("chat-stream-chunk", StreamChunk {
                                                request_id: request_id.to_string(),
                                                content: String::new(),
                                                reasoning: String::new(),
                                                done: true,
                                                error: None,
                                                usage,
                                            });
                                            return Ok(());
                                        }
                                        "error" => {
                                            let msg = json.get("error")
                                                .and_then(|e| e.get("message"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("Unknown Claude error");
                                            return Err(ChatError::Provider(msg.to_string()));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        return Err(ChatError::Network(e.to_string()));
                    }
                    None => {
                        let _ = app.emit("chat-stream-chunk", StreamChunk {
                            request_id: request_id.to_string(),
                            content: String::new(),
                            reasoning: String::new(),
                            done: true,
                            error: None,
                            usage,
                        });
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Parse Ollama JSON-lines stream
async fn parse_ollama_stream(
    request_id: &str,
    response: reqwest::Response,
    app: &AppHandle,
    abort_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), ChatError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        tokio::select! {
            _ = abort_rx.changed() => {
                if *abort_rx.borrow() {
                    let _ = app.emit("chat-stream-chunk", StreamChunk {
                        request_id: request_id.to_string(),
                        content: String::new(),
                        reasoning: String::new(),
                        done: true,
                        error: Some("Aborted".into()),
                        usage: None,
                    });
                    return Err(ChatError::Aborted);
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let text = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&text);

                        while let Some(line_end) = buffer.find('\n') {
                            let line = buffer[..line_end].trim().to_string();
                            buffer = buffer[line_end + 1..].to_string();

                            if line.is_empty() {
                                continue;
                            }

                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                                let done = json.get("done").and_then(|v| v.as_bool()).unwrap_or(false);

                                let mut content = String::new();
                                let mut reasoning = String::new();

                                if let Some(msg) = json.get("message") {
                                    content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    // Ollama thinking content
                                    if let Some(r) = msg.get("thinking").and_then(|v| v.as_str()) {
                                        reasoning = r.to_string();
                                    }
                                }

                                let usage = if done {
                                    let prompt = json.get("prompt_eval_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                    let completion = json.get("eval_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                    Some(TokenUsage {
                                        prompt_tokens: prompt,
                                        completion_tokens: completion,
                                        total_tokens: prompt + completion,
                                    })
                                } else {
                                    None
                                };

                                let _ = app.emit("chat-stream-chunk", StreamChunk {
                                    request_id: request_id.to_string(),
                                    content,
                                    reasoning,
                                    done,
                                    error: None,
                                    usage,
                                });

                                if done {
                                    return Ok(());
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        return Err(ChatError::Network(e.to_string()));
                    }
                    None => {
                        let _ = app.emit("chat-stream-chunk", StreamChunk {
                            request_id: request_id.to_string(),
                            content: String::new(),
                            reasoning: String::new(),
                            done: true,
                            error: None,
                            usage: None,
                        });
                        return Ok(());
                    }
                }
            }
        }
    }
}

// ── RAG context building ────────────────────────────────────

/// Context about the current note
#[derive(Debug, Clone, Serialize)]
pub struct NoteContext {
    pub path: String,
    pub title: String,
    pub content: String,
}

/// Summary of a backlinked note
#[derive(Debug, Clone, Serialize)]
pub struct NoteSummary {
    pub path: String,
    pub title: String,
    pub summary: String,
}

/// Semantic search snippet
#[derive(Debug, Clone, Serialize)]
pub struct SemanticSnippet {
    pub source: String,
    pub text: String,
    pub score: f64,
}

/// Full RAG context assembled for the AI
#[derive(Debug, Clone, Serialize)]
pub struct ChatContext {
    pub current_note: NoteContext,
    pub backlink_summaries: Vec<NoteSummary>,
    pub semantic_snippets: Vec<SemanticSnippet>,
    pub referenced_notes: Vec<NoteContext>,
    pub is_compact: bool,
    pub context_window: u32,
    pub rag_budget_tokens: u32,
}

/// Build RAG context for the chat, with dynamic budget allocation
#[tauri::command]
pub async fn build_chat_context(
    note_path: String,
    query: String,
    provider: ChatProvider,
    api_url: String,
    model: String,
    context_window_override: Option<u32>,
    max_tokens: u32,
    referenced_paths: Vec<String>,
    history_token_estimate: u32,
    state: State<'_, AppState>,
) -> Result<ChatContext, ChatError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(ChatError::NoVault)?;

    // Resolve context window
    let ctx_window = if let Some(override_val) = context_window_override {
        override_val
    } else if provider == ChatProvider::Ollama {
        get_ollama_context_window(&api_url, &model).await.unwrap_or_else(|| fallback_context_window(&model))
    } else {
        fallback_context_window(&model)
    };

    // Calculate budgets
    let input_budget = ctx_window.saturating_sub(max_tokens);
    let history_budget = (input_budget * 40 / 100).min(16_000);
    let rag_budget_tokens = input_budget
        .saturating_sub(history_budget)
        .saturating_sub(history_token_estimate)
        .saturating_sub(500); // system prompt base

    let is_compact = rag_budget_tokens < 4000;

    // Convert token budget to approximate char budget (blended ~3 chars/token)
    let rag_chars = rag_budget_tokens * 3;
    let note_chars = (rag_chars * 45 / 100) as usize;
    let mention_chars = (rag_chars * 25 / 100) as usize;
    let backlink_chars = (rag_chars * 15 / 100) as usize;
    let snippet_chars = (rag_chars * 15 / 100) as usize;

    // P0: Current note content
    let note_full_path = vault.join(&note_path);
    let note_content = tokio::fs::read_to_string(&note_full_path)
        .await
        .unwrap_or_default();
    let note_title = std::path::Path::new(&note_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let truncated_content = if is_compact {
        // Compact: first 1/3 + ... + last 1/6
        let chars: Vec<char> = note_content.chars().collect();
        let third = (note_chars / 3).min(chars.len());
        let sixth = (note_chars / 6).min(chars.len().saturating_sub(third));
        if chars.len() > note_chars && sixth > 0 {
            let head: String = chars[..third].iter().collect();
            let tail: String = chars[chars.len() - sixth..].iter().collect();
            format!("{}\n...\n{}", head, tail)
        } else {
            truncate_chars(&note_content, note_chars)
        }
    } else {
        truncate_chars(&note_content, note_chars)
    };

    let current_note = NoteContext {
        path: note_path.clone(),
        title: note_title,
        content: truncated_content,
    };

    // P1: @mentioned notes
    let per_mention_limit = if is_compact { 500 } else { mention_chars / referenced_paths.len().max(1) };
    let mut referenced_notes = Vec::new();
    for ref_path in &referenced_paths {
        let full_path = vault.join(ref_path);
        if let Ok(content) = tokio::fs::read_to_string(&full_path).await {
            let title = std::path::Path::new(ref_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            referenced_notes.push(NoteContext {
                path: ref_path.clone(),
                title,
                content: truncate_chars(&content, per_mention_limit),
            });
        }
    }

    // P2: Backlink summaries
    let max_backlinks = if is_compact { 3 } else { 5 };
    let per_backlink_limit = if is_compact { 200 } else { backlink_chars / max_backlinks };
    let mut backlink_summaries = Vec::new();
    {
        let db_guard = state.read_db.lock();
        if let Some(conn) = db_guard.as_ref() {
            if let Ok(backlinks) = db::get_backlinks(conn, &note_path) {
                for bl in backlinks.into_iter().take(max_backlinks) {
                    // Read backlinked note for summary
                    let bl_path = vault.join(&bl.path);
                    let summary = if let Ok(content) = std::fs::read_to_string(&bl_path) {
                        truncate_chars(&content, per_backlink_limit)
                    } else {
                        bl.snippet
                    };
                    backlink_summaries.push(NoteSummary {
                        path: bl.path,
                        title: bl.title,
                        summary,
                    });
                }
            }
        }
    }

    // P3: Semantic snippets (if embeddings configured)
    let max_snippets = if is_compact { 2 } else { 5 };
    let per_snippet_limit = if is_compact { 200 } else { snippet_chars / max_snippets };
    let mut semantic_snippets = Vec::new();

    if !query.is_empty() {
        // Load embedding config
        let config_path = vault.join(".oxidenote").join("embedding_config.json");
        if let Ok(config_data) = std::fs::read_to_string(&config_path) {
            if let Ok(emb_config) = serde_json::from_str::<embeddings::EmbeddingConfig>(&config_data) {
                if !emb_config.api_url.is_empty() {
                    // Embed the query
                    if let Ok(query_embeddings) = embeddings::embed_texts(&emb_config, &[query.clone()]).await {
                        if let Some(query_vec) = query_embeddings.first() {
                            let db_guard = state.read_db.lock();
                            if let Some(conn) = db_guard.as_ref() {
                                if let Ok(results) = db::search_embeddings(conn, query_vec, max_snippets, 0.3) {
                                    for r in results {
                                        // Skip snippets from the current note
                                        if r.path == note_path {
                                            continue;
                                        }
                                        semantic_snippets.push(SemanticSnippet {
                                            source: r.path,
                                            text: truncate_chars(&r.snippet, per_snippet_limit),
                                            score: r.score as f64,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(ChatContext {
        current_note,
        backlink_summaries,
        semantic_snippets,
        referenced_notes,
        is_compact,
        context_window: ctx_window,
        rag_budget_tokens,
    })
}

// ── Model listing ───────────────────────────────────────────

/// Ollama /api/tags response
#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaTagModel>,
}

#[derive(Deserialize)]
struct OllamaTagModel {
    name: String,
}

/// OpenAI /v1/models response
#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModel>,
}

#[derive(Deserialize)]
struct OpenAIModel {
    id: String,
}

/// Ollama model detail from /api/show
struct OllamaModelDetail {
    context_window: Option<u32>,
    supports_vision: bool,
}

/// Known Claude models (Anthropic has no models listing API)
const CLAUDE_MODELS: &[(&str, u32)] = &[
    ("claude-sonnet-4-20250514", 200_000),
    ("claude-opus-4-20250514", 200_000),
    ("claude-3-5-sonnet-20241022", 200_000),
    ("claude-3-5-haiku-20241022", 200_000),
    ("claude-3-haiku-20240307", 200_000),
];

/// List available models from the provider API
#[tauri::command]
pub async fn list_models(config: ChatConfig) -> Result<Vec<ModelInfo>, ChatError> {
    match config.provider {
        ChatProvider::Ollama => {
            let url = format!("{}/api/tags", config.api_url.trim_end_matches('/'));
            let resp = reqwest::get(&url).await?.json::<OllamaTagsResponse>().await?;

            // Fetch details in parallel for each model
            let futs: Vec<_> = resp.models.iter().map(|m| {
                let base = config.api_url.clone();
                let name = m.name.clone();
                async move {
                    let detail = get_ollama_model_detail(&base, &name).await.ok();
                    ModelInfo {
                        id: name.clone(),
                        name,
                        context_window: detail.as_ref().and_then(|d| d.context_window),
                        supports_vision: detail.as_ref().map(|d| d.supports_vision).unwrap_or(false),
                        supports_thinking: true,
                    }
                }
            }).collect();

            let models = futures_util::future::join_all(futs).await;
            Ok(models)
        }
        ChatProvider::Claude => {
            Ok(CLAUDE_MODELS.iter().map(|(id, ctx)| ModelInfo {
                id: id.to_string(),
                name: id.to_string(),
                context_window: Some(*ctx),
                supports_vision: true,
                supports_thinking: true,
            }).collect())
        }
        _ => {
            // OpenAI-compatible: GET {base}/models
            let url = format!("{}/models", config.api_url.trim_end_matches('/'));
            let mut req = reqwest::Client::new().get(&url);
            if !config.api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", config.api_key));
            }
            let resp = req.send().await?.json::<OpenAIModelsResponse>().await?;
            Ok(resp.data.into_iter().map(|m| ModelInfo {
                id: m.id.clone(),
                name: m.id,
                context_window: None,
                supports_vision: false,
                supports_thinking: false,
            }).collect())
        }
    }
}

// ── Ollama model detail helpers ─────────────────────────────

/// Fetch Ollama model detail via POST /api/show for GGUF metadata
async fn get_ollama_model_detail(base_url: &str, model: &str) -> Result<OllamaModelDetail, ChatError> {
    let url = format!("{}/api/show", base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let context_window = resp
        .pointer("/model_info/llama.context_length")
        .or_else(|| resp.pointer("/model_info/general.context_length"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    let capabilities = resp
        .get("capabilities")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(OllamaModelDetail {
        context_window,
        supports_vision: capabilities.contains(&"vision".to_string()),
    })
}

/// Get context window for an Ollama model
async fn get_ollama_context_window(base_url: &str, model: &str) -> Option<u32> {
    get_ollama_model_detail(base_url, model)
        .await
        .ok()
        .and_then(|d| d.context_window)
}

// Temperature/thinking/token/utility functions are in crate::llm::client
