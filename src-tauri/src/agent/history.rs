//! Agent history — persist and query agent run results in chat_db.

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection};

use super::types::{AgentRunDetail, AgentRunSummary, TaskResult};

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("No chat database")]
    NoDatabase,
    #[error("Database error: {0}")]
    Db(String),
}

impl From<rusqlite::Error> for HistoryError {
    fn from(e: rusqlite::Error) -> Self {
        HistoryError::Db(e.to_string())
    }
}

// ── Persistence ─────────────────────────────────────────────

/// Save a completed agent run to the agent_runs table.
pub fn save_agent_run(
    chat_db: &Arc<Mutex<Option<Connection>>>,
    result: &TaskResult,
) -> Result<(), HistoryError> {
    let guard = chat_db.lock();
    let conn = guard.as_ref().ok_or(HistoryError::NoDatabase)?;

    let plan_json =
        serde_json::to_string(&result.plan_steps).unwrap_or_else(|_| "[]".to_string());
    let changes_json =
        serde_json::to_string(&result.proposed_changes).unwrap_or_else(|_| "[]".to_string());

    let (token_prompt, token_completion) = result
        .token_usage
        .as_ref()
        .map(|u| (u.prompt_tokens, u.completion_tokens))
        .unwrap_or((0, 0));

    conn.execute(
        "INSERT OR REPLACE INTO agent_runs
         (id, kind, status, scope, summary, plan_json, changes_json,
          token_prompt, token_completion, started_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            result.task_id,
            result.kind.to_string(),
            format!("{:?}", result.status).to_lowercase(),
            result.scope.as_deref(),
            result.summary,
            plan_json,
            changes_json,
            token_prompt,
            token_completion,
            result.started_at.to_rfc3339(),
            result.completed_at.map(|t| t.to_rfc3339()),
        ],
    )?;

    Ok(())
}

/// List agent run summaries, most recent first.
pub fn list_agent_runs(
    chat_db: &Arc<Mutex<Option<Connection>>>,
    limit: i64,
) -> Result<Vec<AgentRunSummary>, HistoryError> {
    let guard = chat_db.lock();
    let conn = guard.as_ref().ok_or(HistoryError::NoDatabase)?;

    // Check if agent_runs table exists before querying
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !table_exists {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT id, kind, status, scope, summary,
                token_prompt, token_completion, started_at, completed_at
         FROM agent_runs
         ORDER BY started_at DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map(params![limit], |row| {
        Ok(AgentRunSummary {
            id: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            scope: row.get(3)?,
            summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            token_prompt: row.get::<_, i64>(5).unwrap_or(0) as u32,
            token_completion: row.get::<_, i64>(6).unwrap_or(0) as u32,
            started_at: row.get(7)?,
            completed_at: row.get(8)?,
        })
    })?;

    let mut runs = Vec::new();
    for row in rows {
        runs.push(row?);
    }
    Ok(runs)
}

/// Retrieve full detail of a single agent run, including plan + changes.
pub fn get_agent_run_detail(
    chat_db: &Arc<Mutex<Option<Connection>>>,
    run_id: &str,
) -> Result<Option<AgentRunDetail>, HistoryError> {
    let guard = chat_db.lock();
    let conn = guard.as_ref().ok_or(HistoryError::NoDatabase)?;

    // Guard: table may not exist on a fresh vault
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !table_exists {
        return Ok(None);
    }

    let mut stmt = conn.prepare(
        "SELECT id, kind, status, scope, summary, plan_json, changes_json,
                token_prompt, token_completion, started_at, completed_at
         FROM agent_runs WHERE id = ?1",
    )?;

    let result = stmt.query_row(params![run_id], |row| {
        Ok(AgentRunDetail {
            id: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            scope: row.get(3)?,
            summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            plan_steps: row.get::<_, String>(5).unwrap_or_else(|_| "[]".into()),
            changes_json: row.get::<_, String>(6).unwrap_or_else(|_| "[]".into()),
            token_prompt: row.get::<_, i64>(7).unwrap_or(0) as u32,
            token_completion: row.get::<_, i64>(8).unwrap_or(0) as u32,
            started_at: row.get(9)?,
            completed_at: row.get(10)?,
        })
    });

    match result {
        Ok(detail) => Ok(Some(detail)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
