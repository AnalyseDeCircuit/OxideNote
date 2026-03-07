// Full-text search operations are implemented in db.rs (search_fts, search_by_filename).
// This module re-exports them for clarity.

#[allow(unused_imports)]
pub use super::db::{search_by_filename, search_fts};
