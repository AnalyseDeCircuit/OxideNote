import { useState } from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Monitor, Type, Palette, Info, FolderOpen, FolderSync, Plus, Trash2, ShieldCheck } from 'lucide-react';
import { useSettingsStore, type ThemeId, type Density, type Language, type NoteTemplate } from '@/store/settingsStore';
import { useUIStore } from '@/store/uiStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useNoteStore, flushAllPendingSaves } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { openVault, listTree } from '@/lib/api';
import { toast } from '@/hooks/useToast';

interface ThemeDef {
  id: ThemeId;
  label: string;
  group: 'oxide' | 'classic' | 'light';
  colors: { bg: string; panel: string; accent: string };
}

const THEMES: ThemeDef[] = [
  // Oxide originals
  { id: 'neutral', label: 'Neutral', group: 'oxide', colors: { bg: '#09090b', panel: '#18181b', accent: '#ea580c' } },
  { id: 'oxide', label: 'Oxide', group: 'oxide', colors: { bg: '#331a0d', panel: '#4a2613', accent: '#FF6B00' } },
  { id: 'azurite', label: 'Azurite', group: 'oxide', colors: { bg: '#091A2E', panel: '#0D2238', accent: '#0066CC' } },
  { id: 'bismuth', label: 'Bismuth', group: 'oxide', colors: { bg: '#120F1D', panel: '#2E1065', accent: '#D946EF' } },
  { id: 'chromium-oxide', label: 'Chromium', group: 'oxide', colors: { bg: '#0e1a12', panel: '#16261b', accent: '#00ff41' } },
  { id: 'cobalt', label: 'Cobalt', group: 'oxide', colors: { bg: '#0F172A', panel: '#1E293B', accent: '#3B82F6' } },
  { id: 'cuprite', label: 'Cuprite', group: 'oxide', colors: { bg: '#221212', panel: '#331a1a', accent: '#ff4d4d' } },
  { id: 'hematite', label: 'Hematite', group: 'oxide', colors: { bg: '#1C1C1E', panel: '#2C2C2E', accent: '#FF3B30' } },
  { id: 'magnetite', label: 'Magnetite', group: 'oxide', colors: { bg: '#1A1A1A', panel: '#262626', accent: '#4682B4' } },
  { id: 'malachite', label: 'Malachite', group: 'oxide', colors: { bg: '#0B231A', panel: '#064E3B', accent: '#10B981' } },
  { id: 'ochre', label: 'Ochre', group: 'oxide', colors: { bg: '#1C1917', panel: '#292524', accent: '#EA580C' } },
  { id: 'silver-oxide', label: 'Silver Oxide', group: 'oxide', colors: { bg: '#1c1c1c', panel: '#2a2a2a', accent: '#9b88ff' } },
  { id: 'verdigris', label: 'Verdigris', group: 'oxide', colors: { bg: '#1C312C', panel: '#223D37', accent: '#00FFFF' } },
  // Classic dark
  { id: 'github-dark', label: 'GitHub Dark', group: 'classic', colors: { bg: '#0d1117', panel: '#161b22', accent: '#58a6ff' } },
  { id: 'dracula', label: 'Dracula', group: 'classic', colors: { bg: '#282a36', panel: '#21222c', accent: '#bd93f9' } },
  { id: 'nord', label: 'Nord', group: 'classic', colors: { bg: '#2e3440', panel: '#3b4252', accent: '#88c0d0' } },
  { id: 'catppuccin-mocha', label: 'Catppuccin', group: 'classic', colors: { bg: '#1e1e2e', panel: '#181825', accent: '#89b4fa' } },
  { id: 'tokyo-night', label: 'Tokyo Night', group: 'classic', colors: { bg: '#1a1b26', panel: '#16161e', accent: '#7aa2f7' } },
  { id: 'solarized-dark', label: 'Solarized', group: 'classic', colors: { bg: '#002b36', panel: '#073642', accent: '#2aa198' } },
  { id: 'gruvbox-dark', label: 'Gruvbox', group: 'classic', colors: { bg: '#282828', panel: '#1d2021', accent: '#d79921' } },
  { id: 'one-dark', label: 'One Dark', group: 'classic', colors: { bg: '#282c34', panel: '#21252b', accent: '#61afef' } },
  { id: 'monokai', label: 'Monokai', group: 'classic', colors: { bg: '#272822', panel: '#1e1f1c', accent: '#a6e22e' } },
  { id: 'rose-pine', label: 'Rosé Pine', group: 'classic', colors: { bg: '#191724', panel: '#1f1d2e', accent: '#c4a7e7' } },
  { id: 'kanagawa', label: 'Kanagawa', group: 'classic', colors: { bg: '#1F1F28', panel: '#16161D', accent: '#7E9CD8' } },
  { id: 'synthwave-84', label: 'Synthwave', group: 'classic', colors: { bg: '#2b213a', panel: '#241b30', accent: '#ff7edb' } },
  { id: 'fairy-floss', label: 'Fairy Floss', group: 'classic', colors: { bg: '#5a5475', panel: '#463c57', accent: '#ff857f' } },
  { id: 'sakura', label: 'Sakura', group: 'classic', colors: { bg: '#2c242a', panel: '#3f3238', accent: '#ff79c6' } },
  // Light
  { id: 'paper-oxide', label: 'Paper Oxide', group: 'light', colors: { bg: '#f4f0e6', panel: '#ece8dd', accent: '#8d6e63' } },
  { id: 'github-light', label: 'GitHub Light', group: 'light', colors: { bg: '#ffffff', panel: '#f6f8fa', accent: '#0969da' } },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', group: 'light', colors: { bg: '#eff1f5', panel: '#e6e9ef', accent: '#1e66f5' } },
  { id: 'solarized-light', label: 'Solarized Light', group: 'light', colors: { bg: '#fdf6e3', panel: '#eee8d5', accent: '#268bd2' } },
  { id: 'gruvbox-light', label: 'Gruvbox Light', group: 'light', colors: { bg: '#fbf1c7', panel: '#f2e5bc', accent: '#d65d0e' } },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', group: 'light', colors: { bg: '#faf4ed', panel: '#fffaf3', accent: '#907aa9' } },
  { id: 'hot-pink', label: 'Hot Pink', group: 'light', colors: { bg: '#efdfe5', panel: '#fcebf1', accent: '#e60073' } },
  { id: 'spring-green', label: 'Spring Green', group: 'light', colors: { bg: '#e2f5e9', panel: '#d1efdb', accent: '#16a34a' } },
];

const SIDEBAR_TABS = [
  { id: 'general', icon: Monitor },
  { id: 'editor', icon: Type },
  { id: 'appearance', icon: Palette },
  { id: 'about', icon: Info },
] as const;

type TabId = (typeof SIDEBAR_TABS)[number]['id'];

function ThemeSwatch({ theme: t, active, onClick }: { theme: ThemeDef; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-xs transition-all ${
        active
          ? 'border-theme-accent bg-theme-accent/10 text-foreground ring-1 ring-theme-accent/30'
          : 'border-theme-border hover:border-theme-accent/50 text-muted-foreground hover:text-foreground'
      }`}
    >
      <div className="flex gap-0.5 shrink-0">
        <div className="w-3 h-6 rounded-l-sm" style={{ backgroundColor: t.colors.bg }} />
        <div className="w-3 h-6" style={{ backgroundColor: t.colors.panel }} />
        <div className="w-3 h-6 rounded-r-sm" style={{ backgroundColor: t.colors.accent }} />
      </div>
      <span className="truncate">{t.label}</span>
    </button>
  );
}

function SettingsCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-bg-panel/50 p-5">
      {title && (
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-4">
          {title}
        </h3>
      )}
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label className="text-sm text-foreground">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<TabId>('general');
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[780px] h-[600px] overflow-hidden flex p-0 gap-0 bg-surface border-theme-border text-foreground">
        {/* Sidebar */}
        <div className="w-48 shrink-0 border-r border-theme-border bg-background p-4 flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground px-3 mb-3">{t('settings.title', '设置')}</h2>
          {SIDEBAR_TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                tab === id
                  ? 'bg-theme-accent/15 text-theme-accent font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-theme-bg-hover'
              }`}
            >
              <Icon size={16} />
              {t(`settings.${id}`)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl space-y-5">
            {tab === 'general' && <GeneralTab />}
            {tab === 'editor' && <EditorTab />}
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GeneralTab() {
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const recentVaults = useSettingsStore((s) => s.recentVaults);
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);
  const { t } = useTranslation();

  const switchVaultSafely = async (path: string) => {
    const outcomes = await flushAllPendingSaves();
    const hasConflicts =
      Object.values(outcomes).some((outcome) => outcome === 'conflict') ||
      Object.keys(useNoteStore.getState().conflicts).length > 0;

    if (hasConflicts) {
      const firstConflictPath = Object.keys(useNoteStore.getState().conflicts)[0];
      if (firstConflictPath) {
        useNoteStore.getState().setActiveTab(firstConflictPath);
      }
      useUIStore.getState().setSettingsOpen(false);
      toast({
        title: t('conflict.resolveBeforeSwitchVaultTitle'),
        description: t('conflict.resolveBeforeSwitchVaultMessage'),
        variant: 'warning',
      });
      return;
    }

    await openVault(path);
    const tree = await listTree('', useSettingsStore.getState().sortMode);
    useNoteStore.getState().closeAllTabs();
    useNoteStore.getState().clearAllConflicts();
    useWorkspaceStore.getState().setVaultPath(path);
    useWorkspaceStore.getState().setTree(tree);
    useSettingsStore.getState().setLastVaultPath(path);
    useSettingsStore.getState().addRecentVault(path);
    useUIStore.getState().setSettingsOpen(false);
  };

  const handleSwitchVault = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      try {
        await switchVaultSafely(selected);
      } catch (err) {
        toast({ title: t('actions.switchVaultFailed'), description: String(err), variant: 'error' });
      }
    }
  };

  const handleSelectRecentVault = async (path: string) => {
    try {
      await switchVaultSafely(path);
    } catch (err) {
      toast({ title: t('actions.openVaultFailed'), description: String(err), variant: 'error' });
    }
  };

  return (
    <>
      <SettingsCard title={t('settings.vault', '仓库')}>
        {vaultPath && (
          <div className="flex items-center gap-2 mb-3">
            <FolderOpen size={14} className="text-theme-accent shrink-0" />
            <span className="text-sm text-foreground truncate">{vaultPath}</span>
          </div>
        )}
        <button
          onClick={handleSwitchVault}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-theme-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <FolderSync size={16} />
          {t('settings.switchVault', '切换仓库')}
        </button>
        <button
          onClick={() => {
            useUIStore.getState().setSettingsOpen(false);
            useUIStore.getState().setHealthOpen(true);
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-md border border-theme-border text-sm font-medium text-foreground hover:bg-theme-bg-hover transition-colors mt-2"
        >
          <ShieldCheck size={16} />
          {t('settings.vaultHealth')}
        </button>
      </SettingsCard>

      <SettingsCard title={t('settings.language', '语言')}>
        <SettingRow label={t('settings.language')} hint={t('settings.languageHint', '界面显示语言')}>
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
      </SettingsCard>

      {recentVaults.length > 0 && (
        <SettingsCard title={t('settings.recentVaults', '最近的仓库')}>
          <div className="space-y-1">
            {recentVaults.map((v) => (
              <button
                key={v}
                onClick={() => handleSelectRecentVault(v)}
                className="w-full text-left text-xs text-muted-foreground truncate px-3 py-2 rounded-md bg-background hover:bg-theme-bg-hover transition-colors"
              >
                {v}
              </button>
            ))}
          </div>
        </SettingsCard>
      )}
    </>
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
    <>
      {/* Font preview */}
      <SettingsCard title={t('settings.fontPreview', '字体预览')}>
        <div
          className="rounded-md bg-background border border-theme-border p-4 text-muted-foreground whitespace-pre-wrap"
          style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight }}
        >
          {'# Hello, OxideNote\nThe quick brown fox jumps over the lazy dog.\n等灵时代的狐狸跳过了那条懒狗。\n```const x = 42;```'}
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.fontFamily', '字体')}>
        <SettingRow label={t('settings.fontFamily')} hint={t('settings.fontFamilyHint', '输入系统已安装的字体名，多个用逗号分隔')}>
          <input
            type="text"
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            placeholder="monospace"
            className="w-[260px] px-3 py-1.5 text-sm rounded border border-theme-border bg-background text-foreground outline-none focus:border-theme-accent"
          />
        </SettingRow>

        <SettingRow label={t('settings.fontSize')} hint={t('settings.fontSizeHint', '10 ~ 32px')}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={10}
              max={32}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-24 accent-theme-accent"
            />
            <input
              type="number"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              min={10}
              max={32}
              className="w-16 px-2 py-1 text-sm text-center rounded border border-theme-border bg-background text-foreground outline-none focus:border-theme-accent"
            />
          </div>
        </SettingRow>

        <SettingRow label={t('settings.lineHeight')} hint={t('settings.lineHeightHint', '行间距倍率')}>
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
      </SettingsCard>

      <SettingsCard title={t('settings.editing', '编辑')}>
        <SettingRow label={t('settings.tabSize')} hint={t('settings.tabSizeHint', '缩进空格数')}>
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

        <SettingRow label={t('settings.wordWrap')} hint={t('settings.wordWrapHint', '超出编辑器宽度时自动换行')}>
          <button
            onClick={() => setWordWrap(!wordWrap)}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              wordWrap ? 'bg-theme-accent' : 'bg-background border border-theme-border'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white shadow absolute top-0.5 transition-transform ${
                wordWrap ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SettingRow>

        <SettingRow label={t('settings.autoSaveDelay')} hint={t('settings.autoSaveDelayHint', '停止输入后自动保存')}>
          <Select value={String(autoSaveDelay)} onValueChange={(v) => setAutoSaveDelay(Number(v))}>
            <SelectTrigger className="w-[120px]">
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
      </SettingsCard>

      <TemplatesSection />
    </>
  );
}

function TemplatesSection() {
  const templates = useSettingsStore((s) => s.noteTemplates);
  const setTemplates = useSettingsStore((s) => s.setNoteTemplates);
  const { t } = useTranslation();

  const addTemplate = () => {
    setTemplates([...templates, {
      name: t('settings.newTemplate', '新模板'),
      content: '---\ntitle: {{title}}\ncreated: {{datetime}}\n---\n\n',
    }]);
  };

  const removeTemplate = (index: number) => {
    setTemplates(templates.filter((_, i) => i !== index));
  };

  const updateTemplate = (index: number, field: keyof NoteTemplate, value: string) => {
    const updated = templates.map((tmpl, i) =>
      i === index ? { ...tmpl, [field]: value } : tmpl
    );
    setTemplates(updated);
  };

  return (
    <SettingsCard title={t('settings.templates', '笔记模板')}>
      <p className="text-xs text-muted-foreground mb-3">
        {t('settings.templatesHint', '创建笔记时可选用模板。支持变量: {{title}}, {{date}}, {{datetime}}')}
      </p>
      <div className="space-y-3">
        {templates.map((tmpl, i) => (
          <div key={i} className="border border-theme-border rounded-md p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={tmpl.name}
                onChange={(e) => updateTemplate(i, 'name', e.target.value)}
                className="flex-1 px-2 py-1 text-sm rounded border border-theme-border bg-background text-foreground outline-none focus:border-theme-accent"
                placeholder={t('settings.templateName', '模板名称')}
              />
              <button
                onClick={() => removeTemplate(i)}
                className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                aria-label={t('actions.close')}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <textarea
              value={tmpl.content}
              onChange={(e) => updateTemplate(i, 'content', e.target.value)}
              className="w-full h-24 px-2 py-1.5 text-xs font-mono rounded border border-theme-border bg-background text-foreground outline-none focus:border-theme-accent resize-y"
              placeholder="---\ntitle: {{title}}\n---"
            />
          </div>
        ))}
      </div>
      <button
        onClick={addTemplate}
        className="flex items-center gap-1.5 mt-2 text-xs text-theme-accent hover:text-theme-accent/80 transition-colors"
      >
        <Plus size={14} />
        {t('settings.addTemplate', '添加模板')}
      </button>
    </SettingsCard>
  );
}

function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const density = useSettingsStore((s) => s.density);
  const setDensity = useSettingsStore((s) => s.setDensity);
  const { t } = useTranslation();

  const oxideThemes = THEMES.filter((t) => t.group === 'oxide');
  const classicThemes = THEMES.filter((t) => t.group === 'classic');
  const lightThemes = THEMES.filter((t) => t.group === 'light');

  return (
    <>
      <SettingsCard title={t('settings.themeSection', '主题')}>
        <div>
          <Label className="text-xs text-muted-foreground mb-2 block">
            {t('settings.oxideThemes', 'Oxide 系列')}
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {oxideThemes.map((th) => (
              <ThemeSwatch key={th.id} theme={th} active={theme === th.id} onClick={() => setTheme(th.id)} />
            ))}
          </div>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-2 block">
            {t('settings.classicThemes', '经典深色')}
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {classicThemes.map((th) => (
              <ThemeSwatch key={th.id} theme={th} active={theme === th.id} onClick={() => setTheme(th.id)} />
            ))}
          </div>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-2 block">
            {t('settings.lightThemes', '浅色')}
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {lightThemes.map((th) => (
              <ThemeSwatch key={th.id} theme={th} active={theme === th.id} onClick={() => setTheme(th.id)} />
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.layoutSection', '布局')}>
        <SettingRow label={t('settings.density')} hint={t('settings.densityHint', '调整界面间距密度')}>
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
      </SettingsCard>
    </>
  );
}

function AboutTab() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsCard>
        <div className="text-center py-4">
          <h2 className="text-2xl font-bold text-foreground mb-1">OxideNote</h2>
          <p className="text-sm text-muted-foreground">v0.1.0</p>
          <p className="text-xs text-muted-foreground mt-1">PolyForm Noncommercial 1.0.0</p>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.techStack', '技术栈')}>
        <div className="flex flex-wrap gap-2">
          {['Tauri 2', 'React 19', 'TypeScript', 'CodeMirror 6', 'SQLite FTS5', 'Zustand'].map((tech) => (
            <span
              key={tech}
              className="px-2.5 py-1 text-xs rounded-full bg-background border border-theme-border text-muted-foreground"
            >
              {tech}
            </span>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.shortcuts', '快捷键')}>
        <div className="grid grid-cols-2 gap-y-2 gap-x-6 text-xs">
          {[
            [t('settings.shortcutQuickOpen', '快速打开'), '⌘ P'],
            [t('settings.shortcutGlobalSearch', '全局搜索'), '⌘ ⇧ F'],
            [t('settings.shortcutSettings', '设置'), '⌘ ,'],
            [t('settings.shortcutNewNote', '新建笔记'), '⌘ N'],
            [t('settings.shortcutSidebar', '切换侧栏'), '⌘ B'],
            [t('settings.shortcutSave', '保存'), '⌘ S'],
          ].map(([label, key]) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-muted-foreground">{label}</span>
              <kbd className="px-1.5 py-0.5 rounded bg-background border border-theme-border text-foreground font-mono text-[10px]">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </SettingsCard>

      <div className="text-sm text-muted-foreground space-y-2">
        <p>{t('settings.aboutDescription')}</p>
        <p>{t('settings.aboutBuiltWith')}</p>
      </div>
    </>
  );
}
