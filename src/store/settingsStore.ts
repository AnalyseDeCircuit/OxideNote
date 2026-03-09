import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import i18n from '@/i18n';

export type ThemeId =
  // Oxide originals
  | 'neutral'
  | 'oxide'
  | 'azurite'
  | 'bismuth'
  | 'chromium-oxide'
  | 'cobalt'
  | 'cuprite'
  | 'hematite'
  | 'magnetite'
  | 'malachite'
  | 'ochre'
  | 'silver-oxide'
  | 'verdigris'
  // Classic dark
  | 'github-dark'
  | 'dracula'
  | 'nord'
  | 'catppuccin-mocha'
  | 'tokyo-night'
  | 'solarized-dark'
  | 'gruvbox-dark'
  | 'one-dark'
  | 'monokai'
  | 'rose-pine'
  | 'kanagawa'
  | 'synthwave-84'
  | 'fairy-floss'
  | 'sakura'
  // Light
  | 'paper-oxide'
  | 'github-light'
  | 'catppuccin-latte'
  | 'solarized-light'
  | 'gruvbox-light'
  | 'rose-pine-dawn'
  | 'hot-pink'
  | 'spring-green';

export type Density = 'compact' | 'comfortable' | 'spacious';
export type Language = 'zh-CN' | 'en';
export type SortMode = 'name' | 'modified';

// ── Keybinding types ────────────────────────────────────────

export type ActionId =
  | 'quickOpen'
  | 'commandPalette'
  | 'globalSearch'
  | 'settings'
  | 'toggleSidebar'
  | 'toggleSidePanel'
  | 'closeTab'
  | 'prevTab'
  | 'nextTab'
  | 'newNote'
  | 'toggleFocusMode'
  | 'toggleChat';

export interface KeyBinding {
  action: ActionId;
  key: string; // e.g. "Mod+P", "Mod+Shift+F"
}

// Default keybindings — Mod = Cmd on Mac, Ctrl on Win/Linux
export const DEFAULT_KEYBINDINGS: Record<ActionId, string> = {
  quickOpen: 'Mod+P',
  commandPalette: 'Mod+K',
  globalSearch: 'Mod+Shift+F',
  settings: 'Mod+,',
  toggleSidebar: 'Mod+B',
  toggleSidePanel: 'Mod+\\',
  closeTab: 'Mod+W',
  prevTab: 'Mod+Alt+ArrowLeft',
  nextTab: 'Mod+Alt+ArrowRight',
  newNote: 'Mod+N',
  toggleFocusMode: 'Mod+Shift+Z',
  toggleChat: 'Mod+L',
};

interface TabSnapshot { path: string; title: string; }
export interface NoteTemplate { name: string; content: string; }

interface SettingsState {
  // Appearance
  theme: ThemeId;
  density: Density;
  language: Language;
  // Editor
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  editorLineHeight: number;
  autoSaveDelay: number;
  // Vault
  lastVaultPath: string | null;
  recentVaults: string[];
  // Session restore
  lastOpenTabs: TabSnapshot[];
  lastActiveTabPath: string | null;
  // Sidebar
  sortMode: SortMode;
  // Templates
  noteTemplates: NoteTemplate[];
  // Custom CSS snippet injected at runtime
  customCSS: string;
  // Custom keybindings (overrides per action)
  keybindings: Record<ActionId, string>;

  // Actions
  setTheme: (theme: ThemeId) => void;
  setDensity: (density: Density) => void;
  setLanguage: (lang: Language) => void;
  setEditorFontSize: (size: number) => void;
  setEditorFontFamily: (family: string) => void;
  setEditorTabSize: (size: number) => void;
  setEditorWordWrap: (wrap: boolean) => void;
  setEditorLineHeight: (height: number) => void;
  setAutoSaveDelay: (ms: number) => void;
  setLastVaultPath: (path: string | null) => void;
  addRecentVault: (path: string) => void;
  setSortMode: (mode: SortMode) => void;
  setNoteTemplates: (templates: NoteTemplate[]) => void;
  setCustomCSS: (css: string) => void;
  setKeybinding: (action: ActionId, key: string) => void;
  resetKeybindings: () => void;
}

const STORAGE_KEY = 'oxidenote-settings';

function loadPersistedSettings(): Partial<SettingsState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function persistSettings(state: SettingsState) {
  const data = {
    theme: state.theme,
    density: state.density,
    language: state.language,
    editorFontSize: state.editorFontSize,
    editorFontFamily: state.editorFontFamily,
    editorTabSize: state.editorTabSize,
    editorWordWrap: state.editorWordWrap,
    editorLineHeight: state.editorLineHeight,
    autoSaveDelay: state.autoSaveDelay,
    lastVaultPath: state.lastVaultPath,
    recentVaults: state.recentVaults,
    lastOpenTabs: state.lastOpenTabs,
    lastActiveTabPath: state.lastActiveTabPath,
    sortMode: state.sortMode,
    noteTemplates: state.noteTemplates,
    customCSS: state.customCSS,
    keybindings: state.keybindings,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

const persisted = loadPersistedSettings();

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector((set, _get) => ({
  theme: (persisted.theme as ThemeId) ?? 'neutral',
  density: (persisted.density as Density) ?? 'comfortable',
  language: (persisted.language as Language) ?? 'zh-CN',
  editorFontSize: persisted.editorFontSize ?? 14,
  editorFontFamily: persisted.editorFontFamily ?? "'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
  editorTabSize: persisted.editorTabSize ?? 2,
  editorWordWrap: persisted.editorWordWrap ?? true,
  editorLineHeight: persisted.editorLineHeight ?? 1.6,
  autoSaveDelay: persisted.autoSaveDelay ?? 1500,
  lastVaultPath: persisted.lastVaultPath ?? null,
  recentVaults: persisted.recentVaults ?? [],
  lastOpenTabs: persisted.lastOpenTabs ?? [],
  lastActiveTabPath: persisted.lastActiveTabPath ?? null,
  sortMode: (persisted.sortMode as SortMode) ?? 'name',
  noteTemplates: persisted.noteTemplates ?? [],
  customCSS: persisted.customCSS ?? '',
  keybindings: { ...DEFAULT_KEYBINDINGS, ...(persisted.keybindings as Partial<Record<ActionId, string>> ?? {}) },

  setTheme: (theme) => set({ theme }),
  setSortMode: (mode) => set({ sortMode: mode }),
  setNoteTemplates: (templates) => set({ noteTemplates: templates }),
  setDensity: (density) => set({ density }),
  setLanguage: (lang) => set({ language: lang }),
  setEditorFontSize: (size) => set({ editorFontSize: size }),
  setEditorFontFamily: (family) => set({ editorFontFamily: family }),
  setEditorTabSize: (size) => set({ editorTabSize: size }),
  setEditorWordWrap: (wrap) => set({ editorWordWrap: wrap }),
  setEditorLineHeight: (height) => set({ editorLineHeight: height }),
  setAutoSaveDelay: (ms) => set({ autoSaveDelay: ms }),
  setLastVaultPath: (path) => set({ lastVaultPath: path }),
  addRecentVault: (path) =>
    set((state) => {
      const filtered = state.recentVaults.filter((v) => v !== path);
      return { recentVaults: [path, ...filtered].slice(0, 10) };
    }),
  setCustomCSS: (css) => set({ customCSS: css }),
  setKeybinding: (action, key) =>
    set((state) => ({
      keybindings: { ...state.keybindings, [action]: key },
    })),
  resetKeybindings: () => set({ keybindings: { ...DEFAULT_KEYBINDINGS } }),
})));

// ─── Side-effect subscriptions ─────────────────────────────

// Theme → DOM
useSettingsStore.subscribe(
  (state) => state.theme,
  (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  },
  { fireImmediately: true },
);

// Density → DOM
useSettingsStore.subscribe(
  (state) => state.density,
  (density) => {
    document.documentElement.setAttribute('data-density', density);
  },
  { fireImmediately: true },
);

// Language → i18n
useSettingsStore.subscribe(
  (state) => state.language,
  (lang) => {
    i18n.changeLanguage(lang);
  },
  { fireImmediately: true },
);

// Any change → persist
useSettingsStore.subscribe(() => {
  persistSettings(useSettingsStore.getState());
});

// Custom CSS → inject <style> element
useSettingsStore.subscribe(
  (state) => state.customCSS,
  (css) => {
    const id = 'oxidenote-custom-css';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = css;
  },
  { fireImmediately: true },
);

// ─── Sync tab state from noteStore → settingsStore for persistence ──
// Import lazily to avoid circular dependency
let _noteStoreSubscribed = false;
export function initTabSync() {
  if (_noteStoreSubscribed) return;
  _noteStoreSubscribed = true;
  import('./noteStore').then(({ useNoteStore }) => {
    let prevTabs = useNoteStore.getState().openTabs;
    let prevActive = useNoteStore.getState().activeTabPath;
    useNoteStore.subscribe((state) => {
      if (state.openTabs !== prevTabs || state.activeTabPath !== prevActive) {
        prevTabs = state.openTabs;
        prevActive = state.activeTabPath;
        useSettingsStore.setState({
          lastOpenTabs: state.openTabs.map((t) => ({ path: t.path, title: t.title })),
          lastActiveTabPath: state.activeTabPath,
        });
      }
    });
  });
}
