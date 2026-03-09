//! Agent runtime — the core plan→execute→verify loop.
//!
//! Each agent run follows:
//! 1. Build vault context
//! 2. Ask LLM to produce a plan
//! 3. Execute each step (with tool calls)
//! 4. Generate summary
//!
//! The runtime supports abort via `watch::Receiver<bool>`, doom loop detection,
//! context compaction, and write buffering.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use super::context::build_agent_context;
use super::tools::execute_tool;
use super::types::*;
use crate::llm::client::{call_llm_complete, LlmError};
use crate::llm::function_calling::build_vault_tool_schemas;
use crate::llm::types::{ChatConfig, ChatMessage, TokenUsage};

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("No vault opened")]
    NoVault,
    #[error("No index available")]
    NoIndex,
    #[error("LLM error: {0}")]
    Llm(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Agent aborted")]
    Aborted,
    #[error("Doom loop detected — agent is repeating the same actions")]
    DoomLoop,
    #[error("Internal: {0}")]
    Internal(String),
}

impl serde::Serialize for AgentError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<LlmError> for AgentError {
    fn from(e: LlmError) -> Self {
        match e {
            LlmError::Aborted => AgentError::Aborted,
            other => AgentError::Llm(other.to_string()),
        }
    }
}

// ── Progress events ─────────────────────────────────────────

/// Emit a progress event to the frontend
fn emit_progress(app: &AppHandle, task_id: &str, status: &AgentStatus, message: &str) {
    let _ = app.emit(
        "agent-progress",
        serde_json::json!({
            "task_id": task_id,
            "status": status,
            "message": message,
        }),
    );
}

/// Emit step-level progress
fn emit_step_progress(app: &AppHandle, task_id: &str, step: &PlanStep) {
    let _ = app.emit(
        "agent-progress",
        serde_json::json!({
            "task_id": task_id,
            "status": "executing",
            "step_index": step.index,
            "step_description": step.description,
            "step_status": step.status,
        }),
    );
}

// ── Main runtime loop ───────────────────────────────────────

/// Block execution while the pause signal is active.
/// Uses `tokio::select!` to concurrently await both pause and abort
/// channels, preventing deadlock if abort is signaled while paused.
async fn wait_if_paused(
    pause_rx: &mut tokio::sync::watch::Receiver<bool>,
    abort_rx: &mut tokio::sync::watch::Receiver<bool>,
    app: &AppHandle,
    task_id: &str,
) -> Result<(), AgentError> {
    if !*pause_rx.borrow() {
        return Ok(());
    }
    emit_progress(app, task_id, &AgentStatus::Paused, "Paused");
    loop {
        if *abort_rx.borrow() {
            return Err(AgentError::Aborted);
        }
        // Wait for either channel to change
        tokio::select! {
            res = pause_rx.changed() => {
                if res.is_err() {
                    // Sender dropped — treat as abort
                    return Err(AgentError::Aborted);
                }
                if !*pause_rx.borrow() {
                    emit_progress(app, task_id, &AgentStatus::Executing, "Resumed");
                    return Ok(());
                }
                // Still paused — continue loop
            }
            res = abort_rx.changed() => {
                if res.is_err() || *abort_rx.borrow() {
                    return Err(AgentError::Aborted);
                }
            }
        }
    }
}

/// Core agent execution loop.
///
/// Follows the plan→execute→verify pattern:
/// 1. Build context from vault metadata + scope
/// 2. Ask LLM to produce a numbered plan
/// 3. Execute each step with tool schemas for function calling
/// 4. Detect doom loops (repeated identical tool calls)
/// 5. Generate final summary
pub async fn run_agent(
    task: AgentTask,
    config: &ChatConfig,
    vault_path: &Path,
    db: Arc<Mutex<Option<Connection>>>,
    read_db: Arc<Mutex<Option<Connection>>>,
    app: &AppHandle,
    mut abort_rx: tokio::sync::watch::Receiver<bool>,
    mut pause_rx: tokio::sync::watch::Receiver<bool>,
    allowed_tools: Vec<String>,
    system_prompt_override: Option<String>,
    max_writes: u8,
    task_id: String,
) -> Result<TaskResult, AgentError> {
    let started_at = Utc::now();
    let mut total_usage = TokenUsage::default();

    // Phase 1: Build context
    emit_progress(app, &task_id, &AgentStatus::Planning, "Building context...");
    let context = build_agent_context(&task, vault_path, &read_db)
        .await
        .map_err(|e| AgentError::Internal(e))?;

    // Phase 2: Planning — ask LLM to produce a plan
    let system_prompt = system_prompt_override
        .unwrap_or_else(|| build_system_prompt(&task, &context.vault_summary));

    let plan_messages = vec![
        ChatMessage {
            role: "system".into(),
            content: system_prompt,
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: build_plan_request(&task, &context.relevant_notes),
            reasoning: None,
            images: None,
        },
    ];

    let plan_response = call_llm_complete(config, plan_messages, None, &mut abort_rx).await?;
    total_usage += plan_response.usage;

    let mut steps = parse_plan(&plan_response.content);
    if steps.is_empty() {
        // If LLM didn't produce a structured plan, create a single step
        steps.push(PlanStep {
            index: 0,
            description: "Execute task".into(),
            status: StepStatus::Pending,
            output: None,
        });
    }

    // Cap plan steps to prevent unbounded LLM calls
    const MAX_PLAN_STEPS: usize = 15;
    if steps.len() > MAX_PLAN_STEPS {
        steps.truncate(MAX_PLAN_STEPS);
    }

    emit_progress(
        app,
        &task_id,
        &AgentStatus::Executing,
        &format!("Plan: {} steps", steps.len()),
    );

    // Phase 3: Execute steps
    let pending_writes: Arc<Mutex<Vec<ProposedChange>>> = Arc::new(Mutex::new(Vec::new()));
    let mut doom_detector: VecDeque<String> = VecDeque::with_capacity(13);
    let mut accumulated_context = context.relevant_notes.clone();

    // Build tool schemas filtered by allowed tools
    let tool_schemas = build_vault_tool_schemas(&allowed_tools);

    for step in &mut steps {
        // Check abort
        if *abort_rx.borrow() {
            return Ok(build_aborted_result(
                task_id,
                task.kind,
                steps,
                started_at,
                total_usage,
            ));
        }

        // Wait if paused (also checks abort while waiting)
        wait_if_paused(&mut pause_rx, &mut abort_rx, app, &task_id).await?;

        step.status = StepStatus::InProgress;
        emit_step_progress(app, &task_id, step);

        // Ask LLM to execute this step
        let exec_messages = build_step_messages(step, &accumulated_context, &context.vault_summary);
        let response = call_llm_complete(
            config,
            exec_messages,
            Some(&tool_schemas),
            &mut abort_rx,
        )
        .await?;
        total_usage += response.usage;

        // Extract tool calls
        let tool_calls = response.tool_calls;

        // Doom loop detection: track last 12 hashes, check for repetition
        if !tool_calls.is_empty() {
            let call_hash = hash_tool_calls(&tool_calls);
            doom_detector.push_back(call_hash);
            if doom_detector.len() > 12 {
                doom_detector.pop_front();
            }
            if detect_doom_loop(&doom_detector) {
                return Err(AgentError::DoomLoop);
            }
        }

        // Execute tool calls
        for tc in &tool_calls {
            match execute_tool(
                tc,
                vault_path,
                &read_db,
                &pending_writes,
                task.auto_apply,
                &db,
                max_writes,
            )
            .await
            {
                Ok(result) => {
                    // Cap individual tool results to prevent context explosion
                    let capped = if result.len() > 2000 {
                        let boundary = result.floor_char_boundary(2000);
                        format!("{}... (truncated)", &result[..boundary])
                    } else {
                        result
                    };
                    accumulated_context
                        .push_str(&format!("\n[Tool: {}] {}\n", tc.tool, capped));
                }
                Err(e) => {
                    accumulated_context
                        .push_str(&format!("\n[Tool: {} ERROR] {}\n", tc.tool, e));
                }
            }
        }

        // Compact accumulated context if it exceeds budget (8000 chars)
        // Drop oldest entries to stay within budget
        if accumulated_context.len() > 8000 {
            let excess = accumulated_context.floor_char_boundary(accumulated_context.len() - 6000);
            if let Some(pos) = accumulated_context[excess..].find("\n[Tool:") {
                accumulated_context = format!(
                    "(earlier context compacted)\n{}",
                    &accumulated_context[excess + pos..]
                );
            } else {
                // Fallback: simple truncation at a safe char boundary
                let safe_end = accumulated_context.floor_char_boundary(8000);
                accumulated_context.truncate(safe_end);
            }
        }

        step.status = StepStatus::Completed;
        step.output = Some(response.content);
        emit_step_progress(app, &task_id, step);
    }

    // Phase 4: Extract proposed changes
    let proposed_changes = Arc::try_unwrap(pending_writes)
        .map(|m| m.into_inner())
        .unwrap_or_else(|arc| arc.lock().clone());

    // Phase 5: Generate summary
    let summary = generate_summary(config, &steps, &proposed_changes, &mut abort_rx)
        .await
        .unwrap_or_else(|_| "Agent completed.".into());

    // Emit completion event
    let _ = app.emit(
        "agent-complete",
        serde_json::json!({
            "task_id": &task_id,
            "summary": &summary,
            "changes_count": proposed_changes.len(),
        }),
    );

    Ok(TaskResult {
        task_id,
        kind: task.kind,
        status: if proposed_changes.is_empty() || task.auto_apply {
            AgentStatus::Completed
        } else {
            AgentStatus::WaitingApproval
        },
        scope: task.scope,
        plan_steps: steps,
        proposed_changes,
        summary,
        started_at,
        completed_at: Some(Utc::now()),
        token_usage: Some(total_usage),
    })
}

// ── Prompt builders ─────────────────────────────────────────

/// Build the system prompt for the agent
fn build_system_prompt(task: &AgentTask, vault_summary: &str) -> String {
    let agent_instruction = match &task.kind {
        AgentKind::DuplicateDetector => {
            "Find semantically similar or duplicate notes and suggest merges. \
             For each duplicate pair, produce a merged version preserving all unique content."
        }
        AgentKind::OutlineExtractor => {
            "Generate a structured outline/TOC from the target notes. \
             Extract headings, key points, and create a hierarchical outline with WikiLinks."
        }
        AgentKind::IndexGenerator => {
            "Generate a Map of Content (MOC) / index note that organizes vault notes by topic. \
             Cluster notes by tags and titles, then produce a structured index with WikiLinks."
        }
        AgentKind::DailyReview => {
            "Produce a daily summary of vault activity. Gather notes modified today, \
             new tags, and orphan notes. Generate a review note with highlights and suggestions."
        }
        AgentKind::GraphMaintainer => {
            "Analyze the knowledge graph. Find orphan notes (no links), dead links, \
             hub overload (>30 outlinks), and cluster isolation. Suggest link improvements."
        }
        AgentKind::Custom(_) => {
            // Custom agents provide their own system prompt via override
            "Execute the user-defined task as instructed."
        }
    };

    format!(
        "You are an intelligent note organization agent for a Markdown knowledge vault.\n\n\
         VAULT CONTEXT:\n{vault_summary}\n\n\
         YOUR TASK: {agent_instruction}\n\n\
         AVAILABLE TOOLS:\n\
         - vault_read(path): Read note content\n\
         - vault_search(query): Search notes by keyword\n\
         - vault_list(folder?, filter?): List notes\n\
         - vault_link(path): Get backlinks/outlinks\n\
         - vault_write(path, content): Write/modify note\n\n\
         RULES:\n\
         1. Always use WikiLinks ([[note-name]]) when referencing notes\n\
         2. Preserve existing frontmatter when modifying notes\n\
         3. Use the vault's existing tag conventions\n\
         4. Output Markdown only\n\
         5. Do not invent information — only organize existing content"
    )
}

/// Request the LLM to produce a numbered plan
fn build_plan_request(task: &AgentTask, relevant_notes: &str) -> String {
    let scope_desc = match task.scope.as_deref() {
        Some(s) if !s.is_empty() => format!("Scope: {}", s),
        _ => "Scope: entire vault".to_string(),
    };

    format!(
        "Based on the vault context and the notes below, produce a numbered PLAN \
         for completing the task. Each step should be a concrete action.\n\n\
         {scope_desc}\n\n\
         NOTES:\n{relevant_notes}\n\n\
         Output format:\n\
         PLAN:\n\
         1. [First step description]\n\
         2. [Second step description]\n\
         ..."
    )
}

/// Build messages for executing a single plan step
fn build_step_messages(
    step: &PlanStep,
    accumulated_context: &str,
    vault_summary: &str,
) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system".into(),
            content: format!(
                "You are executing step {} of an agent plan.\n\n\
                 VAULT CONTEXT:\n{vault_summary}\n\n\
                 ACCUMULATED RESULTS:\n{accumulated_context}",
                step.index + 1
            ),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: format!(
                "Execute this step: {}\n\n\
                 Use the available tools to complete this step. \
                 Call tools as needed, then summarize what was accomplished.",
                step.description
            ),
            reasoning: None,
            images: None,
        },
    ]
}

// ── Plan parsing ────────────────────────────────────────────

/// Parse a numbered plan from LLM output
fn parse_plan(content: &str) -> Vec<PlanStep> {
    let mut steps = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        // Match lines like "1. Do something" or "1) Do something"
        if let Some(rest) = try_parse_numbered_line(trimmed) {
            if !rest.is_empty() {
                steps.push(PlanStep {
                    index: steps.len(),
                    description: rest.to_string(),
                    status: StepStatus::Pending,
                    output: None,
                });
            }
        }
    }

    steps
}

/// Try to parse "N. text" or "N) text" from a line
fn try_parse_numbered_line(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut i = 0;

    // Skip leading digits
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }

    // Must have at least one digit
    if i == 0 {
        return None;
    }

    // Must be followed by '.' or ')' then whitespace
    if i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b')') {
        let rest = &line[i + 1..];
        Some(rest.trim_start())
    } else {
        None
    }
}

// ── Doom loop detection ─────────────────────────────────────

/// Hash tool calls for doom loop detection
fn hash_tool_calls(calls: &[crate::llm::types::ToolCall]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    for tc in calls {
        tc.tool.hash(&mut hasher);
        tc.args.to_string().hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

/// Detect doom loops: 3 identical consecutive hashes, or A-B alternating pattern
fn detect_doom_loop(hashes: &VecDeque<String>) -> bool {
    let len = hashes.len();

    // 3 identical in a row
    if len >= 3 {
        let last = &hashes[len - 1];
        if &hashes[len - 2] == last && &hashes[len - 3] == last {
            return true;
        }
    }

    // A-B alternating pattern (at least 4 entries)
    if len >= 4 {
        let a = &hashes[len - 1];
        let b = &hashes[len - 2];
        if a != b && &hashes[len - 3] == a && &hashes[len - 4] == b {
            return true;
        }
    }

    false
}

// ── Summary generation ──────────────────────────────────────

/// Ask the LLM to generate a summary of the completed run
async fn generate_summary(
    config: &ChatConfig,
    steps: &[PlanStep],
    proposed_changes: &[ProposedChange],
    abort_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, AgentError> {
    let steps_summary: String = steps
        .iter()
        .map(|s| {
            format!(
                "{}. {} — {:?}",
                s.index + 1,
                s.description,
                s.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let changes_summary: String = proposed_changes
        .iter()
        .map(|c| format!("- {:?} {}: {}", c.action, c.path, c.description))
        .collect::<Vec<_>>()
        .join("\n");

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: "You are a concise summarizer. Summarize the agent run in 2-3 sentences.".into(),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: format!(
                "Steps completed:\n{steps_summary}\n\n\
                 Proposed changes:\n{changes_summary}\n\n\
                 Provide a brief summary of what was accomplished."
            ),
            reasoning: None,
            images: None,
        },
    ];

    let response = call_llm_complete(config, messages, None, abort_rx).await?;
    Ok(response.content)
}

// ── Helper: build aborted result ────────────────────────────

fn build_aborted_result(
    task_id: String,
    kind: AgentKind,
    steps: Vec<PlanStep>,
    started_at: chrono::DateTime<Utc>,
    total_usage: TokenUsage,
) -> TaskResult {
    TaskResult {
        task_id,
        kind,
        status: AgentStatus::Aborted,
        scope: None,
        plan_steps: steps,
        proposed_changes: vec![],
        summary: "Agent run was aborted by user.".into(),
        started_at,
        completed_at: Some(Utc::now()),
        token_usage: Some(total_usage),
    }
}
