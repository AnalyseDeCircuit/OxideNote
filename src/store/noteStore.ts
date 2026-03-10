import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Tab {
  path: string;
  title: string;
  isDirty: boolean;
  isPinned: boolean;
}

export interface ConflictRecord {
  path: string;
  localContent: string;
  detectedAt: number;
}

export type SaveOutcome = 'saved' | 'conflict' | 'noop' | 'failed';

// ── Pending save callbacks ──────────────────────────────────
// NoteEditor registers a flush callback for the active note.
// When a tab is closed or app is exiting, we invoke the callback
// to ensure unsaved content is written to disk immediately.
const pendingSaveCallbacks = new Map<string, () => Promise<SaveOutcome>>();

export function registerPendingSave(path: string, flush: () => Promise<SaveOutcome>) {
  pendingSaveCallbacks.set(path, flush);
}

export function unregisterPendingSave(path: string) {
  pendingSaveCallbacks.delete(path);
}

export async function flushPendingSave(path: string) {
  const flush = pendingSaveCallbacks.get(path);
  if (!flush) return 'noop' as SaveOutcome;
  return flush();
}

export async function flushAllPendingSaves() {
  const entries = Array.from(pendingSaveCallbacks.entries());
  const settled = await Promise.all(
    entries.map(async ([path, fn]) => [path, await fn()] as const)
  );

  return Object.fromEntries(settled) as Record<string, SaveOutcome>;
}

/** Lightweight diagnostic entry for Typst/LaTeX compile results */
export interface CompileDiagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
}

interface NoteState {
  openTabs: Tab[];
  activeTabPath: string | null;
  conflicts: Record<string, ConflictRecord>;
  /** Current editor content for the active tab (used by OutlinePanel etc.) */
  activeContent: string;
  /** Cursor position in the active editor */
  cursorLine: number;
  cursorCol: number;
  /** Last compile diagnostics for the active .typ/.tex file */
  lastCompileDiagnostics: CompileDiagnostic[];

  /** Pending scroll target (e.g. after opening a note from canvas block card) */
  pendingScrollTarget: { blockId: string } | null;
  setPendingScrollTarget: (target: { blockId: string } | null) => void;

  openNote: (path: string, title: string) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  markDirty: (path: string) => void;
  markClean: (path: string) => void;
  updateTabPath: (oldPath: string, newPath: string, newTitle: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (path: string) => void;
  closeTabsToRight: (path: string) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  setConflict: (path: string, localContent: string) => void;
  clearConflict: (path: string) => void;
  clearAllConflicts: () => void;
  setActiveContent: (content: string) => void;
  setCursorPosition: (line: number, col: number) => void;
  togglePinTab: (path: string) => void;
  /** Recently opened notes (most recent first, max 20) */
  recentNotes: { path: string; title: string }[];
  setLastCompileDiagnostics: (diags: CompileDiagnostic[]) => void;
}

export const useNoteStore = create<NoteState>()(
  persist(
    (set, get) => ({
  openTabs: [],
  activeTabPath: null,
  conflicts: {},
  activeContent: '',
  cursorLine: 1,
  cursorCol: 1,
  recentNotes: [],
  lastCompileDiagnostics: [],
  pendingScrollTarget: null,
  setPendingScrollTarget: (target) => set({ pendingScrollTarget: target }),
  setLastCompileDiagnostics: (diags) => set({ lastCompileDiagnostics: diags }),

  openNote: (path, title) => {
    const { openTabs, recentNotes } = get();
    const existing = openTabs.find((t) => t.path === path);
    // Track in recent notes list (most recent first, max 20)
    const updatedRecent = [{ path, title }, ...recentNotes.filter((r) => r.path !== path)].slice(0, 20);
    if (existing) {
      set({ activeTabPath: path, recentNotes: updatedRecent });
    } else {
      set({
        openTabs: [...openTabs, { path, title, isDirty: false, isPinned: false }],
        activeTabPath: path,
        recentNotes: updatedRecent,
      });
    }
  },

  closeTab: (path) => {
    const { openTabs, activeTabPath, conflicts } = get();
    const idx = openTabs.findIndex((t) => t.path === path);
    const filtered = openTabs.filter((t) => t.path !== path);

    let newActive = activeTabPath;
    if (activeTabPath === path) {
      if (filtered.length === 0) {
        newActive = null;
      } else if (idx >= filtered.length) {
        newActive = filtered[filtered.length - 1].path;
      } else {
        newActive = filtered[idx].path;
      }
    }

    const nextConflicts = { ...conflicts };
    delete nextConflicts[path];

    set({ openTabs: filtered, activeTabPath: newActive, conflicts: nextConflicts });
  },

  setActiveTab: (path) => set({ activeTabPath: path }),

  markDirty: (path) =>
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.path === path ? { ...t, isDirty: true } : t
      ),
    })),

  markClean: (path) =>
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.path === path ? { ...t, isDirty: false } : t
      ),
    })),

  updateTabPath: (oldPath, newPath, newTitle) =>
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.path === oldPath ? { ...t, path: newPath, title: newTitle } : t
      ),
      activeTabPath:
        state.activeTabPath === oldPath ? newPath : state.activeTabPath,
    })),

  closeAllTabs: () => {
    const { openTabs } = get();
    const pinned = openTabs.filter((t) => t.isPinned);
    set({
      openTabs: pinned,
      activeTabPath: pinned.length > 0 ? pinned[0].path : null,
      activeContent: pinned.length > 0 ? get().activeContent : '',
      conflicts: {},
    });
  },

  // Close every tab except the specified one and pinned ones, then activate it.
  closeOtherTabs: (path) => {
    const { openTabs } = get();
    const kept = openTabs.filter((t) => t.path === path || t.isPinned);
    set({ openTabs: kept, activeTabPath: kept.length > 0 ? path : null });
  },

  // Close every tab to the right of the specified one (skip pinned).
  closeTabsToRight: (path) => {
    const { openTabs, activeTabPath } = get();
    const idx = openTabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const kept = openTabs.filter((t, i) => i <= idx || t.isPinned);
    const newActive = kept.find((t) => t.path === activeTabPath)
      ? activeTabPath
      : path;
    set({ openTabs: kept, activeTabPath: newActive });
  },

  moveTab: (fromIndex, toIndex) => {
    const { openTabs } = get();
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= openTabs.length || toIndex >= openTabs.length) return;
    const tabs = [...openTabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    set({ openTabs: tabs });
  },

  setConflict: (path, localContent) =>
    set((state) => ({
      conflicts: {
        ...state.conflicts,
        [path]: {
          path,
          localContent,
          detectedAt: Date.now(),
        },
      },
    })),

  clearConflict: (path) =>
    set((state) => {
      const conflicts = { ...state.conflicts };
      delete conflicts[path];
      return { conflicts };
    }),

  clearAllConflicts: () => set({ conflicts: {} }),

  setActiveContent: (content) => set({ activeContent: content }),

  setCursorPosition: (line, col) => set({ cursorLine: line, cursorCol: col }),

  togglePinTab: (path) =>
    set((state) => {
      const tabs = state.openTabs.map((t) =>
        t.path === path ? { ...t, isPinned: !t.isPinned } : t
      );
      // Keep pinned tabs at the front
      tabs.sort((a, b) => (a.isPinned === b.isPinned ? 0 : a.isPinned ? -1 : 1));
      return { openTabs: tabs };
    }),
    }),
    {
      name: 'oxidenote-tabs',
      // Only persist tab-related data, not transient editor state
      partialize: (state) => ({
        openTabs: state.openTabs.map((tab) => ({
          ...tab,
          isDirty: false, // Never persist dirty state
        })),
        activeTabPath: state.activeTabPath,
      }),
    },
  )
);
