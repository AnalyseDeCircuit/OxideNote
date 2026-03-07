import { create } from 'zustand';

interface UIState {
  sidebarVisible: boolean;
  sidePanelVisible: boolean;
  settingsOpen: boolean;
  quickOpenOpen: boolean;
  globalSearchOpen: boolean;

  toggleSidebar: () => void;
  toggleSidePanel: () => void;
  setSidebarVisible: (v: boolean) => void;
  setSidePanelVisible: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setQuickOpenOpen: (v: boolean) => void;
  setGlobalSearchOpen: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarVisible: true,
  sidePanelVisible: false,
  settingsOpen: false,
  quickOpenOpen: false,
  globalSearchOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleSidePanel: () => set((s) => ({ sidePanelVisible: !s.sidePanelVisible })),
  setSidebarVisible: (v) => set({ sidebarVisible: v }),
  setSidePanelVisible: (v) => set({ sidePanelVisible: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setQuickOpenOpen: (v) => set({ quickOpenOpen: v }),
  setGlobalSearchOpen: (v) => set({ globalSearchOpen: v }),
}));
