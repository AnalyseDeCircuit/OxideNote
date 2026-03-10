use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;

use crate::agent::commands::AgentState;
use crate::commands::typst::FontState;

/// Global application state shared across Tauri commands.
pub struct AppState {
    pub vault_path: RwLock<Option<PathBuf>>,
    pub watcher: Arc<Mutex<Option<Debouncer<RecommendedWatcher>>>>,
    /// Write connection — used by watcher indexing and note save operations
    pub db: Arc<Mutex<Option<Connection>>>,
    /// Read-only connection — used by search/backlink/graph queries,
    /// separate from write path to avoid read starvation under WAL mode
    pub read_db: Arc<Mutex<Option<Connection>>>,
    /// Cancel senders for in-flight chat streams, keyed by request_id.
    /// Arc-wrapped so spawned tasks can access it after command returns.
    pub abort_senders: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// Chat persistence database — separate from index.db because chat data is not rebuildable
    pub chat_db: Arc<Mutex<Option<Connection>>>,
    /// Agent workflow execution state
    pub agent_state: Arc<AgentState>,
    /// Cached font state for Typst compilation — built lazily on first compile
    font_state: once_cell::sync::OnceCell<Arc<FontState>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_path: RwLock::new(None),
            watcher: Arc::new(Mutex::new(None)),
            db: Arc::new(Mutex::new(None)),
            read_db: Arc::new(Mutex::new(None)),
            abort_senders: Arc::new(Mutex::new(HashMap::new())),
            chat_db: Arc::new(Mutex::new(None)),
            agent_state: Arc::new(AgentState::new()),
            font_state: once_cell::sync::OnceCell::new(),
        }
    }

    /// Get or lazily initialize the shared font state for Typst compilation.
    /// Font discovery scans system font directories and is cached for the app session.
    pub fn get_or_init_fonts(&self) -> Arc<FontState> {
        self.font_state
            .get_or_init(|| {
                tracing::info!("Building Typst font book (first compilation)...");
                let state = FontState::new();
                tracing::info!("Font book ready");
                Arc::new(state)
            })
            .clone()
    }
}
