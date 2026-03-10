import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import {
  chatStream,
  chatAbort,
  buildChatContext,
  listModels,
  listChatSessions,
  loadChatSession,
  createChatSession,
  updateChatSessionTitle,
  deleteChatSession,
  saveChatMessage,
  deleteChatMessage,
  getTokenStats,
  updateTokenStats,
  resetLifetimeTokensDb,
  migrateChatFromJson,
  listAiMemories,
  addAiMemory,
  extractMemories,
  type ChatMessage,
  type ChatConfig,
  type ChatProvider,
  type ThinkingMode,
  type ModelInfo,
  type StreamChunk,
  type TokenUsage,
  type ImageAttachment,
  type ChatSessionInfo,
} from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useAgentStore } from '@/store/agentStore';
import { toast } from '@/hooks/useToast';
import i18n from '@/i18n';

// ── Types ───────────────────────────────────────────────────

/** Parsed edit suggestion from AI response */
export interface EditSuggestion {
  file: string;
  description: string;
  originalContent: string;
  newContent: string;
  status: 'pending' | 'applied' | 'rejected';
}

/** A single chat session */
interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Token usage statistics */
interface TokenStats {
  sessionPrompt: number;
  sessionCompletion: number;
  lifetimePrompt: number;
  lifetimeCompletion: number;
}

/** Context budget visibility info */
interface ContextInfo {
  contextWindow: number;
  ragBudget: number;
  isCompact: boolean;
}

// ── Store interface ─────────────────────────────────────────

interface ChatState {
  // Session management
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: ChatMessage[];

  // Streaming state
  isStreaming: boolean;
  streamingContent: string;
  streamingReasoning: string;
  streamingReasoningStatus: 'idle' | 'streaming' | 'done';
  currentRequestId: string | null;

  // Config
  config: ChatConfig;

  // Available models
  availableModels: ModelInfo[];
  isLoadingModels: boolean;

  // Context
  referencedFiles: { path: string; title: string }[];

  // Edit suggestions
  pendingEdits: EditSuggestion[];

  // Token tracking
  tokenStats: TokenStats;
  lastUsage: TokenUsage | null;

  // Context budget
  contextInfo: ContextInfo | null;

  // Event listener cleanup
  _unlisten: UnlistenFn | null;

  // Actions
  init: () => Promise<void>;
  cleanup: () => void;
  sendMessage: (content: string, currentNotePath?: string, images?: ImageAttachment[]) => Promise<void>;
  stopStreaming: () => void;
  createSession: (title?: string) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  addReferencedFile: (path: string, title: string) => void;
  removeReferencedFile: (path: string) => void;
  applyEdit: (index: number) => void;
  rejectEdit: (index: number) => void;
  deleteMessage: (index: number) => void;
  retryLastMessage: () => Promise<void>;
  fetchModels: () => Promise<void>;
  updateConfig: (partial: Partial<ChatConfig>) => void;
  resetSessionTokens: () => void;
  resetLifetimeTokens: () => void;
  /** Inject an agent completion result as a chat message */
  injectAgentResult: (summary: string, changesCount: number) => void;
}

// ── Default config ──────────────────────────────────────────

const DEFAULT_CONFIG: ChatConfig = {
  provider: 'openai' as ChatProvider,
  api_url: 'https://api.openai.com/v1',
  api_key: '',
  model: 'gpt-4o',
  temperature: null,
  max_tokens: 4096,
  system_prompt: '',
  context_window: null,
  thinking_mode: 'auto' as ThinkingMode,
};

// ── Provider default URLs ───────────────────────────────────

export const PROVIDER_DEFAULTS: Record<ChatProvider, { url: string; placeholder: string }> = {
  openai: { url: 'https://api.openai.com/v1', placeholder: 'sk-...' },
  claude: { url: 'https://api.anthropic.com', placeholder: 'sk-ant-...' },
  ollama: { url: 'http://localhost:11434', placeholder: '(no key needed)' },
  deepseek: { url: 'https://api.deepseek.com/v1', placeholder: 'sk-...' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta', placeholder: 'AI...' },
  moonshot: { url: 'https://api.moonshot.cn/v1', placeholder: 'sk-...' },
  groq: { url: 'https://api.groq.com/openai/v1', placeholder: 'gsk_...' },
  openrouter: { url: 'https://openrouter.ai/api/v1', placeholder: 'sk-or-...' },
  custom: { url: '', placeholder: 'sk-...' },
};

// ── Config persistence (lightweight, stays in localStorage) ─

const CONFIG_KEY = 'oxidenote-chat-config';
const MIGRATION_KEY = 'oxidenote-chat-migrated';

function loadPersistedConfig(): ChatConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persistConfig(config: ChatConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Storage quota exceeded — ignore
  }
}

// ── Token estimation (mirrors Rust-side heuristic) ──────────

function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 3.5);
}

// ── Edit suggestion parser ──────────────────────────────────

const EDIT_REGEX = /<edit file="([^"]+)">([\s\S]*?)<\/edit>/g;
const DESC_REGEX = /<description>([\s\S]*?)<\/description>/;
const ORIG_REGEX = /<original>([\s\S]*?)<\/original>/;
const MOD_REGEX = /<modified>([\s\S]*?)<\/modified>/;

function parseEdits(text: string): EditSuggestion[] {
  const edits: EditSuggestion[] = [];
  let match;
  EDIT_REGEX.lastIndex = 0;
  while ((match = EDIT_REGEX.exec(text)) !== null) {
    const file = match[1];
    const body = match[2];
    const desc = DESC_REGEX.exec(body)?.[1]?.trim() ?? '';
    const original = ORIG_REGEX.exec(body)?.[1]?.trim() ?? '';
    const modified = MOD_REGEX.exec(body)?.[1]?.trim() ?? '';
    if (original && modified) {
      edits.push({ file, description: desc, originalContent: original, newContent: modified, status: 'pending' });
    }
  }
  return edits;
}

// ── DB row converters ───────────────────────────────────────

/** Convert a ChatSessionInfo from DB to a local ChatSession. */
function toStoreSession(info: ChatSessionInfo): ChatSession {
  return {
    id: info.id,
    title: info.title,
    messages: [], // messages are loaded lazily via switchSession
    createdAt: info.created_at,
    updatedAt: info.updated_at,
  };
}

/** Convert a ChatMessageRow from DB back to a ChatMessage. */
function rowToMessage(row: import('@/lib/api').ChatMessageRow): ChatMessage {
  const msg: ChatMessage = {
    role: row.role as ChatMessage['role'],
    content: row.content,
    dbId: row.id,
  };
  if (row.reasoning) msg.reasoning = row.reasoning;
  if (row.images) {
    try {
      msg.images = JSON.parse(row.images);
    } catch { /* invalid json, skip */ }
  }
  return msg;
}

// ── Store ───────────────────────────────────────────────────

export const useChatStore = create<ChatState>()(
  subscribeWithSelector((set, get) => ({
    // Persistent state (DB-backed)
    sessions: [],
    currentSessionId: null,
    messages: [],
    config: loadPersistedConfig(),
    tokenStats: { sessionPrompt: 0, sessionCompletion: 0, lifetimePrompt: 0, lifetimeCompletion: 0 },

    // Transient state
    isStreaming: false,
    streamingContent: '',
    streamingReasoning: '',
    streamingReasoningStatus: 'idle' as const,
    currentRequestId: null,
    availableModels: [],
    isLoadingModels: false,
    referencedFiles: [],
    pendingEdits: [],
    lastUsage: null,
    contextInfo: null,
    _unlisten: null,

    // ── Initialize: load from DB + set up event listener ────

    init: async () => {
      // Avoid double-init
      if (get()._unlisten) return;

      // Check for legacy localStorage data migration
      const legacyKey = 'oxidenote-chat';
      const migrated = localStorage.getItem(MIGRATION_KEY);
      if (!migrated) {
        const legacyData = localStorage.getItem(legacyKey);
        if (legacyData) {
          try {
            const result = await migrateChatFromJson(legacyData);
            console.info(
              `Chat migration: ${result.sessions_imported} sessions, ${result.messages_imported} messages`,
            );
            localStorage.removeItem(legacyKey);
            // Persist config separately from the migrated blob
            try {
              const parsed = JSON.parse(legacyData);
              if (parsed.config) {
                persistConfig({ ...DEFAULT_CONFIG, ...parsed.config });
              }
            } catch { /* ignore */ }
          } catch (err) {
            console.warn('Chat migration failed:', err);
          }
          localStorage.setItem(MIGRATION_KEY, '1');
        } else {
          localStorage.setItem(MIGRATION_KEY, '1');
        }
      }

      // Load sessions list from DB
      try {
        const sessions = await listChatSessions(100, 0, false);
        const sessionInfos: ChatSession[] = sessions.map(toStoreSession);

        // Load token stats from DB
        let tokenStats = get().tokenStats;
        try {
          const dbStats = await getTokenStats();
          tokenStats = {
            ...tokenStats,
            lifetimePrompt: dbStats.lifetime_prompt,
            lifetimeCompletion: dbStats.lifetime_completion,
          };
        } catch { /* DB not ready yet, use defaults */ }

        set({ sessions: sessionInfos, tokenStats });
      } catch {
        // DB not ready (vault not opened yet)
      }

      // Set up streaming event listener
      const unlisten = await listen<StreamChunk>('chat-stream-chunk', (event) => {
        const chunk = event.payload;
        const state = get();

        // Ignore chunks from different requests
        if (chunk.request_id !== state.currentRequestId) return;

        if (chunk.done) {
          // Stream finished — check for errors
          if (chunk.error) {
            toast({
              title: i18n.t('chat.error'),
              description: chunk.error,
              variant: 'error',
            });
            set({
              isStreaming: false,
              streamingContent: '',
              streamingReasoning: '',
              streamingReasoningStatus: 'idle',
              currentRequestId: null,
            });
            return;
          }

          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: state.streamingContent,
            reasoning: state.streamingReasoning || undefined,
          };

          // Parse edit suggestions
          const edits = parseEdits(state.streamingContent);

          // Update token stats
          const newStats = { ...state.tokenStats };
          if (chunk.usage) {
            newStats.sessionPrompt += chunk.usage.prompt_tokens;
            newStats.sessionCompletion += chunk.usage.completion_tokens;
            newStats.lifetimePrompt += chunk.usage.prompt_tokens;
            newStats.lifetimeCompletion += chunk.usage.completion_tokens;
          }

          // Update session
          const updatedMessages = [...state.messages, assistantMsg];
          const sessions = state.sessions.map((s) =>
            s.id === state.currentSessionId
              ? { ...s, messages: updatedMessages, updatedAt: Date.now() }
              : s,
          );

          set({
            isStreaming: false,
            streamingContent: '',
            streamingReasoning: '',
            streamingReasoningStatus: 'idle',
            currentRequestId: null,
            messages: updatedMessages,
            sessions,
            pendingEdits: [...state.pendingEdits, ...edits],
            lastUsage: chunk.usage ?? state.lastUsage,
            tokenStats: newStats,
          });

          // Persist assistant message to DB and capture its ID
          if (state.currentSessionId) {
            saveChatMessage(
              state.currentSessionId,
              'assistant',
              state.streamingContent,
              state.streamingReasoning || null,
              null,
              chunk.usage ? JSON.stringify(chunk.usage) : null,
            )
              .then((dbId) => {
                // Attach dbId to the last assistant message
                set((s) => ({
                  messages: s.messages.map((m, i) =>
                    i === s.messages.length - 1 && m.role === 'assistant' && !m.dbId
                      ? { ...m, dbId }
                      : m,
                  ),
                }));
              })
              .catch((err) => console.warn('Failed to save assistant message:', err));

            // Update token stats in DB
            if (chunk.usage) {
              updateTokenStats(
                chunk.usage.prompt_tokens,
                chunk.usage.completion_tokens,
              ).catch((err) => console.warn('Failed to update token stats:', err));
            }
          }
        } else {
          // Accumulate streaming content
          const updates: Partial<ChatState> = {};

          if (chunk.reasoning) {
            updates.streamingReasoning = state.streamingReasoning + chunk.reasoning;
            if (state.streamingReasoningStatus === 'idle') {
              updates.streamingReasoningStatus = 'streaming';
            }
          }

          if (chunk.content) {
            updates.streamingContent = state.streamingContent + chunk.content;
            if (state.streamingReasoningStatus === 'streaming') {
              updates.streamingReasoningStatus = 'done';
            }
          }

          set(updates);
        }
      });

      set({ _unlisten: unlisten });
    },

    cleanup: () => {
      const { _unlisten } = get();
      if (_unlisten) {
        _unlisten();
        set({ _unlisten: null });
      }
    },

    // ── Send message ────────────────────────────────────────

    sendMessage: async (content, currentNotePath, images) => {
      const state = get();
      if (state.isStreaming) return;

      // ── @agent prefix detection ─────────────────────────────
      // Format: "@agent <kind> [instruction]"
      // Example: "@agent daily_review" or "@agent duplicate_detector focus on folder/xyz"
      const agentMatch = content.match(/^@agent\s+([\w]+)(?:\s+(.*))?$/s);
      if (agentMatch) {
        const kindStr = agentMatch[1];
        const instruction = agentMatch[2]?.trim();

        // Ensure a session exists before recording the user message
        if (!state.currentSessionId) {
          await get().createSession();
        }
        const sessionId = get().currentSessionId;

        // Record user message in chat history
        const userMsg: ChatMessage = { role: 'user', content };
        const updatedMessages = [...get().messages, userMsg];
        const sessions = get().sessions.map((s) => {
          if (s.id !== sessionId) return s;
          return { ...s, messages: updatedMessages, updatedAt: Date.now() };
        });
        set({ messages: updatedMessages, sessions });

        // Persist user message
        if (sessionId) {
          saveChatMessage(sessionId, 'user', content, null, null, null)
            .catch((err) => console.warn('Failed to save @agent user message:', err));
        }

        // Build AgentTask and delegate to agentStore
        const agentKind = kindStr.includes('custom')
          ? { custom: kindStr } as const
          : kindStr as import('@/lib/api').AgentKind;
        const task: import('@/lib/api').AgentTask = {
          kind: agentKind,
          scope: instruction || currentNotePath || undefined,
        };
        const chatConfig = get().config;
        useAgentStore.getState().runAgent(task, chatConfig);

        // Add a system notification in chat
        const notifyMsg: ChatMessage = {
          role: 'assistant',
          content: `<!--agent-started-->\n${i18n.t('chat.agentTriggered', { kind: kindStr })}`,
        };
        const withNotify = [...get().messages, notifyMsg];
        set({
          messages: withNotify,
          sessions: get().sessions.map((s) => {
            if (s.id !== sessionId) return s;
            return { ...s, messages: withNotify, updatedAt: Date.now() };
          }),
        });

        if (sessionId) {
          saveChatMessage(sessionId, 'assistant', notifyMsg.content, null, null, null)
            .catch((err) => console.warn('Failed to save agent notification:', err));
        }

        return; // Skip normal chat stream
      }

      // Ensure a session exists
      if (!state.currentSessionId) {
        await get().createSession();
      }

      const requestId = crypto.randomUUID();

      // Build user message
      const userMsg: ChatMessage = {
        role: 'user',
        content,
        images: images?.length ? images : undefined,
      };

      const updatedMessages = [...state.messages, userMsg];
      const sessionId = get().currentSessionId;

      // Auto-title: use first 30 chars of first user message
      const currentSession = state.sessions.find(s => s.id === sessionId);
      const isFirstMsg = currentSession ? currentSession.messages.filter(m => m.role === 'user').length === 0 : true;
      const autoTitle = isFirstMsg ? content.slice(0, 30).trim() : undefined;

      const sessions = state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          messages: updatedMessages,
          updatedAt: Date.now(),
          title: autoTitle ?? s.title,
        };
      });

      set({
        messages: updatedMessages,
        sessions,
        isStreaming: true,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningStatus: 'idle',
        currentRequestId: requestId,
        pendingEdits: [],
      });

      // Persist user message to DB and capture its ID
      if (sessionId) {
        const imagesJson = images?.length ? JSON.stringify(images) : null;
        saveChatMessage(sessionId, 'user', content, null, imagesJson, null)
          .then((dbId) => {
            // Attach dbId to the last user message
            set((s) => ({
              messages: s.messages.map((m, i) =>
                i === s.messages.length - 1 && m.role === 'user' && !m.dbId
                  ? { ...m, dbId }
                  : m,
              ),
            }));
          })
          .catch((err) => console.warn('Failed to save user message:', err));
        if (autoTitle) {
          updateChatSessionTitle(sessionId, autoTitle)
            .catch((err) => console.warn('Failed to update session title:', err));
        }
      }

      try {
        // Estimate current history tokens
        const historyText = updatedMessages.map(m => m.content).join('\n');
        const historyTokenEstimate = estimateTokens(historyText);

        // Build RAG context if we have a current note
        const notePath = currentNotePath ?? useNoteStore.getState().activeTabPath ?? '';
        const { config, referencedFiles } = get();

        let systemPrompt = config.system_prompt;
        let contextInfo: ContextInfo | null = null;

        if (notePath) {
          try {
            const ctx = await buildChatContext(
              notePath,
              content,
              config.provider,
              config.api_url,
              config.model,
              config.context_window ?? null,
              config.max_tokens,
              referencedFiles.map(f => f.path),
              historyTokenEstimate,
            );

            contextInfo = {
              contextWindow: ctx.context_window,
              ragBudget: ctx.rag_budget_tokens,
              isCompact: ctx.is_compact,
            };

            // Build system prompt with RAG context
            systemPrompt = buildSystemPrompt(config.system_prompt, ctx);
          } catch {
            // If RAG fails, proceed without context
          }
        }

        set({ contextInfo });

        // Load AI memories and inject into system prompt
        try {
          const memories = await listAiMemories();
          if (memories.length > 0) {
            const memorySection = '\n\n## AI Memory (persistent context)\n' +
              memories.map((m) => `- [${m.category}] ${m.content}`).join('\n');
            systemPrompt = (systemPrompt || defaultSystemPrompt()) + memorySection;
          }
        } catch {
          // If memory loading fails, proceed without it
        }

        // Assemble final messages
        const finalMessages: ChatMessage[] = [
          { role: 'system', content: systemPrompt || defaultSystemPrompt() },
          ...updatedMessages,
        ];

        // Fire-and-forget stream
        await chatStream(requestId, finalMessages, config);
      } catch (err) {
        set({
          isStreaming: false,
          currentRequestId: null,
        });
        toast({
          title: i18n.t('chat.error'),
          description: String(err),
          variant: 'error',
        });
      }
    },

    // ── Stop streaming ──────────────────────────────────────

    stopStreaming: () => {
      const { currentRequestId } = get();
      if (currentRequestId) {
        chatAbort(currentRequestId).catch(() => {});
        // Safety timeout: if backend doesn't send done chunk within 3s, force-reset
        const savedId = currentRequestId;
        setTimeout(() => {
          if (get().currentRequestId === savedId && get().isStreaming) {
            set({
              isStreaming: false,
              streamingContent: '',
              streamingReasoning: '',
              streamingReasoningStatus: 'idle',
              currentRequestId: null,
            });
          }
        }, 3000);
      }
    },

    // ── Session management ──────────────────────────────────

    createSession: async (title) => {
      const id = crypto.randomUUID();
      const displayTitle = title ?? '';
      const session: ChatSession = {
        id,
        title: displayTitle,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set((s) => ({
        sessions: [session, ...s.sessions],
        currentSessionId: id,
        messages: [],
        pendingEdits: [],
        referencedFiles: [],
        contextInfo: null,
        tokenStats: { ...s.tokenStats, sessionPrompt: 0, sessionCompletion: 0 },
      }));

      // Persist to DB
      createChatSession(id, displayTitle)
        .catch((err) => console.warn('Failed to create session in DB:', err));
    },

    switchSession: async (id) => {
      // Extract memories from the session we're leaving (background, non-blocking)
      const leavingMessages = get().messages;
      const leavingConfig = get().config;
      if (leavingMessages.length >= 4 && leavingConfig.api_key) {
        extractMemoriesFromConversation(leavingMessages, leavingConfig);
      }

      // Optimistic: show empty while loading
      set({
        currentSessionId: id,
        messages: [],
        pendingEdits: [],
        referencedFiles: [],
        contextInfo: null,
        tokenStats: { ...get().tokenStats, sessionPrompt: 0, sessionCompletion: 0 },
      });

      // Load full session from DB
      try {
        const [sessionInfo, rows] = await loadChatSession(id);
        const messages: ChatMessage[] = rows.map(rowToMessage);

        // Guard against stale load: only apply if this session is still active
        if (get().currentSessionId !== id) return;

        // Rebuild local session with loaded messages
        set((s) => ({
          messages,
          sessions: s.sessions.map((ss) =>
            ss.id === id
              ? { ...ss, messages, title: sessionInfo.title, updatedAt: sessionInfo.updated_at }
              : ss,
          ),
        }));
      } catch (err) {
        console.warn('Failed to load session from DB:', err);
        // Try falling back to in-memory session data
        if (get().currentSessionId !== id) return;
        const cached = get().sessions.find(s => s.id === id);
        if (cached) {
          set({ messages: [...cached.messages] });
        }
      }
    },

    deleteSession: async (id) => {
      set((s) => {
        const sessions = s.sessions.filter(ss => ss.id !== id);
        const isCurrent = s.currentSessionId === id;
        return {
          sessions,
          currentSessionId: isCurrent ? (sessions[0]?.id ?? null) : s.currentSessionId,
          messages: isCurrent ? (sessions[0]?.messages ?? []) : s.messages,
          pendingEdits: isCurrent ? [] : s.pendingEdits,
        };
      });

      // Delete from DB
      deleteChatSession(id)
        .catch((err) => console.warn('Failed to delete session from DB:', err));
    },

    // ── Reference management ────────────────────────────────

    addReferencedFile: (path, title) => {
      set((s) => {
        if (s.referencedFiles.some(f => f.path === path)) return s;
        return { referencedFiles: [...s.referencedFiles, { path, title }] };
      });
    },

    removeReferencedFile: (path) => {
      set((s) => ({
        referencedFiles: s.referencedFiles.filter(f => f.path !== path),
      }));
    },

    // ── Edit suggestion actions ─────────────────────────────

    applyEdit: (index) => {
      set((s) => ({
        pendingEdits: s.pendingEdits.map((e, i) =>
          i === index ? { ...e, status: 'applied' as const } : e,
        ),
      }));
    },

    rejectEdit: (index) => {
      set((s) => ({
        pendingEdits: s.pendingEdits.map((e, i) =>
          i === index ? { ...e, status: 'rejected' as const } : e,
        ),
      }));
    },

    // ── Message-level operations ────────────────────────────

    deleteMessage: (index) => {
      const { messages } = get();
      const msg = messages[index];
      if (!msg) return;

      // Remove from state
      set((s) => ({
        messages: s.messages.filter((_, i) => i !== index),
      }));

      // Delete from DB if we have a dbId
      if (msg.dbId) {
        deleteChatMessage(msg.dbId)
          .catch((err) => console.warn('Failed to delete message from DB:', err));
      }
    },

    retryLastMessage: async () => {
      const { messages, isStreaming } = get();
      if (isStreaming) return;
      if (messages.length < 2) return;

      // Find the last assistant message and the user message before it
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role !== 'assistant') return;

      const userMsg = messages[messages.length - 2];
      if (userMsg.role !== 'user') return;

      // Capture content before removing
      const userContent = userMsg.content;
      const userImages = userMsg.images;

      // Remove both the assistant and user messages from state
      const assistantDbId = lastMsg.dbId;
      const userDbId = userMsg.dbId;
      set((s) => ({
        messages: s.messages.slice(0, -2),
        pendingEdits: [],
      }));

      // Delete from DB
      if (assistantDbId) {
        deleteChatMessage(assistantDbId)
          .catch((err) => console.warn('Failed to delete message from DB:', err));
      }
      if (userDbId) {
        deleteChatMessage(userDbId)
          .catch((err) => console.warn('Failed to delete message from DB:', err));
      }

      // Re-send the user message (this re-adds it to state and DB)
      const notePath = useNoteStore.getState().activeTabPath;
      try {
        await get().sendMessage(userContent, notePath ?? undefined, userImages);
      } catch {
        // sendMessage already shows toast on error
      }
    },

    // ── Model fetching ──────────────────────────────────────

    fetchModels: async () => {
      set({ isLoadingModels: true });
      try {
        const models = await listModels(get().config);
        set({ availableModels: models, isLoadingModels: false });
      } catch {
        set({ isLoadingModels: false });
      }
    },

    // ── Config ──────────────────────────────────────────────

    updateConfig: (partial) => {
      set((s) => ({
        config: { ...s.config, ...partial },
      }));
    },

    // ── Token stats reset ───────────────────────────────────

    resetSessionTokens: () => {
      set((s) => ({
        tokenStats: { ...s.tokenStats, sessionPrompt: 0, sessionCompletion: 0 },
      }));
    },

    resetLifetimeTokens: () => {
      set((s) => ({
        tokenStats: { ...s.tokenStats, lifetimePrompt: 0, lifetimeCompletion: 0 },
      }));
      resetLifetimeTokensDb()
        .catch((err) => console.warn('Failed to reset lifetime tokens in DB:', err));
    },

    // ── Agent result injection ────────────────────────────────

    injectAgentResult: (summary, changesCount) => {
      const sessionId = get().currentSessionId;
      if (!sessionId) return;

      // Build an assistant message with agent-result marker prefix
      const content = `<!--agent-result:${changesCount}-->\n${summary}`;
      const agentMsg: ChatMessage = { role: 'assistant', content };

      const updatedMessages = [...get().messages, agentMsg];
      const sessions = get().sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return { ...s, messages: updatedMessages, updatedAt: Date.now() };
      });

      set({ messages: updatedMessages, sessions });

      // Persist to DB
      saveChatMessage(sessionId, 'assistant', content, null, null, null)
        .catch((err) => console.warn('Failed to save agent result message:', err));
    },
  })),
);

// Auto-persist config changes to localStorage (lightweight — no session/message data)
useChatStore.subscribe(
  (state) => state.config,
  (config) => {
    persistConfig(config);
  },
);

// ── System prompt builder ───────────────────────────────────

function defaultSystemPrompt(): string {
  return `You are OxideNote's writing assistant. You help users write, rewrite, summarize, and organize their Markdown notes.

## Instructions
- Respond in the same language as the user's message
- When suggesting text edits, use <edit file="path"> XML format with <description>, <original>, and <modified> tags
- Keep suggestions contextual and consistent with the note's style
- For continuation requests, match the existing writing tone and structure
- Be concise. Avoid unnecessary preamble.

## Academic Writing
- When the current note is a .typ file, assist with Typst syntax, layout, math, and bibliography
- When the current note is a .tex file, assist with LaTeX commands, packages, and environments
- For Typst: use #set, #show, #import, $ math $, etc.
- For LaTeX: use \\usepackage, \\begin{}, \\end{}, \\section{}, etc.`;
}

function buildSystemPrompt(
  customPrompt: string,
  ctx: { current_note: { path: string; title: string; content: string }; backlink_summaries: { path: string; title: string; summary: string }[]; semantic_snippets: { source: string; text: string; score: number }[]; referenced_notes: { path: string; title: string; content: string }[] },
): string {
  let prompt = customPrompt || defaultSystemPrompt();

  prompt += `\n\n## Current Note\nTitle: ${ctx.current_note.title}\nPath: ${ctx.current_note.path}\n---\n${ctx.current_note.content}\n---`;

  // Inject academic syntax reference when editing Typst or LaTeX files
  const notePath = ctx.current_note.path.toLowerCase();
  if (notePath.endsWith('.typ')) {
    prompt += '\n\n## Typst Quick Reference\nCommon syntax: #set text(size: 12pt), #show heading: set text(blue), #import "file.typ", $ x^2 $, #figure(image("img.png")), #bibliography("refs.bib"), #cite(<key>), #table(columns: 3, ..), #enum / #list.';
    // Include last compile diagnostics if available
    const diags = useNoteStore.getState().lastCompileDiagnostics;
    if (diags.length > 0) {
      prompt += '\n\n## Compilation Diagnostics\n' +
        diags.map((d) => `- [${d.severity}] L${d.line}:${d.column} — ${d.message}`).join('\n');
    }
  } else if (notePath.endsWith('.tex')) {
    prompt += '\n\n## LaTeX Quick Reference\nCommon commands: \\documentclass{article}, \\usepackage{...}, \\begin{document}, \\section{}, \\subsection{}, $ x^2 $, \\begin{figure}, \\includegraphics, \\cite{key}, \\bibliography{refs}, \\begin{table}, \\begin{enumerate/itemize}.';
  }

  if (ctx.backlink_summaries.length > 0) {
    prompt += '\n\n## Related Notes (Backlinks)';
    for (const bl of ctx.backlink_summaries) {
      prompt += `\n### ${bl.title} (${bl.path})\n${bl.summary}`;
    }
  }

  if (ctx.semantic_snippets.length > 0) {
    prompt += '\n\n## Semantically Related Snippets';
    for (const sn of ctx.semantic_snippets) {
      prompt += `\n- [${sn.source}] (score: ${sn.score.toFixed(2)}): ${sn.text}`;
    }
  }

  if (ctx.referenced_notes.length > 0) {
    prompt += '\n\n## User-Referenced Notes';
    for (const ref of ctx.referenced_notes) {
      prompt += `\n### ${ref.title} (${ref.path})\n${ref.content}`;
    }
  }

  return prompt;
}

// Background helper: extract memorable facts from a chat session when switching away
async function extractMemoriesFromConversation(
  messages: ChatMessage[],
  config: ChatConfig,
): Promise<void> {
  try {
    // Format messages into a flat conversation string (skip system messages)
    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');

    const memories = await extractMemories(conversation, config);

    for (const m of memories) {
      await addAiMemory(m.content, m.category);
    }
  } catch {
    // Silent: this is a background optimization, never interrupt the user
  }
}
