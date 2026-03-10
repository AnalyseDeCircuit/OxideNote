//! Agent type definitions — shared across commands, runtime, scheduler, history.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::llm::types::TokenUsage;

// ── Agent kind ──────────────────────────────────────────────

/// The type of agent to run
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    DuplicateDetector,
    OutlineExtractor,
    IndexGenerator,
    DailyReview,
    GraphMaintainer,
    TypstReviewer,
    /// User-defined custom agent (name matches the .md filename stem)
    Custom(String),
}

impl std::fmt::Display for AgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateDetector => write!(f, "duplicate_detector"),
            Self::OutlineExtractor => write!(f, "outline_extractor"),
            Self::IndexGenerator => write!(f, "index_generator"),
            Self::DailyReview => write!(f, "daily_review"),
            Self::GraphMaintainer => write!(f, "graph_maintainer"),
            Self::TypstReviewer => write!(f, "typst_reviewer"),
            Self::Custom(name) => write!(f, "custom:{}", name),
        }
    }
}

// ── Agent status ────────────────────────────────────────────

/// Current status of an agent task
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Planning,
    Executing,
    Paused,
    WaitingApproval,
    Completed,
    Failed,
    Aborted,
}

// ── Plan steps ──────────────────────────────────────────────

/// Status of an individual plan step
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// A single step in the agent's execution plan
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub index: usize,
    pub description: String,
    pub status: StepStatus,
    pub output: Option<String>,
}

// ── Task input ──────────────────────────────────────────────

/// Input for starting an agent task
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub kind: AgentKind,
    /// Target scope: vault-relative path, folder, or None for entire vault
    pub scope: Option<String>,
    /// Agent-specific parameters (e.g. daily review template, output folder)
    #[serde(default)]
    pub params: serde_json::Value,
    /// Whether to apply writes immediately (skip approval)
    #[serde(default)]
    pub auto_apply: bool,
}

// ── Proposed changes ────────────────────────────────────────

/// Type of file change proposed by the agent
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeAction {
    Create,
    Modify,
    Merge,
    AddLink,
}

/// A proposed change to a vault file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedChange {
    /// Vault-relative path
    pub path: String,
    pub action: ChangeAction,
    /// Full content to write (for Create/Modify/Merge)
    pub content: Option<String>,
    /// Human-readable diff for review
    pub diff: Option<String>,
    /// Brief description of the change
    pub description: String,
}

// ── Task result ─────────────────────────────────────────────

/// Result of a completed agent run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub task_id: String,
    pub kind: AgentKind,
    pub status: AgentStatus,
    /// Whether changes were marked for automatic application (no approval needed)
    pub auto_applied: bool,
    /// Original scope from the task input (preserved for history)
    pub scope: Option<String>,
    pub plan_steps: Vec<PlanStep>,
    pub proposed_changes: Vec<ProposedChange>,
    pub summary: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub token_usage: Option<TokenUsage>,
}

// ── Agent run summary (history listing) ─────────────────────

/// Lightweight summary for history listing (no full plan/changes)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunSummary {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub scope: Option<String>,
    pub summary: String,
    pub token_prompt: u32,
    pub token_completion: u32,
    pub started_at: String,
    pub completed_at: Option<String>,
}

/// Full detail for a single agent run (includes plan + changes JSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunDetail {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub scope: Option<String>,
    pub summary: String,
    /// JSON-encoded plan steps
    pub plan_steps: String,
    /// JSON-encoded proposed changes
    pub changes_json: String,
    pub token_prompt: u32,
    pub token_completion: u32,
    pub started_at: String,
    pub completed_at: Option<String>,
}
