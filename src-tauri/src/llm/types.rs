//! Shared LLM types used by both chat streaming and agent workflows.

use serde::{Deserialize, Serialize};

// ── Provider enum ───────────────────────────────────────────

/// Supported LLM provider variants
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatProvider {
    OpenAI,
    Claude,
    Ollama,
    DeepSeek,
    Gemini,
    Moonshot,
    Groq,
    OpenRouter,
    Custom,
}

// ── Message types ───────────────────────────────────────────

/// A single message in the conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageAttachment>>,
}

/// Base64-encoded image for multimodal input
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub data: String,
    pub media_type: String,
}

// ── Configuration ───────────────────────────────────────────

/// Controls reasoning/thinking behaviour
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingMode {
    Auto,
    Thinking,
    Instant,
}

/// Chat configuration sent from the frontend.
/// Used by both streaming chat and non-streaming agent calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConfig {
    pub provider: ChatProvider,
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default = "default_thinking_mode")]
    pub thinking_mode: ThinkingMode,
}

fn default_max_tokens() -> u32 {
    4096
}
fn default_thinking_mode() -> ThinkingMode {
    ThinkingMode::Auto
}

// ── Token usage ─────────────────────────────────────────────

/// Token usage statistics from the LLM response
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

impl std::ops::AddAssign for TokenUsage {
    fn add_assign(&mut self, rhs: Self) {
        self.prompt_tokens += rhs.prompt_tokens;
        self.completion_tokens += rhs.completion_tokens;
        self.total_tokens += rhs.total_tokens;
    }
}

// ── Non-streaming response ──────────────────────────────────

/// Complete (non-streaming) LLM response for agent workflows
#[derive(Debug, Clone)]
pub struct LlmResponse {
    /// Text content from the LLM
    pub content: String,
    /// Token usage for this call
    pub usage: TokenUsage,
    /// Parsed tool calls (native function calling or XML fallback)
    pub tool_calls: Vec<ToolCall>,
}

/// A single tool call extracted from the LLM response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub args: serde_json::Value,
}

// ── Stream chunk ────────────────────────────────────────────

/// A single streamed chunk emitted to the frontend
#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub request_id: String,
    pub content: String,
    pub reasoning: String,
    pub done: bool,
    pub error: Option<String>,
    pub usage: Option<TokenUsage>,
}

// ── Model info ──────────────────────────────────────────────

/// Information about a single model from provider API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_window: Option<u32>,
    pub supports_vision: bool,
    pub supports_thinking: bool,
}

// ── Tool schema for native function calling ─────────────────

/// JSON Schema description of a tool parameter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParamSchema {
    #[serde(rename = "type")]
    pub param_type: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

/// Schema for a single tool (used with native function calling)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}
