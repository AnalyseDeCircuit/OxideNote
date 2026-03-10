//! Agent scheduler — periodic task execution.
//!
//! Reads a SchedulerConfig from <vault>/.oxidenote/agent_config.json
//! and enqueues agent tasks at the configured intervals.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{Local, Timelike};
use serde::{Deserialize, Serialize};
use tokio::time::{interval, Duration};

use super::commands::AgentState;
use super::types::{AgentKind, AgentTask};

// ── Configuration types ─────────────────────────────────────

/// Scheduler configuration persisted in <vault>/.oxidenote/agent_config.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerConfig {
    #[serde(default)]
    pub enabled: bool,
    pub daily_review: Option<DailyReviewConfig>,
    pub graph_maintenance: Option<GraphMaintenanceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyReviewConfig {
    pub enabled: bool,
    /// Hour of day to generate review (0-23)
    pub hour: u8,
    /// Output folder for review notes (relative to vault root)
    #[serde(default = "default_review_folder")]
    pub output_folder: String,
    /// Template: "summary" | "highlights" | "full"
    #[serde(default = "default_review_template")]
    pub template: String,
    /// Whether to auto-apply changes without user approval (default: true)
    #[serde(default = "default_true")]
    pub auto_apply: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphMaintenanceConfig {
    pub enabled: bool,
    /// Run every N hours
    #[serde(default = "default_interval")]
    pub interval_hours: u32,
    /// Whether to auto-apply changes without user approval (default: false)
    #[serde(default)]
    pub auto_apply: bool,
}

fn default_review_folder() -> String {
    "daily".into()
}

fn default_review_template() -> String {
    "summary".into()
}

fn default_interval() -> u32 {
    24
}

fn default_true() -> bool {
    true
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            daily_review: None,
            graph_maintenance: None,
        }
    }
}

// ── Config persistence ──────────────────────────────────────

const CONFIG_FILENAME: &str = "agent_config.json";

/// Load scheduler config from vault's .oxidenote directory.
pub fn load_config(vault_path: &Path) -> SchedulerConfig {
    let path = vault_path.join(".oxidenote").join(CONFIG_FILENAME);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => SchedulerConfig::default(),
    }
}

/// Save scheduler config to vault's .oxidenote directory.
pub fn save_config(vault_path: &Path, config: &SchedulerConfig) -> Result<(), String> {
    let dir = vault_path.join(".oxidenote");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(CONFIG_FILENAME);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Scheduler loop ──────────────────────────────────────────

/// Start the scheduler background loop. Checks every 15 minutes
/// whether any scheduled tasks should run and enqueues them.
pub fn start_scheduler(
    agent_state: Arc<AgentState>,
    vault_path: PathBuf,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(15 * 60)); // 15-minute interval
        let mut last_daily_review_date: Option<chrono::NaiveDate> = None;
        let mut last_graph_maintenance: Option<chrono::DateTime<Local>> = None;

        loop {
            tick.tick().await;

            let config = load_config(&vault_path);
            if !config.enabled {
                continue;
            }

            let now = Local::now();

            // Check daily review
            if let Some(ref review) = config.daily_review {
                if review.enabled {
                    let today = now.date_naive();
                    let should_run = match last_daily_review_date {
                        Some(d) => d < today && now.hour() >= review.hour as u32,
                        None => now.hour() >= review.hour as u32,
                    };
                    if should_run {
                        last_daily_review_date = Some(today);
                        let task = AgentTask {
                            kind: AgentKind::DailyReview,
                            // Scope = entire vault so the agent can read all notes
                            scope: None,
                            params: serde_json::json!({
                                "output_folder": review.output_folder,
                                "template": review.template,
                            }),
                            auto_apply: review.auto_apply,
                        };
                        let mut queue = agent_state.task_queue.lock();
                        queue.push_back(task);
                    }
                }
            }

            // Check graph maintenance
            if let Some(ref graph) = config.graph_maintenance {
                if graph.enabled {
                    let hours = graph.interval_hours.max(1);
                    let should_run = match last_graph_maintenance {
                        Some(last) => {
                            now.signed_duration_since(last).num_hours() >= hours as i64
                        }
                        None => true,
                    };
                    if should_run {
                        last_graph_maintenance = Some(now);
                        let task = AgentTask {
                            kind: AgentKind::GraphMaintainer,
                            scope: None,
                            params: serde_json::Value::Null,
                            auto_apply: graph.auto_apply,
                        };
                        let mut queue = agent_state.task_queue.lock();
                        queue.push_back(task);
                    }
                }
            }
        }
    })
}
