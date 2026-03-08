import { create } from 'zustand';

// ── 编辑器视图模式 ──────────────────────────────────────────
export type EditorMode = 'edit' | 'preview' | 'split';

// ── 右侧面板标签 ────────────────────────────────────────────
export type SidePanelTab = 'backlinks' | 'outline' | 'tags';

interface UIState {
  sidebarVisible: boolean;
  sidePanelVisible: boolean;
  settingsOpen: boolean;
  quickOpenOpen: boolean;
  globalSearchOpen: boolean;
  /** 编辑器模式：编辑 / 预览 / 分屏 */
  editorMode: EditorMode;
  /** 右侧面板当前标签页 */
  sidePanelTab: SidePanelTab;
  /** 知识图谱视图是否打开 */
  graphViewOpen: boolean;
  /** Vault health dialog */
  healthOpen: boolean;

  toggleSidebar: () => void;
  toggleSidePanel: () => void;
  setSidebarVisible: (v: boolean) => void;
  setSidePanelVisible: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setQuickOpenOpen: (v: boolean) => void;
  setGlobalSearchOpen: (v: boolean) => void;
  setEditorMode: (mode: EditorMode) => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  setGraphViewOpen: (v: boolean) => void;
  setHealthOpen: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarVisible: true,
  sidePanelVisible: false,
  settingsOpen: false,
  quickOpenOpen: false,
  globalSearchOpen: false,
  editorMode: 'edit',
  sidePanelTab: 'backlinks',
  graphViewOpen: false,
  healthOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleSidePanel: () => set((s) => ({ sidePanelVisible: !s.sidePanelVisible })),
  setSidebarVisible: (v) => set({ sidebarVisible: v }),
  setSidePanelVisible: (v) => set({ sidePanelVisible: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setQuickOpenOpen: (v) => set({ quickOpenOpen: v }),
  setGlobalSearchOpen: (v) => set({ globalSearchOpen: v }),
  setEditorMode: (mode) => set({ editorMode: mode }),
  setSidePanelTab: (tab) => set({ sidePanelTab: tab }),
  setGraphViewOpen: (v) => set({ graphViewOpen: v }),
  setHealthOpen: (v) => set({ healthOpen: v }),
}));
