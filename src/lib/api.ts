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

export interface BlockResult {
  block_id: string;
  line_number: number;
  content: string;
  block_type: string;
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

export async function getNoteBlocks(path: string): Promise<BlockResult[]> {
  return invoke<BlockResult[]>('get_note_blocks', { path });
}

export async function getBlockContent(notePath: string, blockId: string): Promise<string | null> {
  return invoke<string | null>('get_block_content', { notePath, blockId });
}

export async function getBlockBacklinks(notePath: string, blockId: string): Promise<BacklinkResult[]> {
  return invoke<BacklinkResult[]>('get_block_backlinks', { notePath, blockId });
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
  /** When true, this node represents a block rather than a note */
  is_block?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Fetch knowledge graph data (nodes + edges).
 * When includeBlocks is true, also returns block nodes and block reference edges. */
export async function getGraphData(includeBlocks?: boolean): Promise<GraphData> {
  return invoke<GraphData>('get_graph_data', { includeBlocks: includeBlocks ?? false });
}

/** Fetch a local graph centered on a specific note, limited to `depth` hops. */
export async function getLocalGraph(centerPath: string, depth?: number): Promise<GraphData> {
  return invoke<GraphData>('get_local_graph', { centerPath, depth: depth ?? 2 });
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

/** 按标签搜索笔记，可选层级匹配 */
export async function searchByTag(tag: string, hierarchical?: boolean): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_by_tag', { tag, hierarchical: hierarchical ?? false });
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
  due_date: string | null;
  priority: string | null;
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

/** Write HTML to a temp file with images inlined and open in system browser for printing */
export async function printHtml(htmlContent: string, notePath: string): Promise<void> {
  return invoke<void>('print_html', { htmlContent, notePath });
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

// ─── Web Clipper ────────────────────────────────────────────

/** Clip a web page: fetch HTML, convert to Markdown, save as a note */
export async function clipWebpage(url: string, folder: string = ''): Promise<string> {
  return invoke<string>('clip_webpage', { url, folder });
}

// ─── Advanced Search ────────────────────────────────────────

/** Advanced search combining FTS, tag, and path filters */
export async function advancedSearch(
  query?: string,
  tagFilter?: string,
  pathFilter?: string,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('advanced_search', {
    query: query ?? null,
    tagFilter: tagFilter ?? null,
    pathFilter: pathFilter ?? null,
  });
}

// ─── PDF Annotation Persistence ─────────────────────────────

/** Save PDF annotations via backend (bypasses note pipeline) */
export async function savePdfAnnotations(pdfPath: string, annotationsJson: string): Promise<void> {
  return invoke<void>('save_pdf_annotations', { pdfPath, annotationsJson });
}

/** Load PDF annotations from backend storage */
export async function loadPdfAnnotations(pdfPath: string): Promise<string> {
  return invoke<string>('load_pdf_annotations', { pdfPath });
}

// ─── Canvas commands ────────────────────────────────────────

/** Canvas file data model */
export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasStroke {
  points: CanvasPoint[];
  color: string;
  width: number;
}

export interface CanvasCard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  linked_note?: string;
  linked_block?: { note_path: string; block_id: string };
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasData {
  version: number;
  strokes: CanvasStroke[];
  cards: CanvasCard[];
  viewport: CanvasViewport;
}

/** Read a canvas file from the vault. Returns empty canvas if file is new. */
export async function readCanvas(path: string): Promise<CanvasData> {
  return invoke<CanvasData>('read_canvas', { path });
}

/** Write canvas data to disk as JSON */
export async function writeCanvas(path: string, data: CanvasData): Promise<void> {
  return invoke<void>('write_canvas', { path, data });
}

/** Create a new empty .canvas file, returns the vault-relative path */
export async function createCanvas(parentPath: string, name: string): Promise<string> {
  return invoke<string>('create_canvas', { parentPath, name });
}

// ─── Semantic search / Embedding commands ───────────────────

export interface SemanticSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export interface EmbeddingConfig {
  provider: 'api' | 'local';
  api_url: string;
  api_key: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingStatus {
  total_notes: number;
  embedded_notes: number;
  total_chunks: number;
  model_name: string | null;
  configured: boolean;
}

export interface RebuildResult {
  embedded: number;
  skipped: number;
  chunks: number;
  errors: string[];
}

/** Progress event payload emitted per-batch during embedding rebuild */
export interface EmbeddingProgressEvent {
  current: number;
  total: number;
  path: string;
  chunks_done: number;
  error_count: number;
}

/** Semantic search by natural language query */
export async function semanticSearch(query: string): Promise<SemanticSearchResult[]> {
  return invoke<SemanticSearchResult[]>('semantic_search', { query });
}

/** Rebuild the embedding index. force=true for full rebuild, false for incremental (resume). */
export async function rebuildEmbeddings(force?: boolean): Promise<RebuildResult> {
  return invoke<RebuildResult>('rebuild_embeddings', { force: force ?? false });
}

/** Get embedding index status */
export async function getEmbeddingStatus(): Promise<EmbeddingStatus> {
  return invoke<EmbeddingStatus>('get_embedding_status');
}

/** Save embedding provider configuration */
export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  return invoke<void>('save_embedding_config', { config });
}

/** Load embedding provider configuration */
export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  return invoke<EmbeddingConfig | null>('load_embedding_config');
}

/** Clear all embedding data from the index. Returns number of deleted chunks. */
export async function clearEmbeddings(): Promise<number> {
  return invoke<number>('clear_embeddings');
}

// ─── Chat types ─────────────────────────────────────────────

export type ChatProvider =
  | 'openai'
  | 'claude'
  | 'ollama'
  | 'deepseek'
  | 'gemini'
  | 'moonshot'
  | 'groq'
  | 'openrouter'
  | 'custom';

export type ThinkingMode = 'auto' | 'thinking' | 'instant';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning?: string;
  images?: ImageAttachment[];
  /** Database row ID — populated after loading from or saving to DB */
  dbId?: number;
}

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

export interface ChatConfig {
  provider: ChatProvider;
  api_url: string;
  api_key: string;
  model: string;
  temperature: number | null;
  max_tokens: number;
  system_prompt: string;
  context_window?: number | null;
  thinking_mode: ThinkingMode;
}

export interface ModelInfo {
  id: string;
  name: string;
  context_window: number | null;
  supports_vision: boolean;
  supports_thinking: boolean;
}

export interface ChatContext {
  current_note: { path: string; title: string; content: string };
  backlink_summaries: { path: string; title: string; summary: string }[];
  semantic_snippets: { source: string; text: string; score: number }[];
  referenced_notes: { path: string; title: string; content: string }[];
  is_compact: boolean;
  context_window: number;
  rag_budget_tokens: number;
}

export interface StreamChunk {
  request_id: string;
  content: string;
  reasoning: string;
  done: boolean;
  error: string | null;
  usage: TokenUsage | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ─── Chat commands ──────────────────────────────────────────

/** List available models from provider API */
export async function listModels(config: ChatConfig): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('list_models', { config });
}

/** Build RAG context for chat (current note + backlinks + semantic search) */
export async function buildChatContext(
  notePath: string,
  query: string,
  provider: ChatProvider,
  apiUrl: string,
  model: string,
  contextWindowOverride: number | null,
  maxTokens: number,
  referencedPaths: string[],
  historyTokenEstimate: number,
): Promise<ChatContext> {
  return invoke<ChatContext>('build_chat_context', {
    notePath, query, provider, apiUrl, model,
    contextWindowOverride, maxTokens,
    referencedPaths, historyTokenEstimate,
  });
}

/** Start a chat stream. Results arrive via "chat-stream-chunk" Tauri events. */
export async function chatStream(
  requestId: string,
  messages: ChatMessage[],
  config: ChatConfig,
): Promise<void> {
  return invoke<void>('chat_stream', { requestId, messages, config });
}

/** Abort an in-progress chat stream */
export async function chatAbort(requestId: string): Promise<void> {
  return invoke<void>('chat_abort', { requestId });
}

// ─── Chat persistence types ────────────────────────────────

export interface ChatSessionInfo {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
}

export interface ChatMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  images: string | null;
  usage: string | null;
  created_at: number;
}

export interface ChatSearchResult {
  message_id: number;
  session_id: string;
  session_title: string;
  content_snippet: string;
  role: string;
  created_at: number;
}

export interface TokenStatsRow {
  lifetime_prompt: number;
  lifetime_completion: number;
}

export interface MigrateResult {
  sessions_imported: number;
  messages_imported: number;
}

// ─── Chat persistence commands ──────────────────────────────

export async function listChatSessions(
  limit: number,
  offset: number,
  includeArchived = false,
): Promise<ChatSessionInfo[]> {
  return invoke<ChatSessionInfo[]>('list_chat_sessions', {
    limit, offset, includeArchived,
  });
}

export async function loadChatSession(
  sessionId: string,
): Promise<[ChatSessionInfo, ChatMessageRow[]]> {
  return invoke<[ChatSessionInfo, ChatMessageRow[]]>('load_chat_session', { sessionId });
}

export async function createChatSession(
  id: string,
  title: string,
): Promise<ChatSessionInfo> {
  return invoke<ChatSessionInfo>('create_chat_session', { id, title });
}

export async function updateChatSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  return invoke<void>('update_chat_session_title', { sessionId, title });
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  return invoke<void>('delete_chat_session', { sessionId });
}

export async function saveChatMessage(
  sessionId: string,
  role: string,
  content: string,
  reasoning?: string | null,
  images?: string | null,
  usage?: string | null,
): Promise<number> {
  return invoke<number>('save_chat_message', {
    sessionId, role, content,
    reasoning: reasoning ?? null,
    images: images ?? null,
    usage: usage ?? null,
  });
}

export async function deleteChatMessage(messageId: number): Promise<void> {
  return invoke<void>('delete_chat_message', { messageId });
}

export async function searchChatMessages(
  query: string,
  limit: number,
): Promise<ChatSearchResult[]> {
  return invoke<ChatSearchResult[]>('search_chat_messages', { query, limit });
}

export async function getTokenStats(): Promise<TokenStatsRow> {
  return invoke<TokenStatsRow>('get_token_stats', {});
}

export async function updateTokenStats(
  promptDelta: number,
  completionDelta: number,
): Promise<void> {
  return invoke<void>('update_token_stats', { promptDelta, completionDelta });
}

export async function resetLifetimeTokensDb(): Promise<void> {
  return invoke<void>('reset_lifetime_tokens', {});
}

export async function migrateChatFromJson(jsonString: string): Promise<MigrateResult> {
  return invoke<MigrateResult>('migrate_chat_from_json', { jsonString });
}

export async function saveChatImage(
  sessionId: string,
  dataBase64: string,
  mediaType: string,
): Promise<string> {
  return invoke<string>('save_chat_image', { sessionId, dataBase64, mediaType });
}

// ─── Vault stats ────────────────────────────────────────────

export interface VaultStats {
  total_notes: number;
  total_tags: number;
  total_links: number;
  orphan_notes: number;
  recent_notes: StatsRecentNote[];
  top_tags: StatsTagCount[];
  daily_activity: StatsDayActivity[];
}

export interface StatsRecentNote {
  path: string;
  title: string;
  modified_at: string;
}

export interface StatsTagCount {
  tag: string;
  count: number;
}

export interface StatsDayActivity {
  date: string;
  count: number;
}

export async function getVaultStats(): Promise<VaultStats> {
  return invoke<VaultStats>('get_vault_stats');
}

/** List all notes with basic metadata, paginated. For card flow view. */
export async function listNotesSummary(limit?: number, offset?: number): Promise<StatsRecentNote[]> {
  return invoke<StatsRecentNote[]>('list_notes_summary', {
    limit: limit ?? 50,
    offset: offset ?? 0,
  });
}

// ─── Agent commands ──────────────────────────────────────────

export type AgentKind =
  | 'duplicate_detector'
  | 'outline_extractor'
  | 'index_generator'
  | 'daily_review'
  | 'graph_maintainer'
  | { custom: string };

export type AgentStatus =
  | 'planning'
  | 'executing'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface PlanStep {
  index: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  output: string | null;
}

export interface ProposedChange {
  path: string;
  action: 'create' | 'modify' | 'merge' | 'add_link';
  content: string | null;
  diff: string | null;
  description: string;
}

export interface TaskResult {
  task_id: string;
  kind: AgentKind;
  status: AgentStatus;
  plan_steps: PlanStep[];
  proposed_changes: ProposedChange[];
  summary: string;
  started_at: string;
  completed_at: string | null;
  token_usage: { prompt_tokens: number; completion_tokens: number } | null;
}

export interface AgentStatusResponse {
  state: 'idle' | 'running' | 'paused' | 'waiting_approval';
  task_id: string | null;
  kind: string | null;
  result: TaskResult | null;
}

export interface AgentRunSummary {
  id: string;
  kind: string;
  status: string;
  scope: string | null;
  summary: string;
  token_prompt: number;
  token_completion: number;
  started_at: string;
  completed_at: string | null;
}

export interface CustomAgentDef {
  name: string;
  title: string;
  tools: string[];
  scope: string;
  auto_apply: boolean;
  max_writes: number;
}

export interface AgentTask {
  kind: AgentKind;
  scope?: string;
  params?: Record<string, unknown>;
  auto_apply?: boolean;
}

/** Start an agent task. Returns task_id or "queued". */
export async function agentRun(task: AgentTask, config: ChatConfig): Promise<string> {
  return invoke<string>('agent_run', { task, config });
}

/** Abort the currently running agent. */
export async function agentAbort(): Promise<void> {
  return invoke<void>('agent_abort');
}

/** Pause the currently running agent at the next step boundary. */
export async function agentPause(): Promise<void> {
  return invoke<void>('agent_pause');
}

/** Resume a paused agent. */
export async function agentResume(): Promise<void> {
  return invoke<void>('agent_resume');
}

/** Get current agent status. */
export async function agentStatus(): Promise<AgentStatusResponse> {
  return invoke<AgentStatusResponse>('agent_status');
}

/** Apply selected proposed changes. */
export async function agentApplyChanges(taskId: string, indices: number[]): Promise<void> {
  return invoke<void>('agent_apply_changes', { taskId, indices });
}

/** Dismiss pending changes without applying. */
export async function agentDismissChanges(): Promise<void> {
  return invoke<void>('agent_dismiss_changes');
}

/** List past agent runs. */
export async function agentListHistory(limit?: number): Promise<AgentRunSummary[]> {
  return invoke<AgentRunSummary[]>('agent_list_history', { limit: limit ?? 20 });
}

/** List available custom agent definitions. */
export async function agentListCustom(): Promise<CustomAgentDef[]> {
  return invoke<CustomAgentDef[]>('agent_list_custom');
}
