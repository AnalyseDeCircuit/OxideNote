import { create } from 'zustand';

// ── 编辑器视图模式 ──────────────────────────────────────────
export type EditorMode = 'edit' | 'preview' | 'split';

// ── 右侧面板标签 ────────────────────────────────────────────
export type SidePanelTab = 'backlinks' | 'outline' | 'tags' | 'tasks' | 'properties' | 'history' | 'chat' | 'dashboard' | 'agent';

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
  /** Flashcard review overlay */
  flashcardOpen: boolean;
  /** Video panel visibility */
  videoPanelOpen: boolean;
  /** Browser panel visibility */
  browserPanelOpen: boolean;
  /** Command palette visibility */
  commandPaletteOpen: boolean;
  /** Zen/focus mode — hides all chrome */
  focusMode: boolean;
  /** Presentation/slide mode */
  presentationMode: boolean;
  /** Current slide index (0-based) */
  currentSlide: number;
  /** Card flow overlay */
  cardFlowOpen: boolean;
  diagramEditorOpen: boolean;

  // ── Compilation & AI status (shown in StatusBar) ─────────
  /** Current compile status: null (idle), 'compiling', 'success', 'error' */
  compileStatus: 'compiling' | 'success' | 'error' | null;
  compileTimeMs: number | null;
  /** Whether an inline AI transform is in progress */
  aiGenerating: boolean;

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
  setFlashcardOpen: (v: boolean) => void;
  setVideoPanelOpen: (v: boolean) => void;
  setBrowserPanelOpen: (v: boolean) => void;
  setCommandPaletteOpen: (v: boolean) => void;
  setFocusMode: (v: boolean) => void;
  toggleFocusMode: () => void;
  setPresentationMode: (v: boolean) => void;
  setCurrentSlide: (n: number) => void;
  setCardFlowOpen: (v: boolean) => void;
  setDiagramEditorOpen: (v: boolean) => void;
  setCompileStatus: (status: 'compiling' | 'success' | 'error' | null, timeMs?: number | null) => void;
  setAiGenerating: (v: boolean) => void;
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
  flashcardOpen: false,
  videoPanelOpen: false,
  browserPanelOpen: false,
  commandPaletteOpen: false,
  focusMode: false,
  presentationMode: false,
  currentSlide: 0,
  cardFlowOpen: false,
  diagramEditorOpen: false,
  compileStatus: null,
  compileTimeMs: null,
  aiGenerating: false,

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
  setFlashcardOpen: (v) => set({ flashcardOpen: v }),
  setVideoPanelOpen: (v) => set({ videoPanelOpen: v }),
  setBrowserPanelOpen: (v) => set({ browserPanelOpen: v }),
  setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
  setFocusMode: (v) => set({ focusMode: v }),
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  setPresentationMode: (v) => set(v ? { presentationMode: true, currentSlide: 0 } : { presentationMode: false }),
  setCurrentSlide: (n) => set({ currentSlide: n }),
  setCardFlowOpen: (v) => set({ cardFlowOpen: v }),
  setDiagramEditorOpen: (v) => set({ diagramEditorOpen: v }),
  setCompileStatus: (status, timeMs) => set({ compileStatus: status, compileTimeMs: timeMs ?? null }),
  setAiGenerating: (v) => set({ aiGenerating: v }),
}));
