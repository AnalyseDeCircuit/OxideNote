import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import {
  chatStream,
  chatAbort,
  buildChatContext,
  listModels,
  type ChatMessage,
  type ChatConfig,
  type ChatProvider,
  type ThinkingMode,
  type ModelInfo,
  type StreamChunk,
  type TokenUsage,
  type ImageAttachment,
} from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';

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
  createSession: (title?: string) => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  addReferencedFile: (path: string, title: string) => void;
  removeReferencedFile: (path: string) => void;
  applyEdit: (index: number) => void;
  rejectEdit: (index: number) => void;
  fetchModels: () => Promise<void>;
  updateConfig: (partial: Partial<ChatConfig>) => void;
  resetSessionTokens: () => void;
  resetLifetimeTokens: () => void;
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

// ── Persistence helpers ─────────────────────────────────────

const STORAGE_KEY = 'oxidenote-chat';

function loadPersistedState(): Partial<ChatState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return {
      sessions: data.sessions ?? [],
      currentSessionId: data.currentSessionId ?? null,
      messages: data.messages ?? [],
      config: { ...DEFAULT_CONFIG, ...data.config },
      tokenStats: data.tokenStats ?? { sessionPrompt: 0, sessionCompletion: 0, lifetimePrompt: 0, lifetimeCompletion: 0 },
    };
  } catch {
    return {};
  }
}

function persistState(state: ChatState) {
  try {
    const data = {
      sessions: state.sessions,
      currentSessionId: state.currentSessionId,
      messages: state.messages,
      config: state.config,
      tokenStats: state.tokenStats,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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

// ── Store ───────────────────────────────────────────────────

const persisted = loadPersistedState();

export const useChatStore = create<ChatState>()(
  subscribeWithSelector((set, get) => ({
    // Persisted state
    sessions: persisted.sessions ?? [],
    currentSessionId: persisted.currentSessionId ?? null,
    messages: persisted.messages ?? [],
    config: persisted.config ?? { ...DEFAULT_CONFIG },
    tokenStats: persisted.tokenStats ?? { sessionPrompt: 0, sessionCompletion: 0, lifetimePrompt: 0, lifetimeCompletion: 0 },

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

    // ── Initialize event listener ───────────────────────────

    init: async () => {
      // Avoid double-init
      if (get()._unlisten) return;

      const unlisten = await listen<StreamChunk>('chat-stream-chunk', (event) => {
        const chunk = event.payload;
        const state = get();

        // Ignore chunks from different requests
        if (chunk.request_id !== state.currentRequestId) return;

        if (chunk.done) {
          // Stream finished — check for errors
          if (chunk.error) {
            console.warn('Chat stream error:', chunk.error);
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

      // Ensure a session exists
      if (!state.currentSessionId) {
        get().createSession();
      }

      const requestId = crypto.randomUUID();

      // Build user message
      const userMsg: ChatMessage = {
        role: 'user',
        content,
        images: images?.length ? images : undefined,
      };

      const updatedMessages = [...state.messages, userMsg];

      // Auto-title: use first 30 chars of first user message
      const sessions = state.sessions.map((s) => {
        if (s.id !== get().currentSessionId) return s;
        const isFirstMsg = s.messages.filter(m => m.role === 'user').length === 0;
        return {
          ...s,
          messages: updatedMessages,
          updatedAt: Date.now(),
          title: isFirstMsg ? content.slice(0, 30).trim() || s.title : s.title,
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
        console.warn('Chat send failed:', err);
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

    createSession: (title) => {
      const id = crypto.randomUUID();
      const session: ChatSession = {
        id,
        title: title ?? '',
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
    },

    switchSession: (id) => {
      const session = get().sessions.find(s => s.id === id);
      if (!session) return;
      set({
        currentSessionId: id,
        messages: [...session.messages],
        pendingEdits: [],
        referencedFiles: [],
        contextInfo: null,
        tokenStats: { ...get().tokenStats, sessionPrompt: 0, sessionCompletion: 0 },
      });
    },

    deleteSession: (id) => {
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
    },
  })),
);

// Auto-persist on state changes (debounced to avoid excessive writes during streaming)
let persistTimer: ReturnType<typeof setTimeout> | null = null;
useChatStore.subscribe(
  (state) => ({
    sessions: state.sessions,
    currentSessionId: state.currentSessionId,
    messages: state.messages,
    config: state.config,
    tokenStats: state.tokenStats,
  }),
  () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistState(useChatStore.getState());
    }, 1000);
  },
  { equalityFn: () => false },
);

// ── System prompt builder ───────────────────────────────────

function defaultSystemPrompt(): string {
  return `You are OxideNote's writing assistant. You help users write, rewrite, summarize, and organize their Markdown notes.

## Instructions
- Respond in the same language as the user's message
- When suggesting text edits, use <edit file="path"> XML format with <description>, <original>, and <modified> tags
- Keep suggestions contextual and consistent with the note's style
- For continuation requests, match the existing writing tone and structure
- Be concise. Avoid unnecessary preamble.`;
}

function buildSystemPrompt(
  customPrompt: string,
  ctx: { current_note: { path: string; title: string; content: string }; backlink_summaries: { path: string; title: string; summary: string }[]; semantic_snippets: { source: string; text: string; score: number }[]; referenced_notes: { path: string; title: string; content: string }[] },
): string {
  let prompt = customPrompt || defaultSystemPrompt();

  prompt += `\n\n## Current Note\nTitle: ${ctx.current_note.title}\nPath: ${ctx.current_note.path}\n---\n${ctx.current_note.content}\n---`;

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
