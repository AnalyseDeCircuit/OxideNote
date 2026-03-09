//! Native function calling — tool schema generation for LLM providers
//! that support structured tool declarations (OpenAI, Claude, DeepSeek, etc.).
//!
//! Ollama falls back to XML-based tool calls parsed in `client.rs`.

use super::types::ToolSchema;

/// Generate tool schemas for the 5 vault-scoped agent tools.
/// `allowed_tools` filters which tools to include (for custom agents).
pub fn build_vault_tool_schemas(allowed_tools: &[String]) -> Vec<ToolSchema> {
    let all_tools = vec![
        ToolSchema {
            name: "vault_read".into(),
            description: "Read a note's content by its vault-relative path".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Vault-relative path to the note (e.g. 'notes/example.md')"
                    }
                },
                "required": ["path"]
            }),
        },
        ToolSchema {
            name: "vault_search".into(),
            description: "Search notes by keyword using full-text search (FTS5)".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query text"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 10)"
                    }
                },
                "required": ["query"]
            }),
        },
        ToolSchema {
            name: "vault_list".into(),
            description: "List notes and folders in the vault, optionally filtered by folder path".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "Folder path to list (empty string for root)"
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "Whether to list recursively (default: false)"
                    }
                },
                "required": []
            }),
        },
        ToolSchema {
            name: "vault_link".into(),
            description: "Query backlinks (notes linking TO this note) and outlinks (notes this note links TO)".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Vault-relative path of the note to query"
                    },
                    "direction": {
                        "type": "string",
                        "enum": ["backlinks", "outlinks", "both"],
                        "description": "Link direction to query (default: 'both')"
                    }
                },
                "required": ["path"]
            }),
        },
        ToolSchema {
            name: "vault_write".into(),
            description: "Write or modify a note's content. Creates the file if it doesn't exist. Writes are buffered for approval unless auto_apply is enabled.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Vault-relative path for the note"
                    },
                    "content": {
                        "type": "string",
                        "description": "Full Markdown content to write"
                    }
                },
                "required": ["path", "content"]
            }),
        },
    ];

    // Filter to only allowed tools
    all_tools
        .into_iter()
        .filter(|t| allowed_tools.iter().any(|a| a == &t.name))
        .collect()
}

/// Default tool list for built-in agents (all 5 tools)
pub fn default_agent_tools() -> Vec<String> {
    vec![
        "vault_read".into(),
        "vault_search".into(),
        "vault_list".into(),
        "vault_link".into(),
        "vault_write".into(),
    ]
}

/// Read-only tool list (no vault_write)
pub fn readonly_agent_tools() -> Vec<String> {
    vec![
        "vault_read".into(),
        "vault_search".into(),
        "vault_list".into(),
        "vault_link".into(),
    ]
}
