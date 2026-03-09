//! Shared LLM HTTP layer — extracted from chat commands for reuse by agents.
//!
//! This module provides the core building blocks for LLM communication:
//! - Provider-specific request builders (OpenAI, Claude, Ollama)
//! - Retry logic with exponential backoff
//! - Non-streaming completion for agent workflows
//! - Temperature / thinking mode resolution
//! - Context window estimation and token counting

pub mod client;
pub mod function_calling;
pub mod types;

pub use client::{
    build_request, call_llm_complete, send_with_retry,
};
pub use types::{
    ChatConfig, ChatMessage, ChatProvider, ImageAttachment, LlmResponse, ThinkingMode, TokenUsage,
};
