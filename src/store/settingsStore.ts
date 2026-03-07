import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import i18n from '@/i18n';

export type ThemeId =
  | 'neutral'
  | 'github-dark'
  | 'dracula'
  | 'nord'
  | 'catppuccin-mocha'
  | 'tokyo-night'
  | 'solarized-dark'
  | 'gruvbox-dark'
  | 'one-dark-pro'
  | 'ayu-dark'
  | 'rose-pine'
  | 'kanagawa'
  | 'everforest-dark'
  | 'material-ocean'
  | 'night-owl'
  | 'github-light'
  | 'catppuccin-latte'
  | 'solarized-light'
  | 'gruvbox-light'
  | 'ayu-light'
  | 'rose-pine-dawn'
  | 'everforest-light'
  | 'tokyo-night-light'
  | 'one-light'
  | 'flexoki-light';

export type Density = 'compact' | 'comfortable' | 'spacious';
export type Language = 'zh-CN' | 'en';

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

  setTheme: (theme) => set({ theme }),
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
