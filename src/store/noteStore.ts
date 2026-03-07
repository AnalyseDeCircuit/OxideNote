import { create } from 'zustand';

export interface Tab {
  path: string;
  title: string;
  isDirty: boolean;
}

interface NoteState {
  openTabs: Tab[];
  activeTabPath: string | null;
  /** Current editor content for the active tab (used by OutlinePanel etc.) */
  activeContent: string;
  /** Cursor position in the active editor */
  cursorLine: number;
  cursorCol: number;

  openNote: (path: string, title: string) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  markDirty: (path: string) => void;
  markClean: (path: string) => void;
  updateTabPath: (oldPath: string, newPath: string, newTitle: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (path: string) => void;
  setActiveContent: (content: string) => void;
  setCursorPosition: (line: number, col: number) => void;
}

export const useNoteStore = create<NoteState>((set, get) => ({
  openTabs: [],
  activeTabPath: null,
  activeContent: '',
  cursorLine: 1,
  cursorCol: 1,

  openNote: (path, title) => {
    const { openTabs } = get();
    const existing = openTabs.find((t) => t.path === path);
    if (existing) {
      set({ activeTabPath: path });
    } else {
      set({
        openTabs: [...openTabs, { path, title, isDirty: false }],
        activeTabPath: path,
      });
    }
  },

  closeTab: (path) => {
    const { openTabs, activeTabPath } = get();
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

    set({ openTabs: filtered, activeTabPath: newActive });
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

  closeAllTabs: () => set({ openTabs: [], activeTabPath: null, activeContent: '' }),

  // Close every tab except the specified one, then activate it.
  closeOtherTabs: (path) => {
    const { openTabs } = get();
    const kept = openTabs.filter((t) => t.path === path);
    set({ openTabs: kept, activeTabPath: kept.length > 0 ? path : null });
  },

  setActiveContent: (content) => set({ activeContent: content }),

  setCursorPosition: (line, col) => set({ cursorLine: line, cursorCol: col }),
}));
