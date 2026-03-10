//! Agent runtime — continuous tool-calling loop.
//!
//! Each agent run follows a single agentic loop:
//! 1. Build vault context
//! 2. Send system prompt + user task to LLM with tool schemas
//! 3. LLM returns text and/or tool_calls
//! 4. Execute tool calls → append assistant + tool result messages → call LLM again
//! 5. Repeat until LLM returns no tool_calls (task complete)
//! 6. Generate summary
//!
//! The runtime supports abort via `watch::Receiver<bool>`, doom loop detection,
//! and write buffering.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use super::context::build_agent_context;
use super::tools::{execute_tool, ToolError};
use crate::commands::typst::FontState;
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
/// Uses a continuous tool-calling loop:
/// 1. Build context from vault metadata + scope
/// 2. Send system prompt + user task to LLM with tool schemas
/// 3. Execute tool calls, append results to conversation
/// 4. Repeat until LLM responds without tool calls (up to MAX_ITERATIONS)
/// 5. Generate final summary
pub async fn run_agent(
    task: AgentTask,
    config: &ChatConfig,
    vault_path: &Path,
    db: Arc<Mutex<Option<Connection>>>,
    read_db: Arc<Mutex<Option<Connection>>>,
    app: &AppHandle,
    abort_rx: tokio::sync::watch::Receiver<bool>,
    pause_rx: tokio::sync::watch::Receiver<bool>,
    allowed_tools: Vec<String>,
    system_prompt_override: Option<String>,
    max_writes: u8,
    task_id: String,
    font_state: Option<Arc<FontState>>,
) -> Result<TaskResult, AgentError> {
    // Wrap the entire run in a global timeout (10 minutes)
    // to prevent indefinite execution from slow LLM responses
    const AGENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
    match tokio::time::timeout(
        AGENT_TIMEOUT,
        run_agent_inner(task, config, vault_path, db, read_db, app, abort_rx, pause_rx,
                        allowed_tools, system_prompt_override, max_writes, task_id, font_state),
    )
    .await
    {
        Ok(result) => result,
        Err(_elapsed) => Err(AgentError::Internal(
            "Agent timed out after 10 minutes".into(),
        )),
    }
}

/// Inner implementation — called within the global timeout wrapper.
async fn run_agent_inner(
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
    font_state: Option<Arc<FontState>>,
) -> Result<TaskResult, AgentError> {
    let started_at = Utc::now();
    let mut total_usage = TokenUsage::default();

    // ── Phase 1: Build context ──────────────────────────────
    emit_progress(app, &task_id, &AgentStatus::Planning, "Building context...");
    let context = build_agent_context(&task, vault_path, &read_db)
        .await
        .map_err(|e| AgentError::Internal(e))?;

    // ── Phase 2: Prepare conversation ───────────────────────
    let system_prompt = system_prompt_override
        .unwrap_or_else(|| build_system_prompt(&task, &context.vault_summary, &allowed_tools));

    let user_content = build_task_message(&task, &context.relevant_notes);

    let mut messages: Vec<ChatMessage> = vec![
        ChatMessage::text("system", &system_prompt),
        ChatMessage::text("user", &user_content),
    ];

    // Build tool schemas filtered by allowed tools
    let tool_schemas = build_vault_tool_schemas(&allowed_tools);
    let pending_writes: Arc<Mutex<Vec<ProposedChange>>> = Arc::new(Mutex::new(Vec::new()));
    let mut doom_detector: VecDeque<String> = VecDeque::with_capacity(13);

    // Track execution steps for the result
    let mut steps: Vec<PlanStep> = Vec::new();

    // Maximum iterations to prevent unbounded execution
    const MAX_ITERATIONS: usize = 30;
    let mut iteration = 0;

    tracing::info!(
        task_id = %task_id,
        kind = ?task.kind,
        max_writes = max_writes,
        tools = ?allowed_tools,
        "Agent run started"
    );

    emit_progress(app, &task_id, &AgentStatus::Executing, "Starting agent...");

    // ── Phase 3: Agentic tool-calling loop ──────────────────
    loop {
        // Enforce iteration cap
        if iteration >= MAX_ITERATIONS {
            tracing::warn!(task_id = %task_id, "Agent hit iteration cap ({MAX_ITERATIONS})");
            break;
        }
        iteration += 1;
        tracing::info!(task_id = %task_id, iteration, "Agent loop iteration start");

        // Check abort
        if *abort_rx.borrow() {
            return Ok(build_aborted_result(
                task_id,
                task.kind,
                task.scope.clone(),
                steps,
                started_at,
                total_usage,
            ));
        }

        // Wait if paused
        wait_if_paused(&mut pause_rx, &mut abort_rx, app, &task_id).await?;

        // Call LLM with the full conversation + tool schemas
        let response = call_llm_complete(
            config,
            &messages,
            Some(&tool_schemas),
            &mut abort_rx,
        )
        .await?;
        total_usage += response.usage.clone();
        tracing::debug!(
            task_id = %task_id,
            iteration,
            prompt_tokens = response.usage.prompt_tokens,
            completion_tokens = response.usage.completion_tokens,
            tool_call_count = response.tool_calls.len(),
            has_reasoning = response.reasoning.is_some(),
            "LLM response received"
        );

        // Stream reasoning/thinking content to frontend if present
        if let Some(ref reasoning) = response.reasoning {
            if !reasoning.is_empty() {
                let preview = if reasoning.len() > 500 {
                    let b = reasoning.floor_char_boundary(500);
                    format!("{}...", &reasoning[..b])
                } else {
                    reasoning.clone()
                };
                emit_progress(app, &task_id, &AgentStatus::Thinking, &preview);
            }
        }

        let tool_calls = &response.tool_calls;

        // If no tool calls, the LLM considers the task done
        if tool_calls.is_empty() {
            // Record the final response as a step
            steps.push(PlanStep {
                index: steps.len(),
                description: "Final response".into(),
                status: StepStatus::Completed,
                output: Some(response.content.clone()),
            });

            // Add the final assistant message (for completeness)
            messages.push(ChatMessage::text("assistant", &response.content));
            break;
        }

        // Doom loop detection: track recent tool call hashes
        let call_hash = hash_tool_calls(tool_calls);
        doom_detector.push_back(call_hash);
        if doom_detector.len() > 12 {
            doom_detector.pop_front();
        }
        if detect_doom_loop(&doom_detector) {
            tracing::warn!(task_id = %task_id, iteration, "Doom loop detected — aborting agent");
            return Err(AgentError::DoomLoop);
        }

        // Append the assistant message (with tool_calls) to conversation history.
        // Preserve reasoning for providers that require it on round-trip (e.g. K2.5).
        messages.push(ChatMessage::assistant_with_tools(
            &response.content,
            response.tool_calls.clone(),
            response.reasoning.clone(),
        ));

        // Execute tool calls — read-only tools in parallel, writes sequentially.
        // Results are always appended in original call order for LLM consistency.
        let tool_results = execute_tools_partitioned(
            tool_calls,
            vault_path,
            &read_db,
            &pending_writes,
            task.auto_apply,
            &db,
            max_writes,
            font_state.clone(),
            &task_id,
        )
        .await;

        for (tc, result) in tool_calls.iter().zip(tool_results.into_iter()) {
            let step_desc = format!("{}({})", tc.tool, summarize_args(&tc.args));

            emit_progress(
                app,
                &task_id,
                &AgentStatus::Executing,
                &format!("Step {} — {}", steps.len() + 1, step_desc),
            );

            // Append tool result message with the matching call ID
            messages.push(ChatMessage::tool_result(&tc.id, &result));

            // Record as a step for UI progress
            steps.push(PlanStep {
                index: steps.len(),
                description: step_desc,
                status: StepStatus::Completed,
                output: Some(if result.len() > 200 {
                    let boundary = result.floor_char_boundary(200);
                    format!("{}...", &result[..boundary])
                } else {
                    result
                }),
            });
        }

        // Compact conversation if message count is excessive
        // Keep system prompt + last N messages to stay within context budget
        let pre_compact_len = messages.len();
        compact_messages(&mut messages, config.context_window);
        if messages.len() < pre_compact_len {
            tracing::info!(
                task_id = %task_id,
                removed = pre_compact_len - messages.len(),
                remaining = messages.len(),
                "Conversation compacted"
            );
        }
    }

    // ── Phase 4: Extract proposed changes ───────────────────
    let proposed_changes = Arc::try_unwrap(pending_writes)
        .map(|m| m.into_inner())
        .unwrap_or_else(|arc| arc.lock().clone());

    // ── Phase 5: Generate summary ───────────────────────────
    let summary = generate_summary(config, &steps, &proposed_changes, &mut abort_rx)
        .await
        .unwrap_or_else(|_| "Agent completed.".into());

    let auto_applied = !proposed_changes.is_empty() && task.auto_apply;

    tracing::info!(
        task_id = %task_id,
        iterations = iteration,
        steps = steps.len(),
        proposed_changes = proposed_changes.len(),
        total_prompt_tokens = total_usage.prompt_tokens,
        total_completion_tokens = total_usage.completion_tokens,
        auto_applied,
        "Agent run completed"
    );

    Ok(TaskResult {
        task_id,
        kind: task.kind,
        status: if proposed_changes.is_empty() || task.auto_apply {
            AgentStatus::Completed
        } else {
            AgentStatus::WaitingApproval
        },
        auto_applied,
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
fn build_system_prompt(task: &AgentTask, vault_summary: &str, allowed_tools: &[String]) -> String {
    // Inject current date/time so time-sensitive tasks (e.g. DailyReview) can reason about "today"
    let now = chrono::Local::now();
    let datetime_str = now.format("%Y-%m-%d %H:%M (%A)").to_string();

    let agent_instruction = match &task.kind {
        AgentKind::DuplicateDetector => {
            "Find semantically similar or duplicate notes and suggest merges. \
             For each duplicate pair, produce a merged version preserving all unique content."
                .to_string()
        }
        AgentKind::OutlineExtractor => {
            "Generate a structured outline/TOC from the target notes. \
             Extract headings, key points, and create a hierarchical outline with WikiLinks."
                .to_string()
        }
        AgentKind::IndexGenerator => {
            "Generate a Map of Content (MOC) / index note that organizes vault notes by topic. \
             Cluster notes by tags and titles, then produce a structured index with WikiLinks."
                .to_string()
        }
        AgentKind::DailyReview => {
            // Extract output_folder and template from params
            let output_folder = task
                .params
                .get("output_folder")
                .and_then(|v| v.as_str())
                .unwrap_or("daily");
            let template = task
                .params
                .get("template")
                .and_then(|v| v.as_str())
                .unwrap_or("summary");
            let date_slug = now.format("%Y-%m-%d").to_string();

            format!(
                "Produce a daily review of vault activity. \
                 Use vault_list and vault_search to discover notes modified today ({date_slug}). \
                 Identify new tags, orphan notes (no inlinks), and noteworthy changes. \
                 Then use vault_write to create a review note at \
                 '{output_folder}/{date_slug}.md'. \
                 Template style: {template}. \
                 The review note MUST include: a heading with today's date, \
                 a list of modified/created notes as WikiLinks, \
                 new tags, and actionable suggestions. \
                 You MUST call vault_write to save the review — do not just output text."
            )
        }
        AgentKind::GraphMaintainer => {
            "Analyze the knowledge graph. Find orphan notes (no links), dead links, \
             hub overload (>30 outlinks), and cluster isolation. Suggest link improvements."
                .to_string()
        }
        AgentKind::TypstReviewer => {
            "Review and validate Typst (.typ) documents in the vault. \
             Use typst_compile to check for compilation errors and warnings. \
             Suggest fixes for any issues found. Check document structure, \
             missing imports, and formatting problems."
                .to_string()
        }
        AgentKind::Custom(_) => {
            // Custom agents provide their own system prompt via override
            "Execute the user-defined task as instructed.".to_string()
        }
    };

    // Build tool descriptions dynamically based on allowed_tools
    let all_tool_entries = [
        ("vault_read", "vault_read(path): Read note content"),
        ("vault_search", "vault_search(query): Search notes by keyword"),
        ("vault_list", "vault_list(folder?, filter?): List notes"),
        ("vault_link", "vault_link(path): Get backlinks/outlinks"),
        ("vault_write", "vault_write(path, content): Write/modify note"),
        ("typst_compile", "typst_compile(path): Compile .typ file, return diagnostics"),
    ];
    let tool_list: String = all_tool_entries
        .iter()
        .filter(|(name, _)| allowed_tools.iter().any(|t| t == name))
        .map(|(_, desc)| format!("- {}", desc))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "You are an intelligent note organization agent for a Markdown knowledge vault.\n\n\
         CURRENT TIME: {datetime_str}\n\n\
         VAULT CONTEXT:\n{vault_summary}\n\n\
         YOUR TASK: {agent_instruction}\n\n\
         AVAILABLE TOOLS:\n\
         {tool_list}\n\n\
         RULES:\n\
         1. Always use WikiLinks ([[note-name]]) when referencing notes\n\
         2. Preserve existing frontmatter when modifying notes\n\
         3. Use the vault's existing tag conventions\n\
         4. Output Markdown only\n\
         5. Do not invent information — only organize existing content\n\
         6. You MUST use vault_write to persist any output — text-only responses are not saved"
    )
}

/// Build the user's task message with relevant vault context
fn build_task_message(task: &AgentTask, relevant_notes: &str) -> String {
    let scope_desc = match task.scope.as_deref() {
        Some(s) if !s.is_empty() => format!("Target scope: {}", s),
        _ => "Scope: entire vault".to_string(),
    };

    format!(
        "{scope_desc}\n\n\
         RELEVANT NOTES:\n{relevant_notes}\n\n\
         Execute the task described in the system prompt. \
         Use the available tools as needed. When you are done, \
         respond with your final summary (no tool calls)."
    )
}

/// Compact conversation messages to stay within context budget.
///
/// Preserves the system prompt (index 0) and recent messages.
/// Respects tool-call boundaries: never splits between an assistant
/// message with tool_calls and its corresponding tool result messages.
///
/// The budget is derived from `context_window` (in tokens). If None,
/// defaults to 8 000 tokens. A rough 3:1 char-to-token ratio is used
/// since proper tokenization would require a per-model tokenizer.
fn compact_messages(messages: &mut Vec<ChatMessage>, context_window: Option<u32>) {
    // Derive character budget from token context window.
    // Conservative 3 chars/token ratio. Reserve 20% for the next LLM response.
    let token_budget = context_window.unwrap_or(8_000) as usize;
    // Cap at 100K tokens worth of chars to avoid excessive memory usage
    // even for models with very large context windows (e.g. Gemini 1M)
    let raw_budget = (token_budget * 3).saturating_mul(80) / 100; // 80% utilization
    let max_total_chars = raw_budget.min(300_000);
    // Scale KEEP_RECENT: larger context windows can retain more history
    let keep_recent = (max_total_chars / 5000).clamp(6, 24);

    let total_chars: usize = messages.iter().map(|m| {
        let mut size = m.content.len();
        // Include tool_calls payload in budget
        if let Some(ref calls) = m.tool_calls {
            for tc in calls {
                size += tc.args.to_string().len() + tc.tool.len();
            }
        }
        size
    }).sum();

    if total_chars <= max_total_chars || messages.len() <= keep_recent + 1 {
        return;
    }

    // Find a safe cut point: we need to keep at least KEEP_RECENT messages
    // from the end, but must not split a tool-call sequence.
    // A "safe" cut point is an index where messages[i] is NOT a tool-result
    // message (role != "tool"), meaning we're at a conversation boundary.
    let keep_from = messages.len().saturating_sub(keep_recent);

    // Walk backwards from keep_from to find a safe boundary
    let mut safe_cut = keep_from;
    while safe_cut > 1 && messages[safe_cut].role == "tool" {
        safe_cut -= 1;
    }
    // Also skip past any assistant message with tool_calls at safe_cut
    if safe_cut > 1 {
        if let Some(ref calls) = messages[safe_cut].tool_calls {
            if !calls.is_empty() {
                safe_cut -= 1;
            }
        }
    }

    // Don't compact if we'd only remove the user message
    if safe_cut <= 1 {
        return;
    }

    // Remove messages from index 1..safe_cut (keep system prompt at 0)
    messages.drain(1..safe_cut);
    // Insert a compaction notice
    messages.insert(1, ChatMessage::text(
        "user",
        "(Earlier conversation context was compacted to stay within limits.)",
    ));
}

/// Summarize tool call args for progress display (truncated)
fn summarize_args(args: &serde_json::Value) -> String {
    if let Some(obj) = args.as_object() {
        let parts: Vec<String> = obj.iter().take(2).map(|(k, v)| {
            let val_str = match v {
                serde_json::Value::String(s) => {
                    if s.len() > 40 {
                        format!("\"{}...\"", &s[..s.floor_char_boundary(37)])
                    } else {
                        format!("\"{}\"", s)
                    }
                }
                other => {
                    let s = other.to_string();
                    if s.len() > 40 {
                        format!("{}...", &s[..s.floor_char_boundary(37)])
                    } else {
                        s
                    }
                }
            };
            format!("{}: {}", k, val_str)
        }).collect();
        parts.join(", ")
    } else {
        args.to_string()
    }
}

// ── Partitioned tool execution ───────────────────────────────

/// Whether a tool is read-only (safe to run in parallel).
///
/// SAFETY-CRITICAL: Any tool NOT listed here will execute sequentially.
/// When adding new tools, verify they perform no mutations (filesystem
/// writes, DB inserts, pending_writes push) before adding them here.
fn is_read_only_tool(name: &str) -> bool {
    matches!(name, "vault_read" | "vault_search" | "vault_list" | "vault_link" | "typst_compile")
}

/// Process a single tool call result: truncate if needed, format errors
fn process_tool_result(
    tool_name: &str,
    result: Result<String, super::tools::ToolError>,
    task_id: &str,
) -> String {
    match result {
        Ok(text) => {
            tracing::debug!(
                task_id = %task_id,
                tool = %tool_name,
                result_len = text.len(),
                "Tool executed successfully"
            );
            if text.len() > 4000 {
                let boundary = text.floor_char_boundary(4000);
                format!("{}... (truncated)", &text[..boundary])
            } else {
                text
            }
        }
        Err(e) => {
            tracing::warn!(
                task_id = %task_id,
                tool = %tool_name,
                error = %e,
                "Tool execution failed"
            );
            format_tool_error(tool_name, &e)
        }
    }
}

/// Execute tool calls with read-only calls in parallel and writes sequentially.
///
/// Returns results in the same order as the input `tool_calls` slice.
#[allow(clippy::too_many_arguments)]
async fn execute_tools_partitioned(
    tool_calls: &[crate::llm::types::ToolCall],
    vault_path: &Path,
    read_db: &Arc<Mutex<Option<Connection>>>,
    pending_writes: &Arc<Mutex<Vec<ProposedChange>>>,
    auto_apply: bool,
    db: &Arc<Mutex<Option<Connection>>>,
    max_writes: u8,
    font_state: Option<Arc<FontState>>,
    task_id: &str,
) -> Vec<String> {
    // Pre-allocate result slots (one per tool call)
    let mut results: Vec<Option<String>> = vec![None; tool_calls.len()];

    // Collect read-only indices for parallel execution
    let read_indices: Vec<usize> = tool_calls
        .iter()
        .enumerate()
        .filter(|(_, tc)| is_read_only_tool(&tc.tool))
        .map(|(i, _)| i)
        .collect();

    // Execute all read-only tools concurrently
    if !read_indices.is_empty() {
        let read_count = read_indices.len();
        tracing::debug!(
            task_id = %task_id,
            count = read_count,
            "Executing read-only tools in parallel"
        );

        let futures: Vec<_> = read_indices
            .iter()
            .map(|&i| {
                let tc = &tool_calls[i];
                execute_tool(
                    tc,
                    vault_path,
                    read_db,
                    pending_writes,
                    auto_apply,
                    db,
                    max_writes,
                    font_state.clone(),
                )
            })
            .collect();

        let read_results = futures_util::future::join_all(futures).await;

        for (&idx, raw) in read_indices.iter().zip(read_results.into_iter()) {
            results[idx] = Some(process_tool_result(
                &tool_calls[idx].tool,
                raw,
                task_id,
            ));
        }
    }

    // Execute write (and any other non-read) tools sequentially
    for (i, tc) in tool_calls.iter().enumerate() {
        if results[i].is_some() {
            continue; // Already handled as read-only
        }
        let raw = execute_tool(
            tc,
            vault_path,
            read_db,
            pending_writes,
            auto_apply,
            db,
            max_writes,
            font_state.clone(),
        )
        .await;
        results[i] = Some(process_tool_result(&tc.tool, raw, task_id));
    }

    // Unwrap all results (every slot is guaranteed to be filled)
    results.into_iter().map(|r| r.unwrap_or_default()).collect()
}

// ── Structured tool error formatting ─────────────────────────

/// Format a tool error with recovery hints so the LLM can decide whether to retry.
///
/// - `[RECOVERABLE]`: the agent should try a different approach
/// - `[FATAL]`: the error is terminal; do not retry this action
fn format_tool_error(tool_name: &str, error: &ToolError) -> String {
    match error {
        ToolError::AccessDenied(p) => format!(
            "[RECOVERABLE] Error in {tool_name}: path outside vault ({p}). \
             Use a vault-relative path without leading '/' or '..'."
        ),
        ToolError::MissingArg(arg) => format!(
            "[RECOVERABLE] Error in {tool_name}: missing required argument '{arg}'. \
             Check the tool schema and provide all required parameters."
        ),
        ToolError::Io(msg) if msg.contains("not found") || msg.contains("No such file") => format!(
            "[RECOVERABLE] Error in {tool_name}: {msg}. \
             The file may have been moved or renamed. Use vault_search or vault_list to find it."
        ),
        ToolError::Io(msg) => format!(
            "[RECOVERABLE] Error in {tool_name}: IO error — {msg}"
        ),
        ToolError::NoIndex => format!(
            "[FATAL] Error in {tool_name}: no index available. The vault may not be indexed yet."
        ),
        ToolError::WriteLimitExceeded => format!(
            "[FATAL] Error in {tool_name}: write limit exceeded. \
             No more vault_write calls are allowed in this run. \
             Finish with a summary of remaining work instead."
        ),
        ToolError::UnknownTool(name) => format!(
            "[FATAL] Error: unknown tool '{name}'. Use only the tools listed in your system prompt."
        ),
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
        ChatMessage::text("system", "You are a concise summarizer. Summarize the agent run in 2-3 sentences."),
        ChatMessage::text("user", format!(
            "Steps completed:\n{steps_summary}\n\n\
             Proposed changes:\n{changes_summary}\n\n\
             Provide a brief summary of what was accomplished."
        )),
    ];

    let response = call_llm_complete(config, &messages, None, abort_rx).await?;
    Ok(response.content)
}

// ── Helper: build aborted result ────────────────────────────

fn build_aborted_result(
    task_id: String,
    kind: AgentKind,
    scope: Option<String>,
    steps: Vec<PlanStep>,
    started_at: chrono::DateTime<Utc>,
    total_usage: TokenUsage,
) -> TaskResult {
    TaskResult {
        task_id,
        kind,
        status: AgentStatus::Aborted,
        auto_applied: false,
        scope,
        plan_steps: steps,
        proposed_changes: vec![],
        summary: "Agent run was aborted by user.".into(),
        started_at,
        completed_at: Some(Utc::now()),
        token_usage: Some(total_usage),
    }
}
