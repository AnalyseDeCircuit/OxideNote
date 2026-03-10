import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  agentRun,
  agentAbort,
  agentPause,
  agentResume,
  agentApplyChanges,
  agentDismissChanges,
  agentStatus,
  agentListHistory,
  agentListCustom,
} from '@/lib/api';
import { useChatStore } from '@/store/chatStore';
import type {
  AgentKind,
  AgentStatus,
  AgentTask,
  ChatConfig,
  PlanStep,
  ProposedChange,
  AgentRunSummary,
  CustomAgentDef,
  AgentStatusResponse,
} from '@/lib/api';

// ── Agent progress event payload ────────────────────────────

interface AgentProgressEvent {
  task_id: string;
  status: string;
  message?: string;
  step_index?: number;
  step_description?: string;
  step_status?: string;
}

interface AgentCompleteEvent {
  task_id: string;
  summary: string;
  changes_count: number;
  auto_applied: boolean;
}

interface AgentErrorEvent {
  error: string;
}

// ── Store interface ─────────────────────────────────────────

interface AgentState {
  // Current run state
  isRunning: boolean;
  pauseRequested: boolean;
  currentTaskId: string | null;
  currentKind: AgentKind | null;
  status: AgentStatus | null;
  planSteps: PlanStep[];
  progress: string;

  // Results
  proposedChanges: ProposedChange[];
  summary: string | null;
  autoAppliedCount: number;

  // Queue
  queueCount: number;

  // History
  history: AgentRunSummary[];

  // Custom agents
  customAgents: CustomAgentDef[];

  // Actions
  runAgent: (task: AgentTask, config: ChatConfig) => Promise<void>;
  abortAgent: () => Promise<void>;
  pauseAgent: () => Promise<void>;
  resumeAgent: () => Promise<void>;
  applyChanges: (indices: number[]) => Promise<void>;
  dismissChanges: () => Promise<void>;
  loadHistory: () => Promise<void>;
  loadCustomAgents: () => Promise<void>;
  fetchStatus: () => Promise<void>;

  // Internal: event listener setup
  _listenersInitialized: boolean;
  _unlistenFns: UnlistenFn[];
  initListeners: () => void;
  cleanupListeners: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  // ── Initial state ───────────────────────────────────────
  isRunning: false,
  pauseRequested: false,
  currentTaskId: null,
  currentKind: null,
  status: null,
  planSteps: [],
  progress: '',
  proposedChanges: [],
  summary: null,
  autoAppliedCount: 0,
  queueCount: 0,
  history: [],
  customAgents: [],
  _listenersInitialized: false,
  _unlistenFns: [],

  // ── Actions ─────────────────────────────────────────────

  runAgent: async (task, config) => {
    try {
      const taskId = await agentRun(task, config);
      if (taskId === 'queued') {
        set({ progress: 'Task queued...' });
        return;
      }
      set({
        isRunning: true,
        pauseRequested: false,
        currentTaskId: taskId,
        currentKind: task.kind,
        status: 'planning',
        planSteps: [],
        progress: 'Starting agent...',
        proposedChanges: [],
        summary: null,
      });
    } catch (e) {
      console.warn('Agent run failed:', e);
    }
  },

  abortAgent: async () => {
    try {
      await agentAbort();
      set({
        isRunning: false,
        pauseRequested: false,
        status: 'aborted',
        progress: 'Agent aborted',
        currentTaskId: null,
        currentKind: null,
      });
    } catch (e) {
      console.warn('Agent abort failed:', e);
    }
  },

  pauseAgent: async () => {
    const { isRunning, status, pauseRequested } = get();
    if (!isRunning || status === 'paused' || pauseRequested) return;
    try {
      await agentPause();
      set({
        pauseRequested: true,
        progress: 'Pause requested. Agent will pause after the current step.',
      });
    } catch (e) {
      console.warn('Agent pause failed:', e);
    }
  },

  resumeAgent: async () => {
    if (!get().isRunning) return;
    try {
      await agentResume();
      set({
        pauseRequested: false,
        status: 'executing',
        progress: 'Agent resumed',
      });
    } catch (e) {
      console.warn('Agent resume failed:', e);
    }
  },

  applyChanges: async (indices) => {
    const { currentTaskId } = get();
    if (!currentTaskId) return;
    try {
      await agentApplyChanges(currentTaskId, indices);
      set({
        proposedChanges: [],
        status: 'completed',
        isRunning: false,
        progress: 'Changes applied',
        autoAppliedCount: 0,
      });
    } catch (e) {
      console.warn('Apply changes failed:', e);
    }
  },

  dismissChanges: async () => {
    try {
      await agentDismissChanges();
      set({
        proposedChanges: [],
        status: null,
        isRunning: false,
        currentTaskId: null,
        currentKind: null,
        summary: null,
        progress: '',
      });
    } catch (e) {
      console.warn('Dismiss changes failed:', e);
    }
  },

  loadHistory: async () => {
    try {
      const history = await agentListHistory(20);
      set({ history });
    } catch (e) {
      console.warn('Load agent history failed:', e);
    }
  },

  loadCustomAgents: async () => {
    try {
      const customAgents = await agentListCustom();
      set({ customAgents });
    } catch (e) {
      console.warn('Load custom agents failed:', e);
    }
  },

  fetchStatus: async () => {
    try {
      const resp: AgentStatusResponse = await agentStatus();
      if (resp.state === 'running') {
        set({
          isRunning: true,
          pauseRequested: false,
          currentTaskId: resp.task_id,
          status: 'executing',
          queueCount: resp.queue_count,
        });
      } else if (resp.state === 'paused') {
        set({
          isRunning: true,
          pauseRequested: false,
          currentTaskId: resp.task_id,
          status: 'paused',
          queueCount: resp.queue_count,
        });
      } else if (resp.state === 'waiting_approval' && resp.result) {
        set({
          isRunning: false,
          pauseRequested: false,
          currentTaskId: resp.task_id,
          status: 'waiting_approval',
          planSteps: resp.result.plan_steps,
          proposedChanges: resp.result.proposed_changes,
          summary: resp.result.summary,
          queueCount: resp.queue_count,
        });
      } else {
        set({ isRunning: false, pauseRequested: false, currentTaskId: null, status: null, queueCount: resp.queue_count });
      }
    } catch (e) {
      console.warn('Fetch agent status failed:', e);
    }
  },

  // ── Event listeners ─────────────────────────────────────

  initListeners: () => {
    if (get()._listenersInitialized) return;
    set({ _listenersInitialized: true });

    // Track unlisten functions for cleanup
    const registerListener = async <T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      const unlisten = await listen<T>(event, handler);
      set((s) => ({ _unlistenFns: [...s._unlistenFns, unlisten] }));
    };

    // Progress events
    registerListener<AgentProgressEvent>('agent-progress', (event) => {
      const payload = event.payload;
      set((s) => {
        const updates: Partial<AgentState> = {};
        if (payload.message) {
          updates.progress = payload.message;
        }
        if (payload.status) {
          updates.status = payload.status as AgentStatus;
          if (payload.status === 'paused') {
            updates.pauseRequested = false;
          }
        }
        // Update plan step status if provided
        if (payload.step_index !== undefined && payload.step_description) {
          const steps = [...s.planSteps];
          const existing = steps.find((st) => st.index === payload.step_index);
          if (existing) {
            existing.status = (payload.step_status as PlanStep['status']) || 'in_progress';
          } else {
            steps.push({
              index: payload.step_index,
              description: payload.step_description,
              status: (payload.step_status as PlanStep['status']) || 'pending',
              output: null,
            });
          }
          updates.planSteps = steps;
        }
        return updates;
      });
    });

    // Complete event
    registerListener<AgentCompleteEvent>('agent-complete', (event) => {
      const { summary, changes_count, auto_applied } = event.payload;
      set({
        isRunning: false,
        pauseRequested: false,
        currentKind: null,
        progress: 'Agent completed',
        summary,
        autoAppliedCount: auto_applied ? changes_count : 0,
        // auto_applied changes are already written — show as completed
        status: (changes_count > 0 && !auto_applied) ? 'waiting_approval' : 'completed',
      });
      // Refresh status to pick up proposed changes (if waiting approval)
      if (changes_count > 0 && !auto_applied) {
        get().fetchStatus();
      }

      // Bridge result to chat so users see it in the conversation
      useChatStore.getState().injectAgentResult(summary, changes_count);
    });

    // Error event
    registerListener<AgentErrorEvent>('agent-error', (event) => {
      set({
        isRunning: false,
        pauseRequested: false,
        currentKind: null,
        status: 'failed',
        progress: `Error: ${event.payload.error}`,
      });
    });
  },

  cleanupListeners: () => {
    const fns = get()._unlistenFns;
    for (const fn of fns) {
      fn();
    }
    set({ _unlistenFns: [], _listenersInitialized: false });
  },
}));
