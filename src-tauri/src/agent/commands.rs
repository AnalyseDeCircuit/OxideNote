//! Agent commands — Tauri command handlers for agent execution.
//!
//! Provides: agent_run, agent_abort, agent_status, agent_apply_changes,
//! agent_list_history, agent_list_custom.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, State};

use super::custom::{self, CustomAgentDef};
use super::history;
use super::runtime::{self, AgentError};
use super::types::*;
use crate::llm::function_calling::{default_agent_tools, readonly_agent_tools};
use crate::llm::types::ChatConfig;
use crate::state::AppState;

// ── Agent state machine ─────────────────────────────────────

/// Unified agent execution state — single Mutex avoids split-state races.
#[derive(Debug)]
pub enum AgentRunState {
    Idle,
    Running {
        task_id: String,
        kind: AgentKind,
        abort_tx: tokio::sync::watch::Sender<bool>,
    },
    WaitingApproval(TaskResult),
}

/// Top-level agent state, embedded in AppState as `agent_state: Arc<AgentState>`.
pub struct AgentState {
    pub run_state: Mutex<AgentRunState>,
    pub task_queue: Mutex<VecDeque<AgentTask>>,
    pub scheduler_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            run_state: Mutex::new(AgentRunState::Idle),
            task_queue: Mutex::new(VecDeque::new()),
            scheduler_handle: Mutex::new(None),
        }
    }
}

// ── Status response type ────────────────────────────────────

/// Current agent status returned by agent_status command
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentStatusResponse {
    pub state: String,
    pub task_id: Option<String>,
    pub kind: Option<String>,
    pub result: Option<TaskResult>,
}

// ── Commands ────────────────────────────────────────────────

/// Start an agent task. If another agent is running, queues the task.
/// Returns the task_id (or "queued" if enqueued).
#[tauri::command]
pub async fn agent_run(
    task: AgentTask,
    config: ChatConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AgentError> {
    let agent_state = Arc::clone(&state.agent_state);
    let db = Arc::clone(&state.db);
    let read_db = Arc::clone(&state.read_db);
    let chat_db = Arc::clone(&state.chat_db);
    let vault_path = state
        .vault_path
        .read()
        .clone()
        .ok_or(AgentError::NoVault)?;

    // Resolve custom agent settings if applicable
    let (allowed_tools, system_prompt_override, max_writes) =
        resolve_agent_settings(&task, &vault_path);

    // Check if already running
    {
        let run_state = agent_state.run_state.lock();
        if !matches!(*run_state, AgentRunState::Idle) {
            let mut queue = agent_state.task_queue.lock();
            queue.push_back(task);
            return Ok("queued".to_string());
        }
    }

    // Create abort channel
    let (abort_tx, abort_rx) = tokio::sync::watch::channel(false);
    let task_id = uuid::Uuid::new_v4().to_string();
    let task_id_ret = task_id.clone();

    // Set state to Running
    {
        let mut run_state = agent_state.run_state.lock();
        *run_state = AgentRunState::Running {
            task_id: task_id.clone(),
            kind: task.kind.clone(),
            abort_tx,
        };
    }

    // Spawn the agent task
    let agent_state_clone = Arc::clone(&agent_state);
    tokio::spawn(async move {
        let result = runtime::run_agent(
            task,
            &config,
            &vault_path,
            db.clone(),
            read_db,
            &app,
            abort_rx,
            allowed_tools,
            system_prompt_override,
            max_writes,
        )
        .await;

        // Update state based on result
        let mut run_state = agent_state_clone.run_state.lock();
        match result {
            Ok(task_result) => {
                // Persist to history
                let _ = history::save_agent_run(&chat_db, &task_result);

                if task_result.status == AgentStatus::WaitingApproval {
                    *run_state = AgentRunState::WaitingApproval(task_result);
                } else {
                    *run_state = AgentRunState::Idle;
                    // Drain queued tasks
                    drain_queued_tasks(&agent_state_clone, &config, &vault_path, &db, &app);
                }
            }
            Err(e) => {
                *run_state = AgentRunState::Idle;
                let _ = app.emit(
                    "agent-error",
                    serde_json::json!({ "error": e.to_string() }),
                );
                drain_queued_tasks(&agent_state_clone, &config, &vault_path, &db, &app);
            }
        }
    });

    Ok(task_id_ret)
}

/// Abort the currently running agent task.
#[tauri::command]
pub async fn agent_abort(state: State<'_, AppState>) -> Result<(), AgentError> {
    let agent_state = &state.agent_state;
    let run_state = agent_state.run_state.lock();
    match &*run_state {
        AgentRunState::Running { abort_tx, .. } => {
            let _ = abort_tx.send(true);
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Get current agent status (idle, running, waiting approval).
#[tauri::command]
pub async fn agent_status(state: State<'_, AppState>) -> Result<AgentStatusResponse, AgentError> {
    let agent_state = &state.agent_state;
    let run_state = agent_state.run_state.lock();
    match &*run_state {
        AgentRunState::Idle => Ok(AgentStatusResponse {
            state: "idle".into(),
            task_id: None,
            kind: None,
            result: None,
        }),
        AgentRunState::Running { task_id, kind, .. } => Ok(AgentStatusResponse {
            state: "running".into(),
            task_id: Some(task_id.clone()),
            kind: Some(kind.to_string()),
            result: None,
        }),
        AgentRunState::WaitingApproval(result) => Ok(AgentStatusResponse {
            state: "waiting_approval".into(),
            task_id: Some(result.task_id.clone()),
            kind: Some(result.kind.to_string()),
            result: Some(result.clone()),
        }),
    }
}

/// Apply selected proposed changes from a completed agent run.
/// `indices` specifies which changes to apply (0-based).
#[tauri::command]
pub async fn agent_apply_changes(
    task_id: String,
    indices: Vec<usize>,
    state: State<'_, AppState>,
) -> Result<(), AgentError> {
    let vault_path = state
        .vault_path
        .read()
        .clone()
        .ok_or(AgentError::NoVault)?;
    let agent_state = Arc::clone(&state.agent_state);
    let db = Arc::clone(&state.db);

    let task_result = {
        let run_state = agent_state.run_state.lock();
        match &*run_state {
            AgentRunState::WaitingApproval(tr) if tr.task_id == task_id => tr.clone(),
            _ => {
                return Err(AgentError::Internal(
                    "No pending changes for this task".into(),
                ))
            }
        }
    };

    // Apply each selected change
    for idx in &indices {
        let change = task_result
            .proposed_changes
            .get(*idx)
            .ok_or_else(|| AgentError::Internal(format!("Invalid change index: {}", idx)))?;

        let full_path = vault_path.join(&change.path);
        validate_agent_path(&full_path, &vault_path)?;

        match change.action {
            ChangeAction::Create | ChangeAction::Modify | ChangeAction::Merge => {
                if let Some(ref content) = change.content {
                    if let Some(parent) = full_path.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|e| AgentError::Io(e.to_string()))?;
                    }
                    tokio::fs::write(&full_path, content)
                        .await
                        .map_err(|e| AgentError::Io(e.to_string()))?;

                    // Reindex the written file
                    let db_guard = db.lock();
                    if let Some(conn) = db_guard.as_ref() {
                        let _ = crate::indexing::scanner::index_single_file(
                            &vault_path,
                            &full_path,
                            conn,
                        );
                    }
                }
            }
            ChangeAction::AddLink => {
                // Read existing content, append link section, write back
                if let Some(ref link_content) = change.content {
                    let existing = tokio::fs::read_to_string(&full_path)
                        .await
                        .unwrap_or_default();
                    let updated = format!("{}\n\n{}", existing.trim_end(), link_content);
                    tokio::fs::write(&full_path, updated)
                        .await
                        .map_err(|e| AgentError::Io(e.to_string()))?;

                    let db_guard = db.lock();
                    if let Some(conn) = db_guard.as_ref() {
                        let _ = crate::indexing::scanner::index_single_file(
                            &vault_path,
                            &full_path,
                            conn,
                        );
                    }
                }
            }
        }
    }

    // Transition to Idle
    {
        let mut run_state = agent_state.run_state.lock();
        *run_state = AgentRunState::Idle;
    }

    Ok(())
}

/// Dismiss pending changes without applying (transition back to Idle).
#[tauri::command]
pub async fn agent_dismiss_changes(state: State<'_, AppState>) -> Result<(), AgentError> {
    let agent_state = &state.agent_state;
    let mut run_state = agent_state.run_state.lock();
    if matches!(&*run_state, AgentRunState::WaitingApproval(_)) {
        *run_state = AgentRunState::Idle;
    }
    Ok(())
}

/// List past agent runs from history.
#[tauri::command]
pub async fn agent_list_history(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentRunSummary>, AgentError> {
    let chat_db = Arc::clone(&state.chat_db);
    history::list_agent_runs(&chat_db, limit.unwrap_or(20))
        .map_err(|e| AgentError::Internal(e.to_string()))
}

/// List available custom agent definitions from vault.
#[tauri::command]
pub async fn agent_list_custom(
    state: State<'_, AppState>,
) -> Result<Vec<CustomAgentDef>, AgentError> {
    let vault_path = state
        .vault_path
        .read()
        .clone()
        .ok_or(AgentError::NoVault)?;
    let agents = custom::load_custom_agents(&vault_path);
    Ok(agents.into_iter().map(|(def, _)| def).collect())
}

// ── Helpers ─────────────────────────────────────────────────

/// Validate that a path is within the vault boundary.
/// Walks up to the topmost existing ancestor for new file paths.
fn validate_agent_path(path: &std::path::Path, vault_path: &std::path::Path) -> Result<(), AgentError> {
    let canonical_base = vault_path
        .canonicalize()
        .map_err(|e| AgentError::Io(e.to_string()))?;

    if path.exists() {
        let canonical = path
            .canonicalize()
            .map_err(|e| AgentError::Io(e.to_string()))?;
        if !canonical.starts_with(&canonical_base) {
            return Err(AgentError::Internal("Path outside vault".into()));
        }
    } else {
        // For non-existent paths, walk up to find the topmost existing ancestor
        let mut ancestor = path.to_path_buf();
        while !ancestor.exists() {
            match ancestor.parent() {
                Some(parent) => ancestor = parent.to_path_buf(),
                None => return Err(AgentError::Internal("Path has no valid ancestor".into())),
            }
        }
        let canonical_ancestor = ancestor
            .canonicalize()
            .map_err(|e| AgentError::Io(e.to_string()))?;
        if !canonical_ancestor.starts_with(&canonical_base) {
            return Err(AgentError::Internal("Path outside vault".into()));
        }
    }
    Ok(())
}

/// Resolve allowed tools, system prompt override, and max_writes for a task.
/// max_writes is clamped to MAX_WRITES_CEILING to prevent runaway custom agents.
const MAX_WRITES_CEILING: u8 = 50;

fn resolve_agent_settings(
    task: &AgentTask,
    vault_path: &PathBuf,
) -> (Vec<String>, Option<String>, u8) {
    let (tools, prompt, raw_max) = match &task.kind {
        AgentKind::Custom(name) => {
            let agents = custom::load_custom_agents(vault_path);
            if let Some((def, prompt)) = agents.into_iter().find(|(d, _)| d.name == *name) {
                (def.tools.clone(), Some(prompt), def.max_writes)
            } else {
                (readonly_agent_tools(), None, 10)
            }
        }
        // Built-in agents: full tool access, default max_writes
        _ => (default_agent_tools(), None, 10),
    };
    (tools, prompt, raw_max.min(MAX_WRITES_CEILING))
}

/// Drain queued tasks after the current one completes.
/// This is a fire-and-forget spawn — we don't track the result.
fn drain_queued_tasks(
    _agent_state: &Arc<AgentState>,
    _config: &ChatConfig,
    _vault_path: &PathBuf,
    _db: &Arc<parking_lot::Mutex<Option<rusqlite::Connection>>>,
    _app: &AppHandle,
) {
    // Queue draining is deferred to P2 — for now, tasks are simply dropped.
    // In P2, each queued task will be spawned sequentially after the current
    // one completes, reusing the same run_agent pattern.
}
