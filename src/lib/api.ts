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

export async function writeNote(path: string, content: string, expectedModifiedAtMs?: number | null): Promise<void> {
  return invoke<void>('write_note', { path, content, expectedModifiedAtMs: expectedModifiedAtMs ?? null });
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
