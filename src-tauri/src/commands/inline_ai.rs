//! Inline AI operations for the editor.
//!
//! Provides non-streaming LLM calls for text transformations
//! (rewrite, translate, summarize, etc.) and continuation at cursor.
//! Uses the shared `llm/client.rs` infrastructure — no streaming needed
//! since inline AI responses are typically short and returned as a whole.

use serde::Serialize;
use tauri::State;
use tokio::sync::watch;

use crate::llm::client::{call_llm_complete, LlmError};
use crate::llm::types::{ChatConfig, ChatMessage};
use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum InlineAiError {
    #[error("LLM error: {0}")]
    Llm(String),
    #[error("Request aborted")]
    Aborted,
}

impl Serialize for InlineAiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<LlmError> for InlineAiError {
    fn from(e: LlmError) -> Self {
        match e {
            LlmError::Aborted => InlineAiError::Aborted,
            other => InlineAiError::Llm(other.to_string()),
        }
    }
}

// ── System prompts ──────────────────────────────────────────

/// System prompt for text transformation operations.
/// Adapts to file type when a non-empty extension is provided.
fn transform_system_prompt(file_ext: &str) -> String {
    let base = "You are a concise writing assistant embedded in a Markdown editor. \
     The user will provide a text selection and an instruction. \
     Apply the instruction to the text and return ONLY the transformed result. \
     Do NOT include explanations, preamble, or markdown code fences around the result.";

    match file_ext {
        "typ" => format!(
            "{base} The file is Typst. Preserve Typst syntax (#set, #show, $ math $, \
             #import, etc.). When converting from LaTeX, use equivalent Typst constructs."
        ),
        "tex" => format!(
            "{base} The file is LaTeX. Preserve LaTeX commands (\\section, \\begin, \
             \\usepackage, $ math $, etc.). When converting from Typst, use equivalent LaTeX."
        ),
        _ => format!(
            "{base} Preserve the original Markdown formatting style (headings, lists, links, etc.) \
             unless the instruction explicitly asks to change it."
        ),
    }
}

/// System prompt for text continuation
fn continue_system_prompt() -> String {
    "You are a writing assistant embedded in a Markdown editor. \
     The user will provide the text preceding the cursor. \
     Continue writing naturally from where the text ends. \
     Match the existing tone, style, and language. \
     Return ONLY the continuation — do NOT repeat any of the existing text. \
     Output 1-3 sentences unless the context clearly calls for more."
        .to_string()
}

// ── Commands ────────────────────────────────────────────────

/// Transform selected text with a given instruction.
///
/// Supports operations like rewrite, translate, summarize, explain, etc.
/// The `context` parameter provides surrounding text for better results.
#[tauri::command]
pub async fn inline_ai_transform(
    text: String,
    instruction: String,
    context: String,
    note_title: String,
    file_ext: String,
    config: ChatConfig,
    _state: State<'_, AppState>,
) -> Result<String, InlineAiError> {
    let (_, mut abort_rx) = watch::channel(false);

    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: transform_system_prompt(&file_ext),
        reasoning: None,
        images: None,
    }];

    // Build user message with context
    let user_content = if context.is_empty() {
        format!(
            "Note: \"{note_title}\"\n\n\
             Instruction: {instruction}\n\n\
             Text to transform:\n{text}"
        )
    } else {
        format!(
            "Note: \"{note_title}\"\n\n\
             Instruction: {instruction}\n\n\
             Surrounding context:\n{context}\n\n\
             Text to transform:\n{text}"
        )
    };

    messages.push(ChatMessage {
        role: "user".into(),
        content: user_content,
        reasoning: None,
        images: None,
    });

    let response = call_llm_complete(&config, messages, None, &mut abort_rx).await?;
    Ok(response.content)
}

/// Continue writing from the cursor position.
///
/// Takes the preceding text (up to ~2000 chars) and asks the LLM
/// to generate a natural continuation matching the existing style.
#[tauri::command]
pub async fn inline_ai_continue(
    preceding_text: String,
    note_title: String,
    config: ChatConfig,
    _state: State<'_, AppState>,
) -> Result<String, InlineAiError> {
    let (_, mut abort_rx) = watch::channel(false);

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: continue_system_prompt(),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: format!(
                "Note: \"{note_title}\"\n\n\
                 Continue from here:\n{preceding_text}"
            ),
            reasoning: None,
            images: None,
        },
    ];

    let response = call_llm_complete(&config, messages, None, &mut abort_rx).await?;
    Ok(response.content)
}

// ── Graph AI analysis ───────────────────────────────────────

/// System prompt for graph structure analysis
fn graph_analysis_system_prompt() -> String {
    "You are a knowledge graph analyst embedded in a note-taking app. \
     The user will provide a list of note titles and their link relationships. \
     Analyze the graph structure and identify:\n\
     1. **Thematic clusters** — groups of notes that belong to the same topic/domain\n\
     2. **Key hub notes** — notes that connect multiple clusters\n\
     3. **Isolated notes** — notes with few or no connections that might benefit from linking\n\
     4. **Structural observations** — patterns, gaps, or suggestions for better organization\n\n\
     Format your response in Markdown with clear sections. \
     Use the user's language (detect from note titles). \
     Keep the analysis concise and actionable."
        .to_string()
}

/// Analyze the knowledge graph structure using LLM.
///
/// Receives graph node titles and link relationships, returns a Markdown
/// analysis of thematic clusters, hub notes, and structural insights.
#[tauri::command]
pub async fn analyze_graph(
    nodes: Vec<String>,
    edges: Vec<(String, String)>,
    config: ChatConfig,
    _state: State<'_, AppState>,
) -> Result<String, InlineAiError> {
    let (_, mut abort_rx) = watch::channel(false);

    // Cap input size to avoid exceeding LLM context window.
    // For very large graphs, truncate to top-300 nodes and their edges.
    const MAX_NODES: usize = 300;
    const MAX_EDGES: usize = 1000;

    let truncated_nodes = nodes.len() > MAX_NODES;
    let display_nodes = if truncated_nodes { &nodes[..MAX_NODES] } else { &nodes[..] };
    let node_list = display_nodes.join(", ");

    let truncated_edges = edges.len() > MAX_EDGES;
    let display_edges = if truncated_edges { &edges[..MAX_EDGES] } else { &edges[..] };
    let edge_list: Vec<String> = display_edges
        .iter()
        .map(|(src, tgt)| format!("{src} → {tgt}"))
        .collect();
    let edge_text = if edge_list.is_empty() {
        "No links between notes.".to_string()
    } else {
        edge_list.join("\n")
    };

    let mut user_content = format!(
        "Here is my knowledge graph:\n\n\
         **Notes ({count}):** {node_list}\n\n\
         **Links ({edge_count}):**\n{edge_text}",
        count = nodes.len(),
        edge_count = edges.len(),
    );
    if truncated_nodes || truncated_edges {
        user_content.push_str(&format!(
            "\n\n(Note: graph truncated for analysis — showing {}/{} nodes, {}/{} edges)",
            display_nodes.len(), nodes.len(), display_edges.len(), edges.len()
        ));
    }

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: graph_analysis_system_prompt(),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: user_content,
            reasoning: None,
            images: None,
        },
    ];

    let response = call_llm_complete(&config, messages, None, &mut abort_rx).await?;
    Ok(response.content)
}

// ── Smart Tag Suggestion ────────────────────────────────────

/// System prompt for tag suggestion
fn suggest_tags_system_prompt() -> String {
    "You are a tag suggestion assistant embedded in a Markdown knowledge base. \
     The user will provide a note's content and the list of existing tags in their vault. \
     Suggest 3-8 relevant tags for the note. \
     Prefer reusing existing tags when appropriate. \
     You may also suggest new tags that don't exist yet. \
     Support hierarchical tags with `/` separator (e.g. `dev/rust`). \
     Match the language of existing tags and note content. \
     Return ONLY a JSON array of tag strings, no explanation. \
     Example: [\"research\", \"ai/llm\", \"project/oxidenote\"]"
        .to_string()
}

/// Suggest tags for a note based on its content and existing vault tags.
///
/// Returns a JSON array of suggested tag strings, parsed from LLM output.
#[tauri::command]
pub async fn suggest_tags(
    content: String,
    note_title: String,
    existing_tags: Vec<String>,
    config: ChatConfig,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, InlineAiError> {
    let (_, mut abort_rx) = watch::channel(false);

    let existing = if existing_tags.is_empty() {
        "No existing tags.".to_string()
    } else {
        existing_tags.join(", ")
    };

    // Truncate content to avoid exceeding context window
    const MAX_CONTENT_CHARS: usize = 4000;
    let trimmed_content = if content.len() > MAX_CONTENT_CHARS {
        &content[..content.floor_char_boundary(MAX_CONTENT_CHARS)]
    } else {
        &content
    };

    let user_content = format!(
        "Note title: \"{note_title}\"\n\n\
         Existing tags in vault: {existing}\n\n\
         Note content:\n{trimmed_content}"
    );

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: suggest_tags_system_prompt(),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: user_content,
            reasoning: None,
            images: None,
        },
    ];

    let response = call_llm_complete(&config, messages, None, &mut abort_rx).await?;

    // Parse the JSON array from LLM response, with fallback extraction
    let raw = response.content.trim();
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(raw) {
        return Ok(tags);
    }
    // Try extracting JSON array from markdown code block
    if let Some(start) = raw.find('[') {
        if let Some(end) = raw.rfind(']') {
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(&raw[start..=end]) {
                return Ok(tags);
            }
        }
    }
    // Fallback: return raw text as single tag suggestion
    Ok(vec![raw.to_string()])
}

// ── Smart Link Suggestion ───────────────────────────────────

/// System prompt for link suggestion
fn suggest_links_system_prompt() -> String {
    "You are a link suggestion assistant embedded in a Markdown knowledge base. \
     The user will provide a note's content and a list of all other note titles in their vault. \
     Suggest 3-10 existing notes that are most relevant to link to from this note. \
     Consider semantic similarity, topic overlap, and potential knowledge connections. \
     Return ONLY a JSON array of note titles (exact matches from the provided list). \
     Example: [\"Getting Started\", \"Architecture Overview\"]"
        .to_string()
}

/// Suggest links to other notes based on content similarity.
///
/// Returns a JSON array of note titles that the current note should link to.
#[tauri::command]
pub async fn suggest_links(
    content: String,
    note_title: String,
    all_titles: Vec<String>,
    config: ChatConfig,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, InlineAiError> {
    let (_, mut abort_rx) = watch::channel(false);

    // Cap the number of titles to avoid exceeding context window
    const MAX_TITLES: usize = 500;
    let display_titles = if all_titles.len() > MAX_TITLES {
        &all_titles[..MAX_TITLES]
    } else {
        &all_titles[..]
    };
    let titles_list = display_titles.join(", ");

    // Truncate content
    const MAX_CONTENT_CHARS: usize = 3000;
    let trimmed_content = if content.len() > MAX_CONTENT_CHARS {
        &content[..content.floor_char_boundary(MAX_CONTENT_CHARS)]
    } else {
        &content
    };

    let user_content = format!(
        "Current note: \"{note_title}\"\n\n\
         All notes in vault: {titles_list}\n\n\
         Current note content:\n{trimmed_content}"
    );

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: suggest_links_system_prompt(),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: user_content,
            reasoning: None,
            images: None,
        },
    ];

    let response = call_llm_complete(&config, messages, None, &mut abort_rx).await?;

    // Parse the JSON array from LLM response
    let raw = response.content.trim();
    if let Ok(titles) = serde_json::from_str::<Vec<String>>(raw) {
        return Ok(titles);
    }
    if let Some(start) = raw.find('[') {
        if let Some(end) = raw.rfind(']') {
            if let Ok(titles) = serde_json::from_str::<Vec<String>>(&raw[start..=end]) {
                return Ok(titles);
            }
        }
    }
    Ok(vec![])
}

// ── Memory Extraction ───────────────────────────────────────

/// System prompt for extracting memorable facts from a conversation.
fn extract_memories_system_prompt() -> String {
    "You are a memory extraction assistant for a knowledge-base AI. \
     Analyze the conversation and extract key user preferences, writing style notes, \
     important facts, or recurring instructions that should be remembered across sessions. \
     Only extract genuinely useful, persistent preferences — not ephemeral details. \
     Return a JSON array of objects with \"content\" and \"category\" fields. \
     Categories: general, preference, style, context, instruction, typst, latex. \
     If nothing worth remembering is found, return an empty array []. \
     Example: [{\"content\": \"user prefers bullet points over paragraphs\", \"category\": \"style\"}, \
     {\"content\": \"user writes academic papers in Typst\", \"category\": \"typst\"}]"
        .to_string()
}

/// Extract memorable facts from a chat conversation.
///
/// Called when switching away from or ending a session with enough messages.
/// Returns a list of {content, category} objects parsed from LLM output.
#[tauri::command]
pub async fn extract_memories(
    conversation: String,
    config: ChatConfig,
    _state: State<'_, AppState>,
) -> Result<Vec<MemoryExtract>, InlineAiError> {
    let (_, mut abort_rx) = watch::channel(false);

    // Truncate conversation to stay within context window
    const MAX_CHARS: usize = 6000;
    let trimmed = if conversation.len() > MAX_CHARS {
        &conversation[..conversation.floor_char_boundary(MAX_CHARS)]
    } else {
        &conversation
    };

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: extract_memories_system_prompt(),
            reasoning: None,
            images: None,
        },
        ChatMessage {
            role: "user".into(),
            content: format!("Extract memorable facts from this conversation:\n\n{trimmed}"),
            reasoning: None,
            images: None,
        },
    ];

    let response = call_llm_complete(&config, messages, None, &mut abort_rx).await?;

    let raw = response.content.trim();
    // Try parsing directly
    if let Ok(memories) = serde_json::from_str::<Vec<MemoryExtract>>(raw) {
        return Ok(memories);
    }
    // Try extracting from code block
    if let Some(start) = raw.find('[') {
        if let Some(end) = raw.rfind(']') {
            if let Ok(memories) = serde_json::from_str::<Vec<MemoryExtract>>(&raw[start..=end]) {
                return Ok(memories);
            }
        }
    }
    Ok(vec![])
}

/// A single extracted memory from a conversation.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct MemoryExtract {
    pub content: String,
    pub category: String,
}
