use regex::Regex;
use std::sync::LazyLock;

/// Parsed metadata from a markdown note.
#[derive(Debug, Clone, Default)]
pub struct ParsedNote {
    pub title: String,
    pub tags: Vec<String>,
    pub links: Vec<String>,       // WikiLink targets (resolved name)
    pub aliases: Vec<String>,     // Frontmatter aliases for WikiLink resolution
    pub created_at: Option<String>,
    pub frontmatter_json: Option<String>,
    pub content: String,          // Body text for FTS (frontmatter stripped)
}

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap());

static INLINE_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([a-zA-Z\u4e00-\u9fff][\w\u4e00-\u9fff/\-]*)").unwrap());

/// Parse a markdown file's content, extracting frontmatter, wikilinks, and tags.
pub fn parse_note(content: &str, file_name: &str) -> ParsedNote {
    let mut result = ParsedNote::default();

    // Extract frontmatter with precise end detection
    // 使用字节级搜索直接定位闭合 ---，正确处理 \n 和 \r\n 两种换行
    let body = if content.starts_with("---") {
        let after_open = &content[3..];
        // 尝试在原始字节流中找到行首的 ---
        // 支持 LF (\n---\n) 和 CRLF (\r\n---\r\n) 两种换行格式
        let (end_pos, skip_len) = if let Some(pos) = after_open.find("\n---\n") {
            (pos + 1, pos + 1 + 3 + 1) // +1 跳过 \n，3 是 "---"，+1 跳过尾部 \n
        } else if let Some(pos) = after_open.find("\r\n---\r\n") {
            (pos + 2, pos + 2 + 3 + 2) // +2 跳过 \r\n
        } else if let Some(pos) = after_open.find("\n---\r\n") {
            (pos + 1, pos + 1 + 3 + 2) // 混合换行：前 \n，后 \r\n
        } else {
            // 末尾情况：文件以 \n--- 结尾但没有尾部换行
            if let Some(pos) = after_open.find("\n---") {
                let remainder = &after_open[pos + 1 + 3..];
                if remainder.is_empty() || remainder == "\n" || remainder == "\r\n" {
                    (pos + 1, after_open.len())
                } else {
                    (0, 0) // 不是合法的闭合标记
                }
            } else {
                (0, 0)
            }
        };

        if skip_len > 0 {
            let yaml_str = after_open[..end_pos].trim();
            parse_frontmatter(yaml_str, &mut result);
            let remaining = &after_open[skip_len..];
            remaining
        } else {
            content
        }
    } else {
        content
    };

    // Store body only (without frontmatter) for FTS
    result.content = body.to_string();

    // If no title from frontmatter, try first heading
    if result.title.is_empty() {
        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("# ") {
                result.title = trimmed[2..].trim().to_string();
                break;
            }
            if !trimmed.is_empty() {
                break;
            }
        }
    }

    // Fallback to filename
    if result.title.is_empty() {
        result.title = crate::commands::util::strip_note_extension(file_name).to_string();
    }

    // Extract WikiLinks
    for cap in WIKILINK_RE.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            let link_target = m.as_str().trim().to_string();
            if !result.links.contains(&link_target) {
                result.links.push(link_target);
            }
        }
    }

    // Extract inline tags (in addition to frontmatter tags)
    for cap in INLINE_TAG_RE.captures_iter(body) {
        if let Some(m) = cap.get(1) {
            let tag = m.as_str().to_string();
            if !result.tags.contains(&tag) {
                result.tags.push(tag);
            }
        }
    }

    result
}

fn parse_frontmatter(yaml_str: &str, result: &mut ParsedNote) {
    if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(yaml_str) {
        // Store raw frontmatter as JSON
        if let Ok(json) = serde_json::to_string(&value) {
            result.frontmatter_json = Some(json);
        }

        if let Some(mapping) = value.as_mapping() {
            // Title
            if let Some(title) = mapping.get(&serde_yaml::Value::String("title".into())) {
                if let Some(s) = title.as_str() {
                    result.title = s.to_string();
                }
            }

            // Created date
            if let Some(created) = mapping.get(&serde_yaml::Value::String("created".into())) {
                if let Some(s) = created.as_str() {
                    result.created_at = Some(s.to_string());
                }
            }
            // Also check "date" field
            if result.created_at.is_none() {
                if let Some(date) = mapping.get(&serde_yaml::Value::String("date".into())) {
                    if let Some(s) = date.as_str() {
                        result.created_at = Some(s.to_string());
                    }
                }
            }

            // Tags from frontmatter
            if let Some(tags) = mapping.get(&serde_yaml::Value::String("tags".into())) {
                if let Some(seq) = tags.as_sequence() {
                    for t in seq {
                        if let Some(s) = t.as_str() {
                            let tag = s.to_string();
                            if !result.tags.contains(&tag) {
                                result.tags.push(tag);
                            }
                        }
                    }
                }
            }

            // Aliases for WikiLink resolution (e.g. [[old-name]] resolves to this note)
            if let Some(aliases) = mapping.get(&serde_yaml::Value::String("aliases".into())) {
                if let Some(seq) = aliases.as_sequence() {
                    for a in seq {
                        if let Some(s) = a.as_str() {
                            let alias = s.to_string();
                            if !result.aliases.contains(&alias) {
                                result.aliases.push(alias);
                            }
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// Block-level parsing
// ============================================================================

static BLOCK_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\^([\w-]+)\s*$").unwrap());

static BLOCK_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|#]+)?#\^([\w-]+)(?:\|[^\]]+)?\]\]").unwrap());

#[derive(Debug, Clone)]
pub struct BlockInfo {
    pub block_id: String,
    pub line_number: usize,
    pub content: String,
    pub block_type: String,
}

#[derive(Debug, Clone)]
pub struct BlockRefInfo {
    pub target_note: Option<String>,
    pub block_id: String,
    pub line_number: usize,
}

/// Parse blocks and block references from markdown content.
/// Returns (blocks, block_refs).
pub fn parse_blocks(content: &str) -> (Vec<BlockInfo>, Vec<BlockRefInfo>) {
    let mut blocks = Vec::new();
    let mut block_refs = Vec::new();

    let lines: Vec<&str> = content.lines().collect();
    let mut in_code_block = false;
    let mut code_block_start = 0;
    let mut code_block_content = String::new();

    for (i, line) in lines.iter().enumerate() {
        // Code block boundary detection
        if line.trim_start().starts_with("```") {
            if in_code_block {
                // Code block end, check for block ID
                if let Some(cap) = BLOCK_ID_RE.captures(line) {
                    let block_id = cap.get(1).unwrap().as_str().to_string();
                    blocks.push(BlockInfo {
                        block_id,
                        line_number: code_block_start,
                        content: code_block_content.clone(),
                        block_type: "code_block".to_string(),
                    });
                }
                in_code_block = false;
                code_block_content.clear();
            } else {
                in_code_block = true;
                code_block_start = i;
            }
            continue;
        }

        if in_code_block {
            code_block_content.push_str(line);
            code_block_content.push('\n');
            continue;
        }

        // Extract block references [[note#^block-id]]
        for cap in BLOCK_REF_RE.captures_iter(line) {
            let target_note = cap.get(1).map(|m| m.as_str().trim().to_string());
            let block_id = cap.get(2).unwrap().as_str().to_string();
            block_refs.push(BlockRefInfo {
                target_note,
                block_id,
                line_number: i,
            });
        }

        // Extract block ID at line end
        if let Some(cap) = BLOCK_ID_RE.captures(line) {
            let block_id = cap.get(1).unwrap().as_str().to_string();
            let content = line[..cap.get(0).unwrap().start()].trim().to_string();

            let block_type = if line.trim_start().starts_with("- ")
                || line.trim_start().starts_with("* ")
                || line.trim_start().starts_with("+ ")
                || line.trim_start().chars().next().map_or(false, |c| c.is_ascii_digit())
                    && line.trim_start().contains(". ")
            {
                "list_item"
            } else if line.trim_start().starts_with('#') {
                "heading"
            } else if line.contains('|') && line.matches('|').count() >= 2 {
                "table"
            } else {
                "paragraph"
            };

            blocks.push(BlockInfo {
                block_id,
                line_number: i,
                content,
                block_type: block_type.to_string(),
            });
        }
    }

    (blocks, block_refs)
}
