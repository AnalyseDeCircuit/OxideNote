//! Embedding providers for semantic search.
//!
//! Supports two modes:
//! - **API provider**: OpenAI-compatible HTTP endpoint (works with OpenAI, Ollama, etc.)
//! - **Local provider**: (future) ONNX Runtime with bundled model
//!
//! The pipeline: text → chunk → embed → store in SQLite → cosine search at query time.

use serde::{Deserialize, Serialize};

// ── Provider configuration ──────────────────────────────────

/// Embedding provider type selector
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingProviderType {
    Api,
    Local,
}

/// Configuration for the embedding provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub provider: EmbeddingProviderType,
    /// API endpoint URL (e.g. "https://api.openai.com/v1/embeddings" or "http://localhost:11434/api/embed")
    pub api_url: String,
    /// API key (OpenAI) or empty for local Ollama
    pub api_key: String,
    /// Model name (e.g. "text-embedding-3-small", "nomic-embed-text")
    pub model: String,
    /// Expected embedding dimensions (e.g. 1536 for OpenAI, 384 for MiniLM)
    pub dimensions: usize,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: EmbeddingProviderType::Api,
            api_url: String::new(),
            api_key: String::new(),
            model: String::from("text-embedding-3-small"),
            dimensions: 1536,
        }
    }
}

// ── Text chunking ───────────────────────────────────────────

/// Maximum characters per chunk (roughly aligned with token limits)
const MAX_CHUNK_CHARS: usize = 1000;

/// Minimum characters to form a chunk (skip tiny fragments)
const MIN_CHUNK_CHARS: usize = 50;

/// Split note content into chunks suitable for embedding.
/// Uses paragraph-level splitting, merging small paragraphs into larger chunks.
pub fn chunk_text(content: &str) -> Vec<String> {
    // Strip YAML frontmatter
    let text = strip_frontmatter(content);

    let paragraphs: Vec<&str> = text.split("\n\n").collect();
    let mut chunks = Vec::new();
    let mut current = String::new();

    for para in paragraphs {
        let trimmed = para.trim();
        if trimmed.is_empty() {
            continue;
        }

        // If adding this paragraph would exceed the limit, flush current chunk
        if !current.is_empty() && current.len() + trimmed.len() + 2 > MAX_CHUNK_CHARS {
            if current.len() >= MIN_CHUNK_CHARS {
                chunks.push(current.clone());
            }
            current.clear();
        }

        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(trimmed);

        // If single paragraph exceeds max, split at sentence boundaries
        if current.len() > MAX_CHUNK_CHARS {
            let split_chunks = split_long_text(&current);
            for sc in split_chunks {
                if sc.len() >= MIN_CHUNK_CHARS {
                    chunks.push(sc);
                }
            }
            current.clear();
        }
    }

    // Push remaining text
    if current.len() >= MIN_CHUNK_CHARS {
        chunks.push(current);
    }

    // If no chunks were produced but text exists, use the whole content
    if chunks.is_empty() && text.len() >= MIN_CHUNK_CHARS {
        chunks.push(text.trim().to_string());
    }

    chunks
}

/// Strip YAML frontmatter (--- delimited) from content
fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with("---") {
        return content;
    }
    // Find the closing ---
    // SAFETY: all offsets derive from ASCII-only delimiters ("---", "\n---")
    // so the computed byte index always lands on a char boundary.
    if let Some(end) = content[3..].find("\n---") {
        let after = end + 3 + 4; // skip past "\n---"
        if let Some(rest) = content.get(after..) {
            return rest;
        }
    }
    content
}

/// Split a long piece of text at sentence boundaries (. ! ?)
fn split_long_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for line in text.lines() {
        for sentence in split_sentences(line) {
            if !current.is_empty() && current.len() + sentence.len() + 1 > MAX_CHUNK_CHARS {
                chunks.push(current.clone());
                current.clear();
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&sentence);
        }
        if !current.is_empty() {
            current.push('\n');
        }
    }

    if !current.is_empty() {
        chunks.push(current.trim().to_string());
    }

    chunks
}

/// Naive sentence splitter (handles . ! ? followed by space/newline)
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();

    for i in 0..len {
        current.push(chars[i]);
        let is_end = matches!(chars[i], '.' | '!' | '?' | '。' | '！' | '？');
        let followed_by_space = i + 1 >= len || chars[i + 1].is_whitespace();
        if is_end && followed_by_space && current.len() > 10 {
            sentences.push(current.trim().to_string());
            current.clear();
        }
    }

    if !current.trim().is_empty() {
        sentences.push(current.trim().to_string());
    }

    sentences
}

// ── API-based embedding provider ────────────────────────────

/// Request body for OpenAI-compatible embedding API
#[derive(Serialize)]
struct EmbeddingRequest {
    model: String,
    input: Vec<String>,
    /// Output embedding dimensions (supported by text-embedding-3-* models)
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<usize>,
}

/// OpenAI embedding response format
#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
    /// Position index corresponding to the input array order
    index: usize,
}

/// Ollama embedding request format
#[derive(Serialize)]
struct OllamaEmbedRequest {
    model: String,
    input: Vec<String>,
}

/// Ollama embedding response format
#[derive(Deserialize)]
struct OllamaEmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

/// Generate embeddings for a batch of text chunks via API.
/// Supports both OpenAI-compatible and Ollama endpoints.
///
/// URL normalization:
/// - If URL ends with `/api/embed` or `/api/embeddings` → Ollama path
/// - If URL contains `localhost:11434` or `127.0.0.1:11434` and has no
///   `/v1/` segment → auto-append `/api/embed` and use Ollama path
/// - Otherwise → OpenAI-compatible path; auto-append `/v1/embeddings`
///   if the URL has no path or ends with a bare port/host
pub async fn embed_texts(
    config: &EmbeddingConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }

    // Only allow HTTP/HTTPS schemes to prevent SSRF
    if !config.api_url.starts_with("http://") && !config.api_url.starts_with("https://") {
        return Err("API URL must use http:// or https:// scheme".to_string());
    }

    let client = reqwest::Client::new();
    let url = config.api_url.trim_end_matches('/');

    // Parse URL to inspect path component safely (avoids substring false-positives)
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("Invalid API URL: {}", e))?;
    let path = parsed.path();

    // Detect Ollama by explicit endpoint path
    let has_ollama_path =
        path.ends_with("/api/embed") || path.ends_with("/api/embeddings");

    // Heuristic: bare Ollama host (default port) without an OpenAI-style /v1/ segment
    let is_bare_ollama_host = !path.contains("/v1")
        && parsed.port() == Some(11434)
        && matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1"));

    let is_ollama = has_ollama_path || is_bare_ollama_host;

    // Build resolved URL: only auto-append the endpoint suffix when the URL
    // has no meaningful path (root "/" or empty). If the user already provided
    // a specific path, trust it as-is to avoid mangling proxy/custom URLs.
    let resolved_url = if is_ollama {
        if has_ollama_path {
            url.to_string()
        } else {
            // Bare Ollama host → append /api/embed
            format!("{}/api/embed", url)
        }
    } else if path == "/" || path.is_empty() {
        // Bare base URL (e.g. https://api.openai.com) → append full path
        format!("{}/v1/embeddings", url)
    } else if path.ends_with("/v1") {
        // User typed https://api.openai.com/v1 → just add /embeddings
        format!("{}/embeddings", url)
    } else {
        // URL already has a non-trivial path — use as-is
        url.to_string()
    };

    if is_ollama {
        embed_via_ollama(&client, config, texts, &resolved_url).await
    } else {
        embed_via_openai(&client, config, texts, &resolved_url).await
    }
}

/// Maximum number of input texts per single API call.
/// Alibaba DashScope (Qwen) limits v3/v4 to 10 inputs per request;
/// OpenAI allows up to 2048. We use a provider-aware cap.
const MAX_INPUTS_QWEN: usize = 10;
const MAX_INPUTS_DEFAULT: usize = 256;

/// OpenAI-compatible embedding API call.
/// Automatically sub-batches if `texts` exceeds the per-request limit.
async fn embed_via_openai(
    client: &reqwest::Client,
    config: &EmbeddingConfig,
    texts: &[String],
    url: &str,
) -> Result<Vec<Vec<f32>>, String> {
    // Determine whether to send the `dimensions` param.
    // Supported by: OpenAI text-embedding-3-*, Qwen text-embedding-v3/v4
    let is_qwen = config.model.starts_with("text-embedding-v3")
        || config.model.starts_with("text-embedding-v4");
    let dimensions = if config.model.starts_with("text-embedding-3") || is_qwen {
        Some(config.dimensions)
    } else {
        None
    };

    // Provider-aware batch size: Qwen v3/v4 cap at 10, others much higher
    let max_per_call = if is_qwen { MAX_INPUTS_QWEN } else { MAX_INPUTS_DEFAULT };

    let mut all_embeddings = Vec::with_capacity(texts.len());

    // Sub-batch to stay within per-request input limits
    for sub_batch in texts.chunks(max_per_call) {
        let body = EmbeddingRequest {
            model: config.model.clone(),
            input: sub_batch.to_vec(),
            dimensions,
        };

        let mut req = client
            .post(url)
            .header("Content-Type", "application/json");

        if !config.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", config.api_key));
        }

        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("API request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("API error {}: {}", status, text));
        }

        let data: EmbeddingResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse API response: {}", e))?;

        // Sort by index to guarantee input-order alignment
        // (API spec permits out-of-order responses)
        let mut items = data.data;
        items.sort_by_key(|d| d.index);
        all_embeddings.extend(items.into_iter().map(|d| d.embedding));
    }

    Ok(all_embeddings)
}

/// Ollama embedding API call.
/// Ollama has no strict per-request input limit, but we sub-batch
/// to keep memory usage bounded for large vaults.
async fn embed_via_ollama(
    client: &reqwest::Client,
    config: &EmbeddingConfig,
    texts: &[String],
    url: &str,
) -> Result<Vec<Vec<f32>>, String> {
    let mut all_embeddings = Vec::with_capacity(texts.len());

    // Ollama can handle batches but we cap at a reasonable size
    for sub_batch in texts.chunks(MAX_INPUTS_DEFAULT) {
        let body = OllamaEmbedRequest {
            model: config.model.clone(),
            input: sub_batch.to_vec(),
        };

        let resp = client
            .post(url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama error {}: {}", status, text));
        }

        let data: OllamaEmbedResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

        all_embeddings.extend(data.embeddings);
    }

    Ok(all_embeddings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_text_basic() {
        let content = "# Title\n\nFirst paragraph with some text.\n\nSecond paragraph.";
        let chunks = chunk_text(content);
        // Both paragraphs should merge into one chunk (below MAX_CHUNK_CHARS)
        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_chunk_text_frontmatter() {
        let content = "---\ntitle: Test\ntags: [a]\n---\n\nActual content here that is long enough to form a chunk.";
        let chunks = chunk_text(content);
        assert!(!chunks.is_empty());
        // Frontmatter should be stripped
        assert!(!chunks[0].contains("tags:"));
    }

    #[test]
    fn test_strip_frontmatter() {
        let content = "---\ntitle: Test\n---\nBody text";
        let stripped = strip_frontmatter(content);
        assert_eq!(stripped.trim(), "Body text");
    }
}
