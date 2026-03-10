//! Canvas persistence commands
//!
//! Handles reading and writing `.canvas` files in the vault.
//! Canvas files store whiteboard data as JSON (strokes, note cards, viewport).

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

// Re-use note module's path validation
use super::note::validate_inside_vault;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CanvasError {
    #[error("No vault opened")]
    NoVault,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("Invalid canvas format: {0}")]
    InvalidFormat(String),
}

impl Serialize for CanvasError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// ── Canvas data model ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasStroke {
    pub points: Vec<CanvasPoint>,
    pub color: String,
    pub width: f64,
}

/// A text/note card placed on the canvas surface
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasCard {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub color: String,
    /// Optional link to a vault note path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_note: Option<String>,
    /// Optional block reference: { note_path, block_id }
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_block: Option<LinkedBlock>,
}

/// A block reference embedded in a canvas card (Phase 2)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedBlock {
    pub note_path: String,
    pub block_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

/// Top-level canvas file structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasData {
    pub version: u32,
    pub strokes: Vec<CanvasStroke>,
    pub cards: Vec<CanvasCard>,
    pub viewport: CanvasViewport,
}

impl Default for CanvasViewport {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, zoom: 1.0 }
    }
}

impl Default for CanvasData {
    fn default() -> Self {
        Self {
            version: 1,
            strokes: Vec::new(),
            cards: Vec::new(),
            viewport: CanvasViewport::default(),
        }
    }
}

// ── Commands ────────────────────────────────────────────────

/// Read a canvas file from the vault. Returns the parsed canvas data.
/// If the file does not exist, returns default empty canvas.
#[tauri::command]
pub async fn read_canvas(
    path: String,
    state: State<'_, AppState>,
) -> Result<CanvasData, CanvasError> {
    // Clone path early to release the RwLock before I/O
    let base = {
        let vp = state.vault_path.read();
        vp.as_ref().ok_or(CanvasError::NoVault)?.clone()
    };
    let full_path = validate_canvas_path(&base, &path)?;

    if !full_path.exists() {
        // New canvas — return empty data
        return Ok(CanvasData::default());
    }

    let content = std::fs::read_to_string(&full_path)
        .map_err(|e| CanvasError::Io(e.to_string()))?;

    let data: CanvasData = serde_json::from_str(&content)
        .map_err(|e| CanvasError::InvalidFormat(e.to_string()))?;

    Ok(data)
}

/// Write canvas data to disk as a JSON file.
/// Creates parent directories if needed. Uses atomic write.
#[tauri::command]
pub async fn write_canvas(
    path: String,
    data: CanvasData,
    state: State<'_, AppState>,
) -> Result<(), CanvasError> {
    let base = {
        let vp = state.vault_path.read();
        vp.as_ref().ok_or(CanvasError::NoVault)?.clone()
    };
    let full_path = validate_canvas_path(&base, &path)?;

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CanvasError::Io(e.to_string()))?;
    }

    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| CanvasError::Io(e.to_string()))?;

    // Atomic write: write to temp file first, then rename
    let tmp_path = full_path.with_extension("canvas.tmp");
    std::fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| CanvasError::Io(e.to_string()))?;
    std::fs::rename(&tmp_path, &full_path)
        .map_err(|e| CanvasError::Io(e.to_string()))?;

    Ok(())
}

/// Create a new empty canvas file and return its vault-relative path.
/// Uses atomic write to prevent partial files on crash.
#[tauri::command]
pub async fn create_canvas(
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, CanvasError> {
    let base = {
        let vp = state.vault_path.read();
        vp.as_ref().ok_or(CanvasError::NoVault)?.clone()
    };

    // Ensure name ends with .canvas
    let filename = if name.ends_with(".canvas") {
        name.clone()
    } else {
        format!("{}.canvas", name)
    };

    let rel_path = if parent_path.is_empty() {
        filename
    } else {
        format!("{}/{}", parent_path, filename)
    };

    let full_path = validate_canvas_path(&base, &rel_path)?;

    if full_path.exists() {
        return Err(CanvasError::Io(format!("Canvas already exists: {}", rel_path)));
    }

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CanvasError::Io(e.to_string()))?;
    }

    let data = CanvasData::default();
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| CanvasError::Io(e.to_string()))?;

    // Atomic write: temp file then rename
    let tmp_path = full_path.with_extension("canvas.tmp");
    std::fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| CanvasError::Io(e.to_string()))?;
    std::fs::rename(&tmp_path, &full_path)
        .map_err(|e| CanvasError::Io(e.to_string()))?;

    Ok(rel_path)
}

// ── Helpers ─────────────────────────────────────────────────

/// Validate that the path is inside the vault and has .canvas extension.
fn validate_canvas_path(base: &Path, rel_path: &str) -> Result<std::path::PathBuf, CanvasError> {
    // Delegate to note module's path validation
    let full_path = validate_inside_vault(base, rel_path)
        .map_err(|_| CanvasError::AccessDenied)?;
    Ok(full_path)
}
