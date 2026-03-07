import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useSettingsStore, type ThemeId, type Density, type Language } from '@/store/settingsStore';
import { useUIStore } from '@/store/uiStore';
import { useTranslation } from 'react-i18next';

const THEMES: { id: ThemeId; label: string; dark: boolean }[] = [
  { id: 'neutral', label: 'Neutral', dark: true },
  { id: 'github-dark', label: 'GitHub Dark', dark: true },
  { id: 'dracula', label: 'Dracula', dark: true },
  { id: 'nord', label: 'Nord', dark: true },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', dark: true },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: true },
  { id: 'solarized-dark', label: 'Solarized Dark', dark: true },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', dark: true },
  { id: 'one-dark-pro', label: 'One Dark Pro', dark: true },
  { id: 'ayu-dark', label: 'Ayu Dark', dark: true },
  { id: 'rose-pine', label: 'Rosé Pine', dark: true },
  { id: 'kanagawa', label: 'Kanagawa', dark: true },
  { id: 'everforest-dark', label: 'Everforest Dark', dark: true },
  { id: 'material-ocean', label: 'Material Ocean', dark: true },
  { id: 'night-owl', label: 'Night Owl', dark: true },
  { id: 'github-light', label: 'GitHub Light', dark: false },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', dark: false },
  { id: 'solarized-light', label: 'Solarized Light', dark: false },
  { id: 'gruvbox-light', label: 'Gruvbox Light', dark: false },
  { id: 'ayu-light', label: 'Ayu Light', dark: false },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', dark: false },
  { id: 'everforest-light', label: 'Everforest Light', dark: false },
  { id: 'tokyo-night-light', label: 'Tokyo Night Light', dark: false },
  { id: 'one-light', label: 'One Light', dark: false },
  { id: 'flexoki-light', label: 'Flexoki Light', dark: false },
];

export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[540px] max-h-[80vh] overflow-hidden flex flex-col bg-surface border-theme-border text-foreground">
        <DialogHeader>
          <DialogTitle>{t('settings.title', '设置')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="general" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="grid grid-cols-4 bg-background rounded-lg p-1 shrink-0">
            <TabsTrigger value="general" className="text-xs data-[state=active]:bg-surface">
              {t('settings.general', '通用')}
            </TabsTrigger>
            <TabsTrigger value="editor" className="text-xs data-[state=active]:bg-surface">
              {t('settings.editor', '编辑器')}
            </TabsTrigger>
            <TabsTrigger value="appearance" className="text-xs data-[state=active]:bg-surface">
              {t('settings.appearance', '外观')}
            </TabsTrigger>
            <TabsTrigger value="about" className="text-xs data-[state=active]:bg-surface">
              {t('settings.about', '关于')}
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto mt-4">
            <TabsContent value="general" className="m-0">
              <GeneralTab />
            </TabsContent>
            <TabsContent value="editor" className="m-0">
              <EditorTab />
            </TabsContent>
            <TabsContent value="appearance" className="m-0">
              <AppearanceTab />
            </TabsContent>
            <TabsContent value="about" className="m-0">
              <AboutTab />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function GeneralTab() {
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const recentVaults = useSettingsStore((s) => s.recentVaults);
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <SettingRow label={t('settings.language')}>
        <Select value={language} onValueChange={(v) => setLanguage(v as Language)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">简体中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {recentVaults.length > 0 && (
        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">{t('settings.recentVaults')}</Label>
          <div className="space-y-1">
            {recentVaults.map((v) => (
              <div key={v} className="text-xs text-muted-foreground truncate px-2 py-1 rounded bg-background">
                {v}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EditorTab() {
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const setFontSize = useSettingsStore((s) => s.setEditorFontSize);
  const fontFamily = useSettingsStore((s) => s.editorFontFamily);
  const setFontFamily = useSettingsStore((s) => s.setEditorFontFamily);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const setTabSize = useSettingsStore((s) => s.setEditorTabSize);
  const lineHeight = useSettingsStore((s) => s.editorLineHeight);
  const setLineHeight = useSettingsStore((s) => s.setEditorLineHeight);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const setWordWrap = useSettingsStore((s) => s.setEditorWordWrap);
  const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
  const setAutoSaveDelay = useSettingsStore((s) => s.setAutoSaveDelay);
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <SettingRow label={t('settings.fontSize')}>
        <input
          type="number"
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          min={10}
          max={32}
          className="w-20 px-2 py-1 text-sm rounded border border-theme-border bg-background text-foreground outline-none focus:border-theme-accent"
        />
      </SettingRow>

      <SettingRow label={t('settings.fontFamily')}>
        <Select value={fontFamily} onValueChange={setFontFamily}>
          <SelectTrigger className="w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="'SF Mono', 'Fira Code', 'JetBrains Mono', monospace">
              SF Mono / Fira Code
            </SelectItem>
            <SelectItem value="'JetBrains Mono', monospace">JetBrains Mono</SelectItem>
            <SelectItem value="'Fira Code', monospace">Fira Code</SelectItem>
            <SelectItem value="'Cascadia Code', monospace">Cascadia Code</SelectItem>
            <SelectItem value="monospace">System Monospace</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow label={t('settings.tabSize')}>
        <Select value={String(tabSize)} onValueChange={(v) => setTabSize(Number(v))}>
          <SelectTrigger className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2</SelectItem>
            <SelectItem value="4">4</SelectItem>
            <SelectItem value="8">8</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow label={t('settings.lineHeight')}>
        <Select value={String(lineHeight)} onValueChange={(v) => setLineHeight(Number(v))}>
          <SelectTrigger className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1.4">1.4</SelectItem>
            <SelectItem value="1.5">1.5</SelectItem>
            <SelectItem value="1.6">1.6</SelectItem>
            <SelectItem value="1.8">1.8</SelectItem>
            <SelectItem value="2">2.0</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow label={t('settings.wordWrap')}>
        <button
          onClick={() => setWordWrap(!wordWrap)}
          className={`w-10 h-5 rounded-full transition-colors relative ${
            wordWrap ? 'bg-theme-accent' : 'bg-background border border-theme-border'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-full bg-white shadow absolute top-0.5 transition-transform ${
              wordWrap ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SettingRow>

      <SettingRow label={t('settings.autoSaveDelay')}>
        <Select value={String(autoSaveDelay)} onValueChange={(v) => setAutoSaveDelay(Number(v))}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="500">500ms</SelectItem>
            <SelectItem value="1000">1s</SelectItem>
            <SelectItem value="1500">1.5s</SelectItem>
            <SelectItem value="3000">3s</SelectItem>
            <SelectItem value="5000">5s</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  );
}

function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const density = useSettingsStore((s) => s.density);
  const setDensity = useSettingsStore((s) => s.setDensity);
  const { t } = useTranslation();

  const darkThemes = THEMES.filter((t) => t.dark);
  const lightThemes = THEMES.filter((t) => !t.dark);

  return (
    <div className="space-y-6">
      {/* Density */}
      <SettingRow label={t('settings.density')}>
        <Select value={density} onValueChange={(v) => setDensity(v as Density)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="compact">{t('settings.compact')}</SelectItem>
            <SelectItem value="comfortable">{t('settings.comfortable')}</SelectItem>
            <SelectItem value="spacious">{t('settings.spacious')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {/* Dark Themes */}
      <div>
        <Label className="text-sm text-muted-foreground mb-2 block">{t('settings.darkThemes')}</Label>
        <div className="grid grid-cols-3 gap-2">
          {darkThemes.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`text-left px-3 py-2 text-xs rounded border transition-colors ${
                theme === t.id
                  ? 'border-theme-accent bg-theme-accent/10 text-foreground'
                  : 'border-theme-border hover:border-muted-foreground text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Light Themes */}
      <div>
        <Label className="text-sm text-muted-foreground mb-2 block">{t('settings.lightThemes')}</Label>
        <div className="grid grid-cols-3 gap-2">
          {lightThemes.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`text-left px-3 py-2 text-xs rounded border transition-colors ${
                theme === t.id
                  ? 'border-theme-accent bg-theme-accent/10 text-foreground'
                  : 'border-theme-border hover:border-muted-foreground text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="text-center py-6">
        <h2 className="text-xl font-bold text-foreground mb-1">OxideNote</h2>
        <p className="text-sm text-muted-foreground">v0.1.0</p>
      </div>
      <div className="text-sm text-muted-foreground space-y-2">
        <p>{t('settings.aboutDescription')}</p>
        <p>{t('settings.aboutBuiltWith')}</p>
      </div>
      <div className="border-t border-theme-border pt-4 text-xs text-muted-foreground">
        <p>License: PolyForm Noncommercial 1.0.0</p>
        <p className="mt-1">Built with Tauri, React, CodeMirror, and SQLite.</p>
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm text-foreground">{label}</Label>
      {children}
    </div>
  );
}
