//! LLM HTTP client — request building, retry logic, and non-streaming completion.
//!
//! This module extracts the provider-agnostic HTTP layer from `commands/chat.rs`
//! so that both streaming chat and non-streaming agent workflows can reuse the
//! same request builders, retry logic, and temperature/thinking resolution.

use super::types::*;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("Network error: {0}")]
    Network(String),
    #[error("Provider error: {0}")]
    Provider(String),
    #[error("Request aborted")]
    Aborted,
    #[error("Parse error: {0}")]
    Parse(String),
}

impl From<reqwest::Error> for LlmError {
    fn from(e: reqwest::Error) -> Self {
        LlmError::Network(e.to_string())
    }
}

// ── Request building ────────────────────────────────────────

/// Build the HTTP request based on the provider type.
/// `stream` controls whether to request streaming or complete response.
pub fn build_request(
    client: &reqwest::Client,
    messages: &[ChatMessage],
    config: &ChatConfig,
) -> Result<reqwest::RequestBuilder, LlmError> {
    build_request_with_tools(client, messages, config, true, None)
}

/// Build request with optional tool schemas and streaming control.
/// Used by agents for non-streaming + function calling.
pub fn build_request_with_tools(
    client: &reqwest::Client,
    messages: &[ChatMessage],
    config: &ChatConfig,
    stream: bool,
    tools: Option<&[ToolSchema]>,
) -> Result<reqwest::RequestBuilder, LlmError> {
    match config.provider {
        ChatProvider::Claude => build_claude_request(client, messages, config, stream, tools),
        ChatProvider::Ollama => build_ollama_request(client, messages, config, stream),
        _ => build_openai_request(client, messages, config, stream, tools),
    }
}

/// Build an OpenAI-compatible request (OpenAI, DeepSeek, Gemini, Moonshot, Groq, OpenRouter, Custom)
fn build_openai_request(
    client: &reqwest::Client,
    messages: &[ChatMessage],
    config: &ChatConfig,
    stream: bool,
    tools: Option<&[ToolSchema]>,
) -> Result<reqwest::RequestBuilder, LlmError> {
    let url = format!("{}/chat/completions", config.api_url.trim_end_matches('/'));
    let temperature = resolve_temperature(config);

    let api_messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let content = build_openai_content(m);
            serde_json::json!({
                "role": m.role,
                "content": content,
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "model": &config.model,
        "messages": api_messages,
        "stream": stream,
    });

    // Include usage in stream mode
    if stream {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }

    if let Some(temp) = temperature {
        body["temperature"] = serde_json::json!(temp);
    }

    // OpenAI o-series reasoning models require max_completion_tokens;
    // the legacy max_tokens param is rejected for o1/o3/o4 models.
    // They also reject the temperature parameter (only accept 1 or omit).
    if config.provider == ChatProvider::OpenAI {
        let ml = config.model.to_lowercase();
        if ml.starts_with("o1") || ml.starts_with("o3") || ml.starts_with("o4") {
            body["max_completion_tokens"] = serde_json::json!(config.max_tokens);
            if let Some(obj) = body.as_object_mut() {
                obj.remove("temperature");
            }
        } else {
            body["max_tokens"] = serde_json::json!(config.max_tokens);
        }
    } else {
        body["max_tokens"] = serde_json::json!(config.max_tokens);
    }

    // Apply thinking mode patches per provider
    apply_thinking_patch(&mut body, config);

    // Native function calling: attach tool schemas
    if let Some(tool_schemas) = tools {
        if !tool_schemas.is_empty() {
            let tools_json: Vec<serde_json::Value> = tool_schemas
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": &t.name,
                            "description": &t.description,
                            "parameters": &t.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = serde_json::json!(tools_json);
        }
    }

    let mut req = client.post(&url).json(&body);

    if !config.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", config.api_key));
    }

    Ok(req)
}

/// Build a Claude (Anthropic) request with separated system prompt
fn build_claude_request(
    client: &reqwest::Client,
    messages: &[ChatMessage],
    config: &ChatConfig,
    stream: bool,
    tools: Option<&[ToolSchema]>,
) -> Result<reqwest::RequestBuilder, LlmError> {
    let url = format!("{}/v1/messages", config.api_url.trim_end_matches('/'));
    let temperature = resolve_temperature(config);

    // Claude: system prompt is top-level, not in messages
    let system_text = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let api_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let content = build_claude_content(m);
            serde_json::json!({
                "role": m.role,
                "content": content,
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "model": &config.model,
        "messages": api_messages,
        "max_tokens": config.max_tokens,
        "stream": stream,
    });

    if !system_text.is_empty() {
        body["system"] = serde_json::json!(system_text);
    }

    if let Some(temp) = temperature {
        body["temperature"] = serde_json::json!(temp);
    }

    // Claude thinking mode
    if should_enable_thinking(config) {
        body["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": config.max_tokens.max(1024)
        });
    }

    // Claude native tool use
    if let Some(tool_schemas) = tools {
        if !tool_schemas.is_empty() {
            let tools_json: Vec<serde_json::Value> = tool_schemas
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": &t.name,
                        "description": &t.description,
                        "input_schema": &t.parameters,
                    })
                })
                .collect();
            body["tools"] = serde_json::json!(tools_json);
        }
    }

    let req = client
        .post(&url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body);

    Ok(req)
}

/// Build an Ollama request (JSON lines streaming)
fn build_ollama_request(
    client: &reqwest::Client,
    messages: &[ChatMessage],
    config: &ChatConfig,
    stream: bool,
) -> Result<reqwest::RequestBuilder, LlmError> {
    let url = format!("{}/api/chat", config.api_url.trim_end_matches('/'));
    let temperature = resolve_temperature(config);

    let api_messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| build_ollama_message(m))
        .collect();

    let mut body = serde_json::json!({
        "model": &config.model,
        "messages": api_messages,
        "stream": stream,
    });

    if let Some(temp) = temperature {
        body["options"] = serde_json::json!({ "temperature": temp });
    }

    if should_enable_thinking(config) {
        body["think"] = serde_json::json!(true);
    }

    let req = client.post(&url).json(&body);
    Ok(req)
}

// ── Multimodal content builders ─────────────────────────────

/// Build OpenAI `content` field — text or multimodal array
pub fn build_openai_content(msg: &ChatMessage) -> serde_json::Value {
    if let Some(images) = &msg.images {
        if !images.is_empty() {
            let mut parts = vec![serde_json::json!({"type": "text", "text": &msg.content})];
            for img in images {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.media_type, img.data)
                    }
                }));
            }
            return serde_json::json!(parts);
        }
    }
    serde_json::json!(&msg.content)
}

/// Build Claude `content` field — text or multimodal array
pub fn build_claude_content(msg: &ChatMessage) -> serde_json::Value {
    if let Some(images) = &msg.images {
        if !images.is_empty() {
            let mut parts = vec![serde_json::json!({"type": "text", "text": &msg.content})];
            for img in images {
                parts.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": &img.media_type,
                        "data": &img.data
                    }
                }));
            }
            return serde_json::json!(parts);
        }
    }
    serde_json::json!(&msg.content)
}

/// Build Ollama message object — includes base64 images array
pub fn build_ollama_message(msg: &ChatMessage) -> serde_json::Value {
    let mut obj = serde_json::json!({"role": &msg.role, "content": &msg.content});
    if let Some(images) = &msg.images {
        if !images.is_empty() {
            let b64_list: Vec<&str> = images.iter().map(|i| i.data.as_str()).collect();
            obj["images"] = serde_json::json!(b64_list);
        }
    }
    obj
}

// ── Send with retry ─────────────────────────────────────────

/// Send HTTP request with retry logic (max 2 retries for 5xx/429).
/// Accepts pre-built messages and config; builds the request internally.
pub async fn send_with_retry(
    messages: &[ChatMessage],
    config: &ChatConfig,
) -> Result<reqwest::Response, LlmError> {
    send_with_retry_opts(messages, config, true, None).await
}

/// Send with retry — full options variant for agents.
/// `stream`: whether to request streaming.
/// `tools`: optional tool schemas for function calling.
pub async fn send_with_retry_opts(
    messages: &[ChatMessage],
    config: &ChatConfig,
    stream: bool,
    tools: Option<&[ToolSchema]>,
) -> Result<reqwest::Response, LlmError> {
    let client = reqwest::Client::new();
    let max_retries = 2u32;

    for attempt in 0..=max_retries {
        let request = build_request_with_tools(&client, messages, config, stream, tools)?;
        match request.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return Ok(resp);
                }
                // Retry on 5xx or 429 (rate limit)
                if (status.is_server_error() || status.as_u16() == 429) && attempt < max_retries {
                    let delay = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .map(|s| std::time::Duration::from_secs(s.min(10)))
                        .unwrap_or(std::time::Duration::from_secs(1));
                    tokio::time::sleep(delay).await;
                    continue;
                }
                let body = resp.text().await.unwrap_or_default();
                return Err(LlmError::Provider(format!("HTTP {}: {}", status.as_u16(), body)));
            }
            Err(e) => {
                if attempt < max_retries {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
                return Err(LlmError::Network(e.to_string()));
            }
        }
    }
    // Unreachable: loop always returns within max_retries+1 iterations
    Err(LlmError::Network("max retries exhausted".into()))
}

// ── Non-streaming completion ────────────────────────────────

/// Non-streaming LLM completion for agent workflows.
/// Returns the full response text + token usage + any tool calls.
///
/// Respects abort signal: checks `abort_rx` before and after the HTTP call.
pub async fn call_llm_complete(
    config: &ChatConfig,
    messages: Vec<ChatMessage>,
    tools: Option<&[ToolSchema]>,
    abort_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<LlmResponse, LlmError> {
    // Check abort before sending
    if *abort_rx.borrow() {
        return Err(LlmError::Aborted);
    }

    let response = send_with_retry_opts(&messages, config, false, tools).await?;

    // Check abort after receiving
    if *abort_rx.borrow() {
        return Err(LlmError::Aborted);
    }

    let body = response.text().await.map_err(|e| LlmError::Network(e.to_string()))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| LlmError::Parse(e.to_string()))?;

    // Parse response based on provider
    match config.provider {
        ChatProvider::Claude => parse_claude_complete(&json),
        ChatProvider::Ollama => parse_ollama_complete(&json),
        _ => parse_openai_complete(&json),
    }
}

/// Parse a non-streaming OpenAI-compatible response
fn parse_openai_complete(json: &serde_json::Value) -> Result<LlmResponse, LlmError> {
    let choice = json
        .pointer("/choices/0")
        .ok_or_else(|| LlmError::Parse("No choices in response".into()))?;

    let message = choice.get("message").ok_or_else(|| LlmError::Parse("No message".into()))?;

    let content = message
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Extract native tool calls
    let mut tool_calls = Vec::new();
    if let Some(tcs) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tcs {
            if let Some(func) = tc.get("function") {
                let name = func
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_str = func
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}");
                let args = serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
                tool_calls.push(ToolCall { tool: name, args });
            }
        }
    }

    // If no native tool calls, try XML fallback
    if tool_calls.is_empty() {
        tool_calls = parse_xml_tool_calls(&content);
    }

    let usage = parse_openai_usage(json);

    Ok(LlmResponse {
        content,
        usage,
        tool_calls,
    })
}

/// Parse a non-streaming Claude response
fn parse_claude_complete(json: &serde_json::Value) -> Result<LlmResponse, LlmError> {
    let mut content = String::new();
    let mut tool_calls = Vec::new();

    // Claude returns content as array of blocks
    if let Some(blocks) = json.get("content").and_then(|v| v.as_array()) {
        for block in blocks {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        content.push_str(text);
                    }
                }
                "tool_use" => {
                    let name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = block
                        .get("input")
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    tool_calls.push(ToolCall { tool: name, args });
                }
                _ => {}
            }
        }
    }

    // XML fallback if no native tool calls
    if tool_calls.is_empty() {
        tool_calls = parse_xml_tool_calls(&content);
    }

    // Claude usage format
    let usage = if let Some(u) = json.get("usage") {
        let input = u
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let output = u
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        TokenUsage {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
        }
    } else {
        TokenUsage::default()
    };

    Ok(LlmResponse {
        content,
        usage,
        tool_calls,
    })
}

/// Parse a non-streaming Ollama response
fn parse_ollama_complete(json: &serde_json::Value) -> Result<LlmResponse, LlmError> {
    let content = json
        .pointer("/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let prompt_tokens = json
        .get("prompt_eval_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let completion_tokens = json
        .get("eval_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let usage = TokenUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    };

    // Ollama doesn't support native function calling — XML fallback only
    let tool_calls = parse_xml_tool_calls(&content);

    Ok(LlmResponse {
        content,
        usage,
        tool_calls,
    })
}

/// Extract OpenAI-format usage from response JSON
fn parse_openai_usage(json: &serde_json::Value) -> TokenUsage {
    if let Some(u) = json.get("usage") {
        let prompt = u
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let completion = u
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        TokenUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
        }
    } else {
        TokenUsage::default()
    }
}

// ── XML tool call fallback ──────────────────────────────────

/// Parse XML-wrapped tool calls from LLM text output.
/// Fallback for providers without native function calling (e.g. Ollama).
///
/// Expected format:
/// ```text
/// <tool_call>
/// {"tool": "vault_read", "args": {"path": "notes/example.md"}}
/// </tool_call>
/// ```
fn parse_xml_tool_calls(content: &str) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    let mut remaining = content;

    while let Some(start) = remaining.find("<tool_call>") {
        let after_tag = &remaining[start + "<tool_call>".len()..];
        if let Some(end) = after_tag.find("</tool_call>") {
            let json_str = after_tag[..end].trim();
            if let Ok(parsed) = serde_json::from_str::<ToolCall>(json_str) {
                calls.push(parsed);
            } else {
                tracing::warn!("Failed to parse XML tool call: {}", json_str);
            }
            remaining = &after_tag[end + "</tool_call>".len()..];
        } else {
            break;
        }
    }

    calls
}

// ── Temperature & thinking mode helpers ─────────────────────

/// Resolve temperature: user override > model-aware default
pub fn resolve_temperature(config: &ChatConfig) -> Option<f64> {
    if let Some(temp) = config.temperature {
        return Some(temp);
    }

    let model = config.model.to_lowercase();

    // Moonshot K2.5 and K2-thinking models require fixed temperature=1.0
    // (other Kimi models like kimi-k2-turbo default to 0.6 via provider)
    if config.provider == ChatProvider::Moonshot
        && contains_any(&model, &["k2.5", "k2-thinking"])
    {
        return Some(1.0);
    }

    // Reasoning models default to 1.0
    if contains_any(&model, &["o1", "o3", "o4", "deepseek-reasoner", "r1"]) {
        return Some(1.0);
    }

    // Code models lower temperature
    if contains_any(&model, &["code", "codestral", "starcoder"]) {
        return Some(0.2);
    }

    // Flash/mini models
    if contains_any(&model, &["flash", "mini", "haiku"]) {
        return Some(0.6);
    }

    // Default: let the provider decide
    None
}

/// Whether thinking/reasoning mode should be enabled
pub fn should_enable_thinking(config: &ChatConfig) -> bool {
    match config.thinking_mode {
        ThinkingMode::Thinking => true,
        ThinkingMode::Instant => false,
        ThinkingMode::Auto => {
            let model = config.model.to_lowercase();
            contains_any(
                &model,
                &["o1", "o3", "o4", "r1", "reasoner", "k2.5", "thinking", "think"],
            )
        }
    }
}

/// Apply provider-specific thinking mode patches to the request body.
/// Handles both enabling and disabling thinking for providers that require
/// explicit control (e.g. K2.5 defaults to thinking-on and needs explicit disable).
pub fn apply_thinking_patch(body: &mut serde_json::Value, config: &ChatConfig) {
    let enabled = should_enable_thinking(config);

    match config.provider {
        ChatProvider::Moonshot => {
            let model = config.model.to_lowercase();
            if model.contains("k2.5") {
                // K2.5: explicit thinking control (defaults to enabled on server)
                if enabled {
                    body["thinking"] = serde_json::json!({ "type": "enabled" });
                } else {
                    body["thinking"] = serde_json::json!({ "type": "disabled" });
                }
                // K2.5 API enforces fixed temperature=1.0 and top_p=0.95;
                // intentionally overrides user preference per API spec.
                body["temperature"] = serde_json::json!(1.0);
                body["top_p"] = serde_json::json!(0.95);
            }
            // kimi-k2-thinking models: reasoning is automatic, no patch needed
        }
        ChatProvider::DeepSeek => {
            // DeepSeek: thinking param only supported by reasoner/R1 models,
            // not by deepseek-chat (V3).
            if enabled {
                let model = config.model.to_lowercase();
                if contains_any(&model, &["r1", "reasoner"]) {
                    body["thinking"] = serde_json::json!({ "type": "enabled" });
                }
            }
        }
        ChatProvider::OpenRouter => {
            // OpenRouter: reasoning handled by per-model routing
        }
        _ => {}
    }
}

/// Check if a string contains any of the given patterns
pub fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

// ── Context window fallback ─────────────────────────────────

/// Static fallback table for providers that don't expose context window via API.
pub fn fallback_context_window(model: &str) -> u32 {
    let m = model.to_lowercase();
    match () {
        // OpenAI
        _ if m.starts_with("gpt-5") => 400_000,
        _ if m.starts_with("gpt-4.1") || m.starts_with("gpt-4-1") => 1_047_576,
        _ if m.starts_with("gpt-4o") || m.starts_with("gpt-4-turbo") => 128_000,
        _ if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") => 200_000,
        // Anthropic
        _ if m.contains("claude") => 200_000,
        // DeepSeek
        _ if m.contains("deepseek") => 128_000,
        // Google Gemini
        _ if m.contains("gemini-3") || m.contains("gemini-2") => 1_000_000,
        _ if m.contains("gemini-1.5") => 1_048_576,
        _ if m.contains("gemini") => 32_768,
        // Moonshot / Kimi (K2.5 has 256k, K2 non-thinking has 128k)
        _ if m.contains("k2.5") => 256_000,
        _ if m.contains("kimi") || m.contains("moonshot") => 128_000,
        // Meta Llama
        _ if m.contains("llama-4") || m.contains("llama4") => 131_072,
        _ if m.contains("llama-3") || m.contains("llama3") => 128_000,
        // Alibaba Qwen
        _ if m.contains("qwen3") || m.contains("qwen-3") => 131_072,
        _ if m.contains("qwen2") || m.contains("qwen-2") => 131_072,
        // Mistral
        _ if m.contains("mistral") || m.contains("mixtral") => 128_000,
        // Microsoft Phi
        _ if m.contains("phi-4") || m.contains("phi4") => 128_000,
        // Cohere
        _ if m.contains("command-r") => 128_000,
        _ => 8_192,
    }
}

// ── Token estimation ────────────────────────────────────────

/// Rough token estimate: ~1 token per 3.5 chars for English,
/// ~1 token per 1.5 chars for CJK. Uses a blended heuristic.
pub fn estimate_tokens(text: &str) -> u32 {
    let cjk_count = text.chars().filter(|c| is_cjk(*c)).count();
    let other_count = text.chars().count() - cjk_count;
    ((cjk_count as f64 / 1.5) + (other_count as f64 / 3.5)).ceil() as u32
}

/// Check if a character is CJK (Chinese/Japanese/Korean)
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{3000}'..='\u{303F}'
        | '\u{FF00}'..='\u{FFEF}'
        | '\u{AC00}'..='\u{D7AF}'
    )
}

// ── Utility ─────────────────────────────────────────────────

/// Truncate a string to at most `max_chars` characters (char-safe)
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        text.to_string()
    } else {
        chars[..max_chars].iter().collect()
    }
}
