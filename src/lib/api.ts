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
}

// ─── Vault commands ──────────────────────────────────────────

export async function openVault(path: string): Promise<string> {
  return invoke<string>('open_vault', { path });
}

export async function listTree(path: string = ''): Promise<TreeNode[]> {
  return invoke<TreeNode[]>('list_tree', { path });
}

// ─── Note commands ───────────────────────────────────────────

export async function readNote(path: string): Promise<NoteContent> {
  return invoke<NoteContent>('read_note', { path });
}

export async function writeNote(path: string, content: string): Promise<void> {
  return invoke<void>('write_note', { path, content });
}

export async function createNote(parentPath: string, name: string): Promise<string> {
  return invoke<string>('create_note', { parentPath, name });
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
