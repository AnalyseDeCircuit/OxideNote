import { create } from 'zustand';

export interface Tab {
  path: string;
  title: string;
  isDirty: boolean;
}

interface NoteState {
  openTabs: Tab[];
  activeTabPath: string | null;

  openNote: (path: string, title: string) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  markDirty: (path: string) => void;
  markClean: (path: string) => void;
  updateTabPath: (oldPath: string, newPath: string, newTitle: string) => void;
  closeAllTabs: () => void;
}

export const useNoteStore = create<NoteState>((set, get) => ({
  openTabs: [],
  activeTabPath: null,

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

  closeAllTabs: () => set({ openTabs: [], activeTabPath: null }),
}));
