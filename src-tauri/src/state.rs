use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;

use crate::agent::commands::AgentState;

/// Global application state shared across Tauri commands.
pub struct AppState {
    pub vault_path: RwLock<Option<PathBuf>>,
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Write connection — used by watcher indexing and note save operations
    pub db: Arc<Mutex<Option<Connection>>>,
    /// Read-only connection — used by search/backlink/graph queries,
    /// separate from write path to avoid read starvation under WAL mode
    pub read_db: Arc<Mutex<Option<Connection>>>,
    /// Cancel senders for in-flight chat streams, keyed by request_id.
    /// Arc-wrapped so spawned tasks can access it after command returns.
    pub abort_senders: Arc<std::sync::Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// Chat persistence database — separate from index.db because chat data is not rebuildable
    pub chat_db: Arc<Mutex<Option<Connection>>>,
    /// Agent workflow execution state
    pub agent_state: Arc<AgentState>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_path: RwLock::new(None),
            watcher: Mutex::new(None),
            db: Arc::new(Mutex::new(None)),
            read_db: Arc::new(Mutex::new(None)),
            abort_senders: Arc::new(std::sync::Mutex::new(HashMap::new())),
            chat_db: Arc::new(Mutex::new(None)),
            agent_state: Arc::new(AgentState::new()),
        }
    }
}
