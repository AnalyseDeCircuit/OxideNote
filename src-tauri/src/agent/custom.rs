//! Custom agent definitions — load and validate user-defined agents from vault.
//!
//! Custom agents are Markdown files in `<vault>/.oxidenote/agents/`.
//! Frontmatter declares metadata; the body is the system prompt.

use std::path::Path;

use serde::{Deserialize, Serialize};

// ── Types ───────────────────────────────────────────────────

/// Parsed custom agent definition from frontmatter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAgentDef {
    pub name: String,
    pub title: String,
    #[serde(default = "default_tools")]
    pub tools: Vec<String>,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub auto_apply: bool,
    #[serde(default)]
    pub schedule: Option<CustomSchedule>,
    /// Max vault_write calls per run (safety cap)
    #[serde(default = "default_max_writes")]
    pub max_writes: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomSchedule {
    pub enabled: bool,
    /// Simplified cron: "daily HH" | "weekly DAY HH" | "every Nh"
    pub cron: String,
}

fn default_tools() -> Vec<String> {
    vec![
        "vault_read".into(),
        "vault_search".into(),
        "vault_list".into(),
        "vault_link".into(),
    ]
}

fn default_scope() -> String {
    "entire_vault".into()
}

fn default_max_writes() -> u8 {
    10
}

// ── Allowed tool names for validation ───────────────────────

const VALID_TOOLS: &[&str] = &[
    "vault_read",
    "vault_search",
    "vault_list",
    "vault_link",
    "vault_write",
];

const VALID_SCOPES: &[&str] = &["current_note", "current_folder", "entire_vault"];

// ── Loading ─────────────────────────────────────────────────

/// Scan `<vault>/.oxidenote/agents/` and load all valid custom agent definitions.
/// Invalid files are logged and skipped.
/// Returns Vec<(definition, system_prompt_body)>.
pub fn load_custom_agents(vault_path: &Path) -> Vec<(CustomAgentDef, String)> {
    let agents_dir = vault_path.join(".oxidenote").join("agents");
    if !agents_dir.is_dir() {
        return Vec::new();
    }

    let mut agents = Vec::new();

    let entries = match std::fs::read_dir(&agents_dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("Failed to read agents directory: {}", e);
            return Vec::new();
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        match parse_agent_file(&path) {
            Ok((def, prompt)) => {
                if let Err(e) = validate_agent_def(&def) {
                    tracing::warn!("Invalid custom agent '{}': {}", path.display(), e);
                    continue;
                }
                agents.push((def, prompt));
            }
            Err(e) => {
                tracing::warn!("Failed to parse agent file '{}': {}", path.display(), e);
            }
        }
    }

    agents
}

/// Parse a single agent Markdown file into definition + prompt body.
fn parse_agent_file(path: &Path) -> Result<(CustomAgentDef, String), String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Split frontmatter from body
    let (frontmatter, body) = split_frontmatter(&content)
        .ok_or_else(|| "Missing YAML frontmatter (must start with ---)".to_string())?;

    let mut def: CustomAgentDef =
        serde_yaml::from_str(frontmatter).map_err(|e| format!("Invalid YAML: {}", e))?;

    // Use filename stem as name if not explicitly set or empty
    if def.name.is_empty() {
        def.name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unnamed")
            .to_string();
    }

    let prompt = body.trim().to_string();
    if prompt.is_empty() {
        return Err("System prompt body is empty".to_string());
    }

    Ok((def, prompt))
}

/// Split YAML frontmatter delimited by `---` from the Markdown body.
fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }

    // Find the closing ---
    let after_first = &trimmed[3..];
    let end = after_first.find("\n---")?;
    let frontmatter = &after_first[..end];
    let body = &after_first[end + 4..]; // skip "\n---"

    Some((frontmatter.trim(), body))
}

/// Validate that a custom agent definition is safe to execute.
fn validate_agent_def(def: &CustomAgentDef) -> Result<(), String> {
    // Name: alphanumeric + hyphens only
    if def.name.is_empty()
        || !def
            .name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "Name '{}' must be alphanumeric with hyphens/underscores",
            def.name
        ));
    }

    // Tools: must be subset of valid tools
    for tool in &def.tools {
        if !VALID_TOOLS.contains(&tool.as_str()) {
            return Err(format!("Unknown tool: {}", tool));
        }
    }

    // Scope: must be valid
    if !VALID_SCOPES.contains(&def.scope.as_str()) {
        return Err(format!("Invalid scope: {}", def.scope));
    }

    Ok(())
}
