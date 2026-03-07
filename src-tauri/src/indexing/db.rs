use rusqlite::{Connection, params};
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

/// Insert or update a note in the index (within a transaction).
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
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;

    // Upsert note
    tx.execute(
        "INSERT INTO notes (path, title, created_at, modified_at, frontmatter)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            created_at = excluded.created_at,
            modified_at = excluded.modified_at,
            frontmatter = excluded.frontmatter",
        params![path, title, created_at, modified_at, frontmatter_json],
    )?;

    let note_id: i64 = tx.query_row(
        "SELECT id FROM notes WHERE path = ?1",
        params![path],
        |row| row.get(0),
    )?;

    // Replace tags
    tx.execute("DELETE FROM tags WHERE note_id = ?1", params![note_id])?;
    for tag in tags {
        tx.execute(
            "INSERT INTO tags (note_id, tag) VALUES (?1, ?2)",
            params![note_id, tag],
        )?;
    }

    // Replace links
    tx.execute("DELETE FROM links WHERE source_id = ?1", params![note_id])?;
    for link in links {
        tx.execute(
            "INSERT INTO links (source_id, target_path) VALUES (?1, ?2)",
            params![note_id, link],
        )?;
    }

    // Update FTS
    tx.execute(
        "DELETE FROM notes_fts WHERE path = ?1",
        params![path],
    )?;
    tx.execute(
        "INSERT INTO notes_fts (path, title, content) VALUES (?1, ?2, ?3)",
        params![path, title, content],
    )?;

    tx.commit()?;
    Ok(())
}

/// Remove a note from the index.
pub fn delete_note(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM notes_fts WHERE path = ?1", params![path])?;
    tx.execute("DELETE FROM notes WHERE path = ?1", params![path])?;
    tx.commit()?;
    Ok(())
}

/// Query backlinks: notes that link TO the given path.
pub fn get_backlinks(conn: &Connection, target_path: &str) -> Result<Vec<BacklinkResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title FROM links l
         JOIN notes n ON n.id = l.source_id
         WHERE l.target_path = ?1
         ORDER BY n.title"
    )?;

    let results = stmt.query_map(params![target_path], |row| {
        Ok(BacklinkResult {
            path: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        })
    })?.collect::<Result<Vec<_>, _>>()?;

    Ok(results)
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

/// Search by filename/path.
pub fn search_by_filename(conn: &Connection, query: &str) -> Result<Vec<SearchResult>, rusqlite::Error> {
    // Escape LIKE special characters
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    let mut stmt = conn.prepare(
        "SELECT path, title FROM notes
         WHERE path LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'
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
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
}
