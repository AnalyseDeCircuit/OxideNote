import { create } from 'zustand';

// ── Editor view mode ────────────────────────────────────────
export type EditorMode = 'edit' | 'preview' | 'split';

// ── Sidebar section (Activity Bar driven) ───────────────────
// Each section corresponds to an Activity Bar icon and sidebar content panel
export type SidebarSection =
  | 'explorer'    // File tree + bookmarks
  | 'search'      // Global search inline
  | 'backlinks'   // Backlinks + outline
  | 'chat'        // AI chat
  | 'agent'       // Agent panel
  | 'dashboard';  // Dashboard (tags, tasks, properties, etc.)

// Backward-compat alias — will be removed after full migration
export type SidePanelTab = SidebarSection;

interface UIState {
  /** Whether the sidebar (Activity Bar content area) is collapsed */
  sidebarCollapsed: boolean;
  /** Currently active sidebar section shown in the content area */
  activeSidebarSection: SidebarSection;
  settingsOpen: boolean;
  quickOpenOpen: boolean;
  globalSearchOpen: boolean;
  /** Editor mode: edit / preview / split */
  editorMode: EditorMode;
  /** Knowledge graph view overlay */
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

  // ── Sidebar actions ──────────────────────────────────────
  /** Toggle sidebar collapsed/expanded */
  toggleSidebar: () => void;
  /** Set sidebar collapsed state directly */
  setSidebarCollapsed: (v: boolean) => void;
  /** Switch to a sidebar section — expands if collapsed, collapses if same section */
  setSidebarSection: (section: SidebarSection) => void;

  // ── Backward-compat aliases (delegates to new model) ─────
  /** @deprecated Use sidebarCollapsed. Returns !sidebarCollapsed for compat */
  sidebarVisible: boolean;
  /** @deprecated Use activeSidebarSection */
  sidePanelTab: SidePanelTab;
  /** @deprecated Use sidebarCollapsed */
  sidePanelVisible: boolean;
  /** @deprecated Use toggleSidebar */
  toggleSidePanel: () => void;
  /** @deprecated Use setSidebarCollapsed(!v) */
  setSidebarVisible: (v: boolean) => void;
  /** @deprecated Use setSidebarCollapsed(!v) */
  setSidePanelVisible: (v: boolean) => void;
  /** @deprecated Use setSidebarSection */
  setSidePanelTab: (tab: SidePanelTab) => void;

  setSettingsOpen: (v: boolean) => void;
  setQuickOpenOpen: (v: boolean) => void;
  setGlobalSearchOpen: (v: boolean) => void;
  setEditorMode: (mode: EditorMode) => void;
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

export const useUIStore = create<UIState>((set, get) => ({
  // ── New unified sidebar model ─────────────────────────────
  sidebarCollapsed: false,
  activeSidebarSection: 'explorer',

  // ── Backward-compat computed properties ───────────────────
  // These mirror the old API so existing consumers keep working
  get sidebarVisible() { return !get().sidebarCollapsed; },
  get sidePanelVisible() { return !get().sidebarCollapsed; },
  get sidePanelTab() { return get().activeSidebarSection; },

  settingsOpen: false,
  quickOpenOpen: false,
  globalSearchOpen: false,
  editorMode: 'edit',
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

  // ── New sidebar actions ───────────────────────────────────
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setSidebarSection: (section) => set((s) => {
    // If clicking the same section while expanded, collapse
    if (!s.sidebarCollapsed && s.activeSidebarSection === section) {
      return { sidebarCollapsed: true };
    }
    // Otherwise expand and switch
    return { sidebarCollapsed: false, activeSidebarSection: section };
  }),

  // ── Backward-compat actions ───────────────────────────────
  toggleSidePanel: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarVisible: (v) => set({ sidebarCollapsed: !v }),
  setSidePanelVisible: (v) => set({ sidebarCollapsed: !v }),
  setSidePanelTab: (tab) => set({ activeSidebarSection: tab, sidebarCollapsed: false }),

  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setQuickOpenOpen: (v) => set({ quickOpenOpen: v }),
  setGlobalSearchOpen: (v) => set({ globalSearchOpen: v }),
  setEditorMode: (mode) => set({ editorMode: mode }),
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
