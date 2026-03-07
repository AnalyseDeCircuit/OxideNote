use regex::Regex;
use std::sync::LazyLock;

/// Parsed metadata from a markdown note.
#[derive(Debug, Clone, Default)]
pub struct ParsedNote {
    pub title: String,
    pub tags: Vec<String>,
    pub links: Vec<String>,       // WikiLink targets (resolved name)
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
    let body = if content.starts_with("---") {
        // Find closing --- that sits on its own line
        let after_open = &content[3..];
        let mut found_end = None;
        for (i, line) in after_open.lines().enumerate() {
            if i == 0 && line.is_empty() {
                // first line after opening --- might be empty, skip
                continue;
            }
            if i == 0 {
                // first non-empty line after ---, just continue
                continue;
            }
            if line.trim() == "---" {
                // byte offset: sum of chars up to this line
                let byte_offset = after_open[..].lines()
                    .take(i)
                    .map(|l| l.len() + 1) // +1 for \n
                    .sum::<usize>();
                found_end = Some(byte_offset);
                break;
            }
        }
        if let Some(end_offset) = found_end {
            let yaml_str = after_open[..end_offset].trim();
            parse_frontmatter(yaml_str, &mut result);
            let body_start = end_offset + "---".len();
            let remaining = &after_open[body_start..];
            // Skip leading newline after closing ---
            remaining.strip_prefix('\n').unwrap_or(remaining)
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
        result.title = file_name
            .trim_end_matches(".md")
            .to_string();
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

            // Aliases (treat as additional link targets)
            if let Some(aliases) = mapping.get(&serde_yaml::Value::String("aliases".into())) {
                if let Some(seq) = aliases.as_sequence() {
                    for a in seq {
                        if let Some(s) = a.as_str() {
                            // Aliases don't go into links — they're used for wikilink resolution
                            let _ = s;
                        }
                    }
                }
            }
        }
    }
}
