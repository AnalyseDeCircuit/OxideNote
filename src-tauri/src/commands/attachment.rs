//! 附件管理模块 — 处理图片和文件附件的持久化存储
//!
//! 设计方案：
//!   · 附件存储在 `<vault>/.attachments/` 目录下
//!   · 使用 SHA-256 哈希前 16 字符 + 原始扩展名作为文件名，避免重复
//!   · 返回相对路径供 Markdown 图片引用 `![](path)` 使用
//!   · 路径验证确保所有操作限制在 vault 目录内

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

// ── 错误类型 ─────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error("No vault opened")]
    NoVault,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Invalid data")]
    InvalidData,
}

impl Serialize for AttachmentError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// 保存附件数据到 vault 的 .attachments 目录
///
/// # 参数
/// * `data` — Base64 编码的文件内容
/// * `filename` — 原始文件名（用于提取扩展名）
///
/// # 返回
/// 相对于 vault 根目录的路径，可直接用于 Markdown 引用
#[tauri::command]
pub async fn save_attachment(
    data: String,
    filename: String,
    state: State<'_, AppState>,
) -> Result<String, AttachmentError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(AttachmentError::NoVault)?;

    // 解码 Base64 数据
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|_| AttachmentError::InvalidData)?;

    // 提取文件扩展名
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");

    // 使用 SHA-256 哈希前 32 字符（128 位）作为文件名，
    // 64 位时 ~2^32 个附件就有 50% 碰撞概率，128 位足够安全
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(&bytes);
    let hash_hex: String = hash.iter().take(16).map(|b| format!("{:02x}", b)).collect();
    let safe_name = format!("{}.{}", hash_hex, ext);

    // 确保 .attachments 目录存在
    let attachments_dir = base.join(".attachments");
    std::fs::create_dir_all(&attachments_dir)
        .map_err(|e| AttachmentError::Io(e.to_string()))?;

    let file_path = attachments_dir.join(&safe_name);

    // 如果文件已存在（相同内容），直接返回路径
    if !file_path.exists() {
        std::fs::write(&file_path, &bytes)
            .map_err(|e| AttachmentError::Io(e.to_string()))?;
    }

    // 返回相对路径
    let rel_path = format!(".attachments/{}", safe_name);
    tracing::info!("Saved attachment: {}", rel_path);
    Ok(rel_path)
}

// ============================================================================
// PDF Annotation Persistence
// ============================================================================

/// Save PDF annotation data as a JSON file under `.oxidenote/annotations/`.
/// Uses a hash of the PDF path as the filename to avoid conflicts.
#[tauri::command]
pub async fn save_pdf_annotations(
    pdf_path: String,
    annotations_json: String,
    state: State<'_, AppState>,
) -> Result<(), AttachmentError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(AttachmentError::NoVault)?;

    let annotations_dir = base.join(".oxidenote").join("annotations");
    std::fs::create_dir_all(&annotations_dir)
        .map_err(|e| AttachmentError::Io(e.to_string()))?;

    let hash = hash_path(&pdf_path);
    let file_path = annotations_dir.join(format!("{}.json", hash));

    // Validate JSON before writing to prevent storing corrupt data
    serde_json::from_str::<serde_json::Value>(&annotations_json)
        .map_err(|_| AttachmentError::InvalidData)?;

    // Atomic write: write to tmp file then rename, to avoid corrupt data on crash
    let tmp_path = file_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, annotations_json.as_bytes())
        .map_err(|e| AttachmentError::Io(e.to_string()))?;
    std::fs::rename(&tmp_path, &file_path)
        .map_err(|e| AttachmentError::Io(e.to_string()))?;

    tracing::debug!("Saved PDF annotations for: {}", pdf_path);
    Ok(())
}

/// Load PDF annotation data from `.oxidenote/annotations/`.
/// Returns an empty JSON array if no annotations exist.
#[tauri::command]
pub async fn load_pdf_annotations(
    pdf_path: String,
    state: State<'_, AppState>,
) -> Result<String, AttachmentError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(AttachmentError::NoVault)?;

    let hash = hash_path(&pdf_path);
    let file_path = base.join(".oxidenote").join("annotations").join(format!("{}.json", hash));

    if file_path.exists() {
        std::fs::read_to_string(&file_path)
            .map_err(|e| AttachmentError::Io(e.to_string()))
    } else {
        Ok(String::from("{\"annotations\":[]}"))
    }
}

/// Generate a deterministic hash for a file path to use as annotation filename.
/// Uses SHA-256 (truncated to 32 hex chars) for stability across Rust versions.
fn hash_path(path: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let result = hasher.finalize();
    // Use first 16 bytes (32 hex chars) for a stable, collision-resistant ID
    result.iter().take(16).map(|b| format!("{:02x}", b)).collect()
}
