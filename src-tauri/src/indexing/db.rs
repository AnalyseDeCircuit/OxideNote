use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::path::Path;

/// Open or create the index database for a vault.
/// The DB is stored in `<vault>/.oxidenote/index.db`.
pub fn open_db(vault_path: &Path) -> Result<Connection, rusqlite::Error> {
    let db_dir = vault_path.join(".oxidenote");
    std::fs::create_dir_all(&db_dir).ok();
    let db_path = db_dir.join("index.db");
    let conn = Connection::open(db_path)?;

    // Enable WAL mode for better concurrent performance
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    create_schema(&conn)?;
    Ok(conn)
}

fn create_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            title TEXT,
            created_at TEXT,
            modified_at TEXT,
            frontmatter TEXT
        );

        CREATE TABLE IF NOT EXISTS tags (
            note_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
        CREATE INDEX IF NOT EXISTS idx_tags_note ON tags(note_id);

        CREATE TABLE IF NOT EXISTS links (
            source_id INTEGER NOT NULL,
            target_path TEXT NOT NULL,
            FOREIGN KEY (source_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);

        CREATE TABLE IF NOT EXISTS aliases (
            note_id INTEGER NOT NULL,
            alias TEXT NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
        CREATE INDEX IF NOT EXISTS idx_aliases_note ON aliases(note_id);

        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_order ON bookmarks(sort_order);

        CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY,
            note_id INTEGER NOT NULL,
            block_id TEXT NOT NULL,
            line_number INTEGER NOT NULL,
            content TEXT NOT NULL,
            block_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
            UNIQUE(note_id, block_id)
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_note ON blocks(note_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_id ON blocks(block_id);

        CREATE TABLE IF NOT EXISTS block_links (
            id INTEGER PRIMARY KEY,
            source_id INTEGER NOT NULL,
            target_note_path TEXT NOT NULL,
            target_block_id TEXT,
            source_line INTEGER NOT NULL,
            FOREIGN KEY (source_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_block_links_source ON block_links(source_id);
        CREATE INDEX IF NOT EXISTS idx_block_links_target ON block_links(target_note_path, target_block_id);
        ",
    )?;

    // Create FTS5 table if it doesn't exist
    conn.execute_batch(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            path,
            title,
            content
        );
        ",
    )?;

    Ok(())
}

/// Insert or update a note — raw version without transaction management.
/// Caller must wrap in a transaction if atomicity is needed.
pub fn upsert_note_raw(
    conn: &Connection,
    path: &str,
    title: &str,
    content: &str,
    created_at: Option<&str>,
    modified_at: Option<&str>,
    frontmatter_json: Option<&str>,
    tags: &[String],
    links: &[String],
    aliases: &[String],
) -> Result<(), rusqlite::Error> {
    // Upsert note
    conn.execute(
        "INSERT INTO notes (path, title, created_at, modified_at, frontmatter)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            created_at = excluded.created_at,
            modified_at = excluded.modified_at,
            frontmatter = excluded.frontmatter",
        params![path, title, created_at, modified_at, frontmatter_json],
    )?;

    let note_id: i64 = conn.query_row(
        "SELECT id FROM notes WHERE path = ?1",
        params![path],
        |row| row.get(0),
    )?;

    // Replace tags
    conn.execute("DELETE FROM tags WHERE note_id = ?1", params![note_id])?;
    for tag in tags {
        conn.execute(
            "INSERT INTO tags (note_id, tag) VALUES (?1, ?2)",
            params![note_id, tag],
        )?;
    }

    // Replace links
    conn.execute("DELETE FROM links WHERE source_id = ?1", params![note_id])?;
    for link in links {
        conn.execute(
            "INSERT INTO links (source_id, target_path) VALUES (?1, ?2)",
            params![note_id, link],
        )?;
    }

    // Replace aliases
    conn.execute("DELETE FROM aliases WHERE note_id = ?1", params![note_id])?;
    for alias in aliases {
        conn.execute(
            "INSERT INTO aliases (note_id, alias) VALUES (?1, ?2)",
            params![note_id, alias],
        )?;
    }

    // Update FTS
    conn.execute(
        "DELETE FROM notes_fts WHERE path = ?1",
        params![path],
    )?;
    conn.execute(
        "INSERT INTO notes_fts (path, title, content) VALUES (?1, ?2, ?3)",
        params![path, title, content],
    )?;

    Ok(())
}

/// Insert or update a note in the index (wrapped in its own transaction).
/// Standalone entry point for single-file operations (e.g. watcher triggered indexing).
#[allow(dead_code)] // 保留为公开 API，scanner::index_single_file 当前使用 raw 版本
pub fn upsert_note(
    conn: &Connection,
    path: &str,
    title: &str,
    content: &str,
    created_at: Option<&str>,
    modified_at: Option<&str>,
    frontmatter_json: Option<&str>,
    tags: &[String],
    links: &[String],
    aliases: &[String],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    upsert_note_raw(&tx, path, title, content, created_at, modified_at, frontmatter_json, tags, links, aliases)?;
    tx.commit()?;
    Ok(())
}

/// Remove a note — raw version without transaction management.
pub fn delete_note_raw(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM notes_fts WHERE path = ?1", params![path])?;
    conn.execute("DELETE FROM notes WHERE path = ?1", params![path])?;
    Ok(())
}

/// Remove a note from the index (wrapped in its own transaction).
pub fn delete_note(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    delete_note_raw(&tx, path)?;
    tx.commit()?;
    Ok(())
}

/// Query backlinks: notes that link TO the given path.
pub fn get_backlinks(conn: &Connection, target_path: &str) -> Result<Vec<BacklinkResult>, rusqlite::Error> {
    // Also fetch content from FTS table to extract a context snippet
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title, f.content FROM links l
         JOIN notes n ON n.id = l.source_id
         LEFT JOIN notes_fts f ON f.path = n.path
         WHERE l.target_path = ?1
         ORDER BY n.title"
    )?;

    let results = stmt.query_map(params![target_path], |row| {
        let path: String = row.get(0)?;
        let title: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        let content: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
        let snippet = extract_backlink_snippet(&content, target_path);
        Ok(BacklinkResult { path, title, snippet })
    })?.collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Extract a short snippet around the wikilink reference to `target` in `content`.
fn extract_backlink_snippet(content: &str, target: &str) -> String {
    // Build search patterns: [[target]] and [[target|...
    let stem = std::path::Path::new(target)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| target.to_string());

    for line in content.lines() {
        let lower = line.to_lowercase();
        let target_lower = target.to_lowercase();
        let stem_lower = stem.to_lowercase();
        if lower.contains(&format!("[[{}", target_lower)) || lower.contains(&format!("[[{}", stem_lower)) {
            let trimmed = line.trim();
            // 按字符边界安全截断，避免在多字节 UTF-8 字符中间切断导致 panic
            if trimmed.chars().count() > 200 {
                let end: String = trimmed.chars().take(200).collect();
                return format!("{}...", end);
            }
            return trimmed.to_string();
        }
    }
    String::new()
}

/// Full-text search.
pub fn search_fts(conn: &Connection, query: &str) -> Result<Vec<SearchResult>, rusqlite::Error> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    // Sanitize: wrap each word in quotes, strip FTS5 operators
    let fts_query = trimmed
        .split_whitespace()
        .map(|w| {
            let cleaned: String = w.chars()
                .filter(|c| *c != '"' && *c != '*' && *c != '^')
                .collect();
            format!("\"{}\"", cleaned)
        })
        .filter(|w| w != "\"\"")
        .collect::<Vec<_>>()
        .join(" ");

    if fts_query.is_empty() {
        return Ok(vec![]);
    }

    let mut stmt = conn.prepare(
        "SELECT path, title, snippet(notes_fts, 2, '<mark>', '</mark>', '...', 32)
         FROM notes_fts
         WHERE notes_fts MATCH ?1
         ORDER BY rank
         LIMIT 50"
    )?;

    let results = stmt.query_map(params![fts_query], |row| {
        Ok(SearchResult {
            path: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            snippet: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        })
    })?.collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Search by filename/path, also matching aliases.
pub fn search_by_filename(conn: &Connection, query: &str) -> Result<Vec<SearchResult>, rusqlite::Error> {
    // Escape LIKE special characters
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);

    // UNION: match path/title OR alias, deduplicate by path
    let mut stmt = conn.prepare(
        "SELECT path, title FROM (
            SELECT path, title FROM notes
            WHERE path LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'
            UNION
            SELECT n.path, n.title FROM aliases a
            JOIN notes n ON n.id = a.note_id
            WHERE a.alias LIKE ?1 ESCAPE '\\'
         )
         ORDER BY title
         LIMIT 50"
    )?;

    let results = stmt.query_map(params![pattern], |row| {
        Ok(SearchResult {
            path: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            snippet: String::new(),
        })
    })?.collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BacklinkResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

/// List all tags with their note counts.
pub fn list_all_tags(conn: &Connection) -> Result<Vec<TagCount>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(*) as cnt FROM tags GROUP BY tag ORDER BY cnt DESC, tag ASC"
    )?;
    let results = stmt.query_map([], |row| {
        Ok(TagCount {
            tag: row.get(0)?,
            count: row.get(1)?,
        })
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(results)
}

/// Search notes by tag.
/// When `hierarchical` is true, also matches descendant tags (e.g. `dev` matches `dev/rust`).
pub fn search_by_tag(conn: &Connection, tag: &str, hierarchical: bool) -> Result<Vec<SearchResult>, rusqlite::Error> {
    if hierarchical {
        let like_pattern = format!("{}/%", tag.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn.prepare(
            "SELECT DISTINCT n.path, n.title FROM tags t
             JOIN notes n ON n.id = t.note_id
             WHERE t.tag = ?1 OR t.tag LIKE ?2 ESCAPE '\\'
             ORDER BY n.title"
        )?;
        let results = stmt.query_map(params![tag, like_pattern], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                snippet: String::new(),
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(results)
    } else {
        let mut stmt = conn.prepare(
            "SELECT n.path, n.title FROM tags t
             JOIN notes n ON n.id = t.note_id
             WHERE t.tag = ?1
             ORDER BY n.title"
        )?;
        let results = stmt.query_map(params![tag], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                snippet: String::new(),
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(results)
    }
}

/// Query all aliases as (lowercase alias → note path) mapping.
/// Used by health check and graph/backlink resolution.
pub fn query_all_aliases(conn: &Connection) -> Result<HashMap<String, String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT a.alias, n.path FROM aliases a JOIN notes n ON n.id = a.note_id"
    )?;
    let map = stmt
        .query_map([], |row| {
            let alias: String = row.get(0)?;
            let path: String = row.get(1)?;
            Ok((alias.to_lowercase(), path))
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(map)
}

/// Pick a random note from the vault.
pub fn get_random_note(conn: &Connection) -> Result<Option<SearchResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT path, title FROM notes ORDER BY RANDOM() LIMIT 1"
    )?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SearchResult {
            path: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            snippet: String::new(),
        }))
    } else {
        Ok(None)
    }
}

// ============================================================================
// Block-level reference functions
// ============================================================================

#[derive(Debug, Clone)]
pub struct BlockResult {
    pub block_id: String,
    pub line_number: i64,
    pub content: String,
    pub block_type: String,
}

/// Insert or update blocks for a note.
/// Deletes existing blocks and inserts new ones.
pub fn upsert_blocks_raw(
    conn: &Connection,
    note_id: i64,
    blocks: &[(String, usize, String, String)], // (block_id, line_number, content, block_type)
) -> Result<(), rusqlite::Error> {
    // Delete old blocks
    conn.execute("DELETE FROM blocks WHERE note_id = ?1", params![note_id])?;

    // Insert new blocks
    for (block_id, line_number, content, block_type) in blocks {
        conn.execute(
            "INSERT INTO blocks (note_id, block_id, line_number, content, block_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![note_id, block_id, *line_number as i64, content, block_type],
        )?;
    }

    Ok(())
}

/// Insert or update block links for a note.
pub fn upsert_block_links_raw(
    conn: &Connection,
    source_id: i64,
    block_refs: &[(Option<String>, String, usize)], // (target_note, block_id, line_number)
) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM block_links WHERE source_id = ?1", params![source_id])?;

    for (target_note, block_id, line_number) in block_refs {
        conn.execute(
            "INSERT INTO block_links (source_id, target_note_path, target_block_id, source_line)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                source_id,
                target_note.as_deref().unwrap_or(""),
                block_id,
                *line_number as i64
            ],
        )?;
    }

    Ok(())
}

/// Get all blocks for a note.
pub fn get_note_blocks(
    conn: &Connection,
    note_path: &str,
) -> Result<Vec<BlockResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT b.block_id, b.line_number, b.content, b.block_type
         FROM blocks b
         JOIN notes n ON n.id = b.note_id
         WHERE n.path = ?1
         ORDER BY b.line_number",
    )?;

    let rows = stmt.query_map(params![note_path], |row| {
        Ok(BlockResult {
            block_id: row.get(0)?,
            line_number: row.get(1)?,
            content: row.get(2)?,
            block_type: row.get(3)?,
        })
    })?;

    rows.collect()
}

/// Get content of a specific block.
pub fn get_block_content(
    conn: &Connection,
    note_path: &str,
    block_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT b.content FROM blocks b
         JOIN notes n ON n.id = b.note_id
         WHERE n.path = ?1 AND b.block_id = ?2",
        params![note_path, block_id],
        |row| row.get(0),
    )
    .optional()
}

/// Get backlinks to a specific block.
pub fn get_block_backlinks(
    conn: &Connection,
    note_path: &str,
    block_id: &str,
) -> Result<Vec<SearchResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title, bl.source_line
         FROM block_links bl
         JOIN notes n ON n.id = bl.source_id
         WHERE bl.target_note_path = ?1 AND bl.target_block_id = ?2
         ORDER BY n.title",
    )?;

    let rows = stmt.query_map(params![note_path, block_id], |row| {
        Ok(SearchResult {
            path: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            snippet: format!("Line {}", row.get::<_, i64>(2)?),
        })
    })?;

    rows.collect()
}

// ============================================================================
// Advanced search — combines FTS, tag, and path filters
// ============================================================================

/// Advanced search with optional FTS query, tag filter, and path filter.
/// Builds a dynamic SQL query based on which filters are provided.
pub fn advanced_search(
    conn: &Connection,
    query: Option<&str>,
    tag_filter: Option<&str>,
    path_filter: Option<&str>,
) -> Result<Vec<SearchResult>, rusqlite::Error> {
    // If only a plain FTS query with no filters, delegate to the standard search
    if tag_filter.is_none() && path_filter.is_none() {
        if let Some(q) = query {
            if !q.trim().is_empty() {
                return search_fts(conn, q);
            }
        }
        return Ok(vec![]);
    }

    let has_fts = query.map_or(false, |q| !q.trim().is_empty());
    let has_tag = tag_filter.map_or(false, |t| !t.trim().is_empty());
    let has_path = path_filter.map_or(false, |p| !p.trim().is_empty());

    // Build query dynamically
    // Base: select from notes, optionally join FTS and tags
    let mut sql = String::from("SELECT DISTINCT n.path, n.title, ");

    if has_fts {
        sql.push_str("snippet(notes_fts, 2, '<mark>', '</mark>', '...', 32) ");
    } else {
        sql.push_str("'' ");
    }

    sql.push_str("FROM notes n ");

    if has_fts {
        sql.push_str("JOIN notes_fts f ON f.path = n.path ");
    }
    if has_tag {
        sql.push_str("JOIN tags t ON t.note_id = n.id ");
    }

    sql.push_str("WHERE 1=1 ");

    let mut param_values: Vec<String> = Vec::new();
    let mut param_idx = 1;

    if has_fts {
        // Sanitize FTS query
        let fts_q = query.unwrap().trim();
        let fts_query: String = fts_q
            .split_whitespace()
            .map(|w| {
                let cleaned: String = w.chars()
                    .filter(|c| *c != '"' && *c != '*' && *c != '^')
                    .collect();
                format!("\"{}\"", cleaned)
            })
            .filter(|w| w != "\"\"")
            .collect::<Vec<_>>()
            .join(" ");

        if fts_query.is_empty() {
            return Ok(vec![]);
        }

        sql.push_str(&format!("AND notes_fts MATCH ?{} ", param_idx));
        param_values.push(fts_query);
        param_idx += 1;
    }

    if has_tag {
        let tag = tag_filter.unwrap().trim();
        // Hierarchical match: exact or descendant
        let escaped_tag = tag.replace('%', "\\%").replace('_', "\\_");
        let like_pattern = format!("{}/%", escaped_tag);
        sql.push_str(&format!("AND (t.tag = ?{} OR t.tag LIKE ?{} ESCAPE '\\') ", param_idx, param_idx + 1));
        param_values.push(tag.to_string());
        param_values.push(like_pattern);
        param_idx += 2;
    }

    if has_path {
        let path = path_filter.unwrap().trim();
        let escaped = path.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let pattern = format!("{}%", escaped);
        sql.push_str(&format!("AND n.path LIKE ?{} ESCAPE '\\' ", param_idx));
        param_values.push(pattern);
        param_idx += 1;
    }

    // Suppress unused variable warning
    let _ = param_idx;

    if has_fts {
        sql.push_str("ORDER BY rank LIMIT 50");
    } else {
        sql.push_str("ORDER BY n.title LIMIT 50");
    }

    let mut stmt = conn.prepare(&sql)?;

    // Bind parameters dynamically
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let results = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(SearchResult {
            path: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            snippet: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        })
    })?.collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}
