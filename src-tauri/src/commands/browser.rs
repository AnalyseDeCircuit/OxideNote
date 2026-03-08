/**
 * Browser commands — open URLs in new webview windows
 *
 * Provides a Tauri command to open a URL in a separate browser window,
 * giving users an in-app browsing experience without compromising
 * the security of the main application window.
 */

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

#[derive(thiserror::Error, Debug)]
pub enum BrowserError {
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),
    #[error("Failed to open browser window: {0}")]
    WindowError(String),
}

impl serde::Serialize for BrowserError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Open a URL in a new Tauri webview window.
/// Each browser window gets a unique label derived from the current timestamp.
#[tauri::command]
pub fn open_browser_window(app: AppHandle, url: String) -> Result<(), BrowserError> {
    // Validate URL scheme — only allow http/https for security
    let parsed: url::Url = url
        .parse()
        .map_err(|e: url::ParseError| BrowserError::InvalidUrl(e.to_string()))?;

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(BrowserError::InvalidUrl(format!(
                "Unsupported scheme: {}. Only http/https are allowed.",
                scheme
            )));
        }
    }

    // Generate a unique window label
    let label = format!("browser-{}", chrono::Utc::now().timestamp_millis());
    let title = format!("Browser — {}", parsed.host_str().unwrap_or("unknown"));

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1024.0, 768.0)
        .resizable(true)
        .build()
        .map_err(|e| BrowserError::WindowError(e.to_string()))?;

    Ok(())
}
