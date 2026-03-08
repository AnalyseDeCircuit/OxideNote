import { invoke } from '@tauri-apps/api/core';

// ─── Types ───────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: TreeNode[];
}

export interface NoteContent {
  path: string;
  content: string;
  modified_at_ms: number | null;
}

// ─── Vault commands ──────────────────────────────────────────

export async function openVault(path: string): Promise<string> {
  return invoke<string>('open_vault', { path });
}

export async function listTree(path: string = '', sortBy?: string): Promise<TreeNode[]> {
  return invoke<TreeNode[]>('list_tree', { path, sortBy });
}

// ─── Note commands ───────────────────────────────────────────

export async function readNote(path: string): Promise<NoteContent> {
  return invoke<NoteContent>('read_note', { path });
}

export async function writeNote(path: string, content: string, expectedModifiedAtMs?: number | null): Promise<number | null> {
  return invoke<number | null>('write_note', { path, content, expectedModifiedAtMs: expectedModifiedAtMs ?? null });
}

export async function createNote(parentPath: string, name: string, template?: string): Promise<string> {
  return invoke<string>('create_note', { parentPath, name, template: template ?? null });
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  return invoke<string>('create_folder', { parentPath, name });
}

export async function renameEntry(oldPath: string, newName: string): Promise<string> {
  return invoke<string>('rename_entry', { oldPath, newName });
}

export async function deleteEntry(path: string): Promise<void> {
  return invoke<void>('delete_entry', { path });
}

// ─── Search / Index commands ─────────────────────────────────

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
}

export interface BacklinkResult {
  path: string;
  title: string;
  snippet: string;
}

export async function searchNotes(query: string): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_notes', { query });
}

export async function searchByFilename(query: string): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_by_filename', { query });
}

export async function getBacklinks(path: string): Promise<BacklinkResult[]> {
  return invoke<BacklinkResult[]>('get_backlinks', { path });
}

export async function reindexNote(path: string): Promise<void> {
  return invoke<void>('reindex_note', { path });
}

// ─── Attachment commands ─────────────────────────────────────

/** 保存附件到 vault 的 .attachments 目录，返回相对路径 */
export async function saveAttachment(data: string, filename: string): Promise<string> {
  return invoke<string>('save_attachment', { data, filename });
}

// ─── Graph commands ──────────────────────────────────────────

export interface GraphNode {
  id: string;
  title: string;
  created_at: string | null;
  modified_at: string | null;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** 获取知识图谱数据（节点 + 连边） */
export async function getGraphData(): Promise<GraphData> {
  return invoke<GraphData>('get_graph_data');
}

// ─── Tag commands ────────────────────────────────────────────

export interface TagCount {
  tag: string;
  count: number;
}

/** 获取所有标签及其笔记计数 */
export async function listAllTags(): Promise<TagCount[]> {
  return invoke<TagCount[]>('list_all_tags');
}

/** 按标签搜索笔记 */
export async function searchByTag(tag: string): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_by_tag', { tag });
}

// ─── File management commands ────────────────────────────────

/** 移动文件/文件夹到新的父目录 */
export async function moveEntry(sourcePath: string, targetDir: string): Promise<string> {
  return invoke<string>('move_entry', { sourcePath, targetDir });
}

/** Reveal a file or folder in the system file manager */
export async function revealInFinder(path: string): Promise<void> {
  return invoke<void>('reveal_in_explorer', { path });
}

/** Read a binary file as base64-encoded string (for PDF etc.) */
export async function readBinaryFile(path: string): Promise<string> {
  return invoke<string>('read_binary_file', { path });
}

// ─── Health commands ─────────────────────────────────────────

export interface BrokenLink {
  source: string;
  target: string;
}

export interface HealthReport {
  unindexed_files: string[];
  orphaned_entries: string[];
  broken_links: BrokenLink[];
  total_files: number;
  total_indexed: number;
  fts_consistent: boolean;
}

/** Run a read-only vault health check */
export async function vaultHealthCheck(): Promise<HealthReport> {
  return invoke<HealthReport>('vault_health_check');
}

/** Repair the vault index (remove orphans, index missing, rebuild FTS) */
export async function repairVault(): Promise<HealthReport> {
  return invoke<HealthReport>('repair_vault');
}

/** Open a URL in a new in-app browser window */
export async function openBrowserWindow(url: string): Promise<void> {
  return invoke<void>('open_browser_window', { url });
}

// ─── Task commands ───────────────────────────────────────────

export interface TaskItem {
  path: string;
  line: number;
  text: string;
  done: boolean;
}

/** List all task items (- [ ] / - [x]) across the vault */
export async function listTasks(): Promise<TaskItem[]> {
  return invoke<TaskItem[]>('list_tasks');
}

/** Pick a random note from the vault index */
export async function getRandomNote(): Promise<SearchResult | null> {
  return invoke<SearchResult | null>('get_random_note');
}

/** Export a note and its attachments as a zip bundle */
export async function exportNoteBundle(path: string, savePath: string): Promise<void> {
  return invoke<void>('export_note_bundle', { path, savePath });
}

/** Publish pre-rendered pages as a static HTML site */
export interface SitePage {
  path: string;
  html: string;
}

export async function publishStaticSite(outputDir: string, pages: SitePage[], indexHtml: string): Promise<number> {
  return invoke<number>('publish_static_site', { outputDir, pages, indexHtml });
}

/** Bulk import external .md files into the vault */
export interface ImportResult {
  imported: number;
  skipped: string[];
}

export async function bulkImportNotes(sourcePaths: string[], targetFolder: string): Promise<ImportResult> {
  return invoke<ImportResult>('bulk_import_notes', { sourcePaths, targetFolder });
}

/** Check if a note is encrypted */
export async function isNoteEncrypted(path: string): Promise<boolean> {
  return invoke<boolean>('is_note_encrypted', { path });
}

/** Encrypt a note file in-place with a password */
export async function encryptNote(path: string, password: string): Promise<void> {
  return invoke<void>('encrypt_note', { path, password });
}

/** Decrypt a note and return plaintext (does NOT write to disk) */
export async function decryptNote(path: string, password: string): Promise<string> {
  return invoke<string>('decrypt_note', { path, password });
}

/** Decrypt a note and write plaintext back to disk (permanent unlock) */
export async function decryptNoteToDisk(path: string, password: string): Promise<void> {
  return invoke<void>('decrypt_note_to_disk', { path, password });
}

// ─── History commands ────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  timestamp: number;
  size: number;
}

export interface DiffChunk {
  tag: string;   // "equal" | "insert" | "delete"
  value: string;
}

/** List all history snapshots for a note, newest first */
export async function listNoteHistory(path: string): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>('list_note_history', { path });
}

/** Read the content of a specific history snapshot */
export async function readHistorySnapshot(path: string, snapshotId: string): Promise<string> {
  return invoke<string>('read_history_snapshot', { path, snapshotId });
}

/** Restore a snapshot to overwrite the current note */
export async function restoreSnapshot(path: string, snapshotId: string): Promise<void> {
  return invoke<void>('restore_snapshot', { path, snapshotId });
}

/** Compute line-level diff between a snapshot and the current content */
export async function diffWithCurrent(path: string, snapshotId: string): Promise<DiffChunk[]> {
  return invoke<DiffChunk[]>('diff_with_current', { path, snapshotId });
}

// ─── Trash commands ──────────────────────────────────────────

export interface TrashEntry {
  id: string;
  original_path: string;
  trash_path: string;
  deleted_at: number;
  size: number;
  is_dir: boolean;
}

/** Move a file or directory to application trash */
export async function softDelete(path: string): Promise<void> {
  return invoke<void>('soft_delete', { path });
}

/** List all items currently in trash */
export async function listTrash(): Promise<TrashEntry[]> {
  return invoke<TrashEntry[]>('list_trash');
}

/** Restore a trashed item back to its original location */
export async function restoreFromTrash(entryId: string): Promise<void> {
  return invoke<void>('restore_from_trash', { entryId });
}

/** Permanently delete a single item from trash */
export async function permanentDelete(entryId: string): Promise<void> {
  return invoke<void>('permanent_delete', { entryId });
}

/** Empty the entire trash */
export async function emptyTrash(): Promise<void> {
  return invoke<void>('empty_trash');
}

// ─── Bookmark commands ───────────────────────────────────────

export interface BookmarkEntry {
  path: string;
  created_at: string;
  sort_order: number;
}

/** Add a note to bookmarks */
export async function addBookmark(path: string): Promise<void> {
  return invoke<void>('add_bookmark', { path });
}

/** Remove a note from bookmarks */
export async function removeBookmark(path: string): Promise<void> {
  return invoke<void>('remove_bookmark', { path });
}

/** List all bookmarks ordered by sort_order */
export async function listBookmarks(): Promise<BookmarkEntry[]> {
  return invoke<BookmarkEntry[]>('list_bookmarks');
}

/** Reorder bookmarks by providing the full path array in desired order */
export async function reorderBookmarks(paths: string[]): Promise<void> {
  return invoke<void>('reorder_bookmarks', { paths });
}

/** Check if a note is bookmarked */
export async function isBookmarked(path: string): Promise<boolean> {
  return invoke<boolean>('is_bookmarked', { path });
}
