use std::path::PathBuf;

use parking_lot::RwLock;

/// Global application state shared across Tauri commands.
pub struct AppState {
    pub vault_path: RwLock<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_path: RwLock::new(None),
        }
    }
}
