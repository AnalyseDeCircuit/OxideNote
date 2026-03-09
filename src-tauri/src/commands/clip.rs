/**
 * Web Clipper — Fetch a web page and convert its HTML to Markdown
 *
 * Provides a Tauri command that:
 *   1. Fetches the page HTML via reqwest (GET, with timeout)
 *   2. Converts HTML to Markdown using htmd
 *   3. Prepends a YAML frontmatter block with source URL and clip date
 *   4. Saves the result as a new `.md` note in the vault
 *
 * Security: Only http/https URLs are allowed. Paths are validated
 * to stay inside the vault directory.
 */

use serde::Serialize;
use tauri::State;

use crate::commands::util::{atomic_write, validate_path_inside_vault};
use crate::state::AppState;

/// Maximum allowed response body size (10 MB)
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

// ── Error type ───────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ClipError {
    #[error("No vault opened")]
    NoVault,
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),
    #[error("Failed to fetch page: {0}")]
    FetchFailed(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Access denied: path outside vault")]
    AccessDenied,
}

impl Serialize for ClipError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Clip a web page: fetch HTML, convert to Markdown, save as a new note.
///
/// # Arguments
/// * `url` — The web page URL to clip (must be http or https)
/// * `folder` — Target folder path relative to vault root (empty string for root)
///
/// # Returns
/// The relative path of the created note file
#[tauri::command]
pub async fn clip_webpage(
    url: String,
    folder: String,
    state: State<'_, AppState>,
) -> Result<String, ClipError> {
    let vault_path = state.vault_path.read().clone();
    let base = vault_path.ok_or(ClipError::NoVault)?;

    // Validate URL scheme
    let parsed: url::Url = url
        .parse()
        .map_err(|e: url::ParseError| ClipError::InvalidUrl(e.to_string()))?;

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(ClipError::InvalidUrl(format!(
                "Unsupported scheme: {}. Only http/https are allowed.",
                scheme
            )));
        }
    }

    // Fetch the page HTML — redirect policy re-validates scheme on each hop
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 3 {
            attempt.error("too many redirects")
        } else if let Some("http" | "https") = attempt.url().scheme().into() {
            attempt.follow()
        } else {
            attempt.error("redirect to non-http(s) scheme blocked")
        }
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(redirect_policy)
        .build()
        .map_err(|e| ClipError::FetchFailed(e.to_string()))?;

    let response = client
        .get(parsed.as_str())
        .header("User-Agent", "OxideNote-WebClipper/1.0")
        .send()
        .await
        .map_err(|e| ClipError::FetchFailed(e.to_string()))?;

    // Reject responses that exceed the size limit to prevent OOM
    if let Some(len) = response.content_length() {
        if len as usize > MAX_RESPONSE_BYTES {
            return Err(ClipError::FetchFailed(format!(
                "Response too large: {} bytes (max {})",
                len, MAX_RESPONSE_BYTES
            )));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| ClipError::FetchFailed(e.to_string()))?;

    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ClipError::FetchFailed(format!(
            "Response too large: {} bytes (max {})",
            bytes.len(), MAX_RESPONSE_BYTES
        )));
    }

    let html = String::from_utf8_lossy(&bytes).to_string();

    // Convert HTML to Markdown
    let markdown = htmd::convert(&html).unwrap_or_else(|_| html.clone());

    // Extract page title from HTML <title> tag
    let title = extract_title(&html).unwrap_or_else(|| {
        parsed
            .host_str()
            .unwrap_or("Untitled")
            .to_string()
    });

    // Sanitize title for use as filename
    let safe_title = sanitize_filename(&title);
    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d").to_string();

    // Build the note content with frontmatter
    let content = format!(
        "---\nsource: {}\nclipped: {}\n---\n\n# {}\n\n{}\n",
        parsed.as_str(),
        date_str,
        title,
        markdown.trim()
    );

    // Determine target directory
    let target_dir = if folder.is_empty() {
        base.clone()
    } else {
        validate_path_inside_vault(&base, &folder).map_err(|_| ClipError::AccessDenied)?
    };

    std::fs::create_dir_all(&target_dir)
        .map_err(|e| ClipError::Io(e.to_string()))?;

    // Generate unique filename
    let mut file_path = target_dir.join(format!("{}.md", safe_title));
    let mut counter = 1u32;
    while file_path.exists() {
        file_path = target_dir.join(format!("{}-{}.md", safe_title, counter));
        counter += 1;
    }

    // Validate the final file path stays inside vault
    let rel_file = file_path
        .strip_prefix(&base)
        .map_err(|_| ClipError::AccessDenied)?
        .to_string_lossy();
    validate_path_inside_vault(&base, &rel_file).map_err(|_| ClipError::AccessDenied)?;

    atomic_write(&file_path, content.as_bytes())
        .map_err(|e| ClipError::Io(e.to_string()))?;

    // Return the relative path from vault root
    let rel_path = file_path
        .strip_prefix(&base)
        .unwrap_or(&file_path)
        .to_string_lossy()
        .to_string();

    tracing::info!("Clipped webpage '{}' to {}", parsed.as_str(), rel_path);
    Ok(rel_path)
}

/// Extract <title> text from raw HTML.
/// Operates entirely on the lowercased copy to avoid byte-index mismatch
/// between `to_lowercase()` output and the original (which can differ in
/// length for certain Unicode codepoints like İ, ß, etc.).
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let tag_end = lower[start..].find('>')?;
    let content_start = start + tag_end + 1;
    let end = lower[content_start..].find("</title>")?;
    // Slice from `lower` — not `html` — so indices stay consistent
    let title = &lower[content_start..content_start + end];
    let trimmed = title.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Sanitize a string for use as a filename
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut trimmed = cleaned.trim().to_string();
    while trimmed.contains("  ") {
        trimmed = trimmed.replace("  ", " ");
    }
    if trimmed.is_empty() {
        "Clipped".to_string()
    } else {
        // Limit length to 80 chars for filesystem safety
        trimmed.chars().take(80).collect()
    }
}
