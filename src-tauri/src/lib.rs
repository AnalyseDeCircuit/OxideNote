//! OxideNote - A local-first markdown note app

mod commands;
mod indexing;
mod state;
mod watcher;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use state::AppState;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

fn init_logging() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tracing::info!("Starting OxideNote...");

    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault,
            commands::vault::list_tree,
            commands::note::read_note,
            commands::note::write_note,
            commands::note::create_note,
            commands::note::create_folder,
            commands::note::rename_entry,
            commands::note::delete_entry,
            commands::note::move_entry,
            commands::search::search_notes,
            commands::search::search_by_filename,
            commands::search::get_backlinks,
            commands::search::reindex_note,
            commands::search::get_graph_data,
            commands::search::list_all_tags,
            commands::search::search_by_tag,
            commands::search::list_tasks,
            commands::search::get_random_note,
            commands::note::reveal_in_explorer,
            commands::note::read_binary_file,
            commands::attachment::save_attachment,
            commands::health::vault_health_check,
            commands::health::repair_vault,
            commands::browser::open_browser_window,
            commands::export::export_note_bundle,
            commands::export::publish_static_site,
            commands::import::bulk_import_notes,
            commands::crypto::is_note_encrypted,
            commands::crypto::encrypt_note,
            commands::crypto::decrypt_note,
            commands::crypto::decrypt_note_to_disk,
            commands::history::list_note_history,
            commands::history::read_history_snapshot,
            commands::history::restore_snapshot,
            commands::history::diff_with_current,
            commands::trash::soft_delete,
            commands::trash::list_trash,
            commands::trash::restore_from_trash,
            commands::trash::permanent_delete,
            commands::trash::empty_trash,
            commands::bookmark::add_bookmark,
            commands::bookmark::remove_bookmark,
            commands::bookmark::list_bookmarks,
            commands::bookmark::reorder_bookmarks,
            commands::bookmark::is_bookmarked,
            commands::clip::clip_webpage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
