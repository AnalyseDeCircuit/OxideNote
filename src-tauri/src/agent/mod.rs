//! Agent workflow — module root.
//!
//! This module implements the agent system for automated note organization:
//! - 5 built-in agents (duplicate detector, outline, index, daily review, graph)
//! - Custom user-defined agents via Markdown files
//! - Scheduler for periodic agent execution
//! - History persistence in chat_db

pub mod commands;
pub mod context;
pub mod custom;
pub mod history;
pub mod runtime;
pub mod scheduler;
pub mod tools;
pub mod types;
