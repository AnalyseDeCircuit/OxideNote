//! Agent scheduler — placeholder for periodic task execution.
//!
//! Full implementation deferred to P3 (scheduler + UI phase).
//! This module declares the types and stubs needed for compilation.

use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphMaintenanceConfig {
    pub enabled: bool,
    /// Run every N hours
    #[serde(default = "default_interval")]
    pub interval_hours: u32,
}

fn default_review_folder() -> String {
    "reviews".into()
}

fn default_review_template() -> String {
    "summary".into()
}

fn default_interval() -> u32 {
    24
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
