import { useEffect, useRef } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { listen } from '@tauri-apps/api/event';
import {
  Sparkles, Search, Link2, Settings, MoreHorizontal,
  Share2, Layers, Monitor, Video, Globe,
  AlignLeft, Tag, CheckSquare, FileText, Clock,
  PanelLeft,
} from 'lucide-react';
import { useUIStore, type EditorMode, type SidePanelTab } from '@/store/uiStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { VaultTree } from '@/components/tree/VaultTree';
import { BookmarkList } from '@/components/tree/BookmarkList';
import { TabBar } from '@/components/editor/TabBar';
import { NoteEditor } from '@/components/editor/NoteEditor';
import { StatusBar } from '@/components/editor/StatusBar';
import { BacklinksPanel } from '@/components/editor/BacklinksPanel';
import { OutlinePanel } from '@/components/editor/OutlinePanel';
import { TagPanel } from '@/components/editor/TagPanel';
import { TaskPanel } from '@/components/editor/TaskPanel';
import { PropertiesPanel } from '@/components/editor/PropertiesPanel';
import { HistoryPanel } from '@/components/editor/HistoryPanel';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { GraphView } from '@/components/graph/GraphView';
import { FlashcardView } from '@/components/flashcard/FlashcardView';
import { VideoPanel } from '@/components/video/VideoPanel';
import { BrowserPanel } from '@/components/browser/BrowserPanel';
import { PresentationView } from '@/components/presentation/PresentationView';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { listTree } from '@/lib/api';
import { initPreviewCacheInvalidation } from '@/lib/previewCache';
import { useTranslation } from 'react-i18next';

export function AppShell() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const sidePanelVisible = useUIStore((s) => s.sidePanelVisible);
  const sidePanelTab = useUIStore((s) => s.sidePanelTab);
  const graphViewOpen = useUIStore((s) => s.graphViewOpen);
  const flashcardOpen = useUIStore((s) => s.flashcardOpen);
  const videoPanelOpen = useUIStore((s) => s.videoPanelOpen);
  const browserPanelOpen = useUIStore((s) => s.browserPanelOpen);
  const presentationMode = useUIStore((s) => s.presentationMode);
  const focusMode = useUIStore((s) => s.focusMode);

  // Listen for file system changes from the Rust watcher
  // Watcher 事件频繁（每次自动保存都触发），对 tree 刷新做 500ms debounce
  // 避免大仓库下每次保存都执行完整的文件系统遍历
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unlisten = listen('vault:file-changed', async () => {
      if (treeRefreshTimerRef.current) clearTimeout(treeRefreshTimerRef.current);
      treeRefreshTimerRef.current = setTimeout(async () => {
        treeRefreshTimerRef.current = null;
        try {
          const tree = await listTree('', useSettingsStore.getState().sortMode);
          useWorkspaceStore.getState().setTree(tree);
        } catch {
          // Vault may have been removed
        }
      }, 500);
    });

    return () => {
      if (treeRefreshTimerRef.current) clearTimeout(treeRefreshTimerRef.current);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Initialize preview cache invalidation listener
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    initPreviewCacheInvalidation().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, []);

  // Listen for index-ready event (after background vault scan completes)
  useEffect(() => {
    const unlisten = listen('vault:index-ready', async () => {
      try {
        const tree = await listTree('', useSettingsStore.getState().sortMode);
        useWorkspaceStore.getState().setTree(tree);
      } catch {
        // ignore
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Exit focus mode with Escape
  useEffect(() => {
    if (!focusMode) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        useUIStore.getState().setFocusMode(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [focusMode]);

  // Focus mode: only show the editor, no chrome
  if (focusMode) {
    return (
      <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
        <div className="flex-1 min-h-0">
          <NoteEditor />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <Titlebar />
      <div className="flex-1 min-h-0">
        <Group orientation="horizontal" id="oxidenote-layout">
          {sidebarVisible && (
            <>
              <Panel
                id="sidebar"
                defaultSize="22%"
                minSize="15%"
                maxSize="35%"
                className="bg-surface"
              >
                <BookmarkList />
                <VaultTree />
              </Panel>
              <Separator className="w-px bg-theme-border hover:bg-theme-accent transition-colors" />
            </>
          )}
          <Panel id="editor" minSize="30%" className="bg-background">
            <div className="h-full flex flex-col">
              <TabBar />
              <div className="flex-1 min-h-0">
                <NoteEditor />
              </div>
              <StatusBar />
            </div>
          </Panel>
          {sidePanelVisible && (
            <>
              <Separator className="w-px bg-theme-border hover:bg-theme-accent transition-colors" />
              <Panel
                id="side-panel"
                defaultSize="20%"
                minSize="12%"
                maxSize="30%"
                className="bg-surface"
              >
                <SidePanelTabs activeTab={sidePanelTab} />
              </Panel>
            </>
          )}
          {videoPanelOpen && (
            <>
              <Separator className="w-px bg-theme-border hover:bg-theme-accent transition-colors" />
              <Panel
                id="video-panel"
                defaultSize="30%"
                minSize="20%"
                maxSize="50%"
                className="bg-surface"
              >
                <VideoPanel onClose={() => useUIStore.getState().setVideoPanelOpen(false)} />
              </Panel>
            </>
          )}
          {browserPanelOpen && !videoPanelOpen && (
            <>
              <Separator className="w-px bg-theme-border hover:bg-theme-accent transition-colors" />
              <Panel
                id="browser-panel"
                defaultSize="25%"
                minSize="15%"
                maxSize="40%"
                className="bg-surface"
              >
                <BrowserPanel onClose={() => useUIStore.getState().setBrowserPanelOpen(false)} />
              </Panel>
            </>
          )}
        </Group>
      </div>

      {/* ── 知识图谱全屏覆盖层 ──────────────────────────── */}
      {graphViewOpen && <GraphView />}

      {/* ── 闪卡复习全屏覆盖层 ──────────────────────────── */}
      {flashcardOpen && <FlashcardView onClose={() => useUIStore.getState().setFlashcardOpen(false)} />}

      {/* ── 演示模式全屏覆盖层 ──────────────────────────── */}
      {presentationMode && <PresentationView onClose={() => useUIStore.getState().setPresentationMode(false)} />}
    </div>
  );
}

// ── Right-side panel icon-tab strip ─────────────────────────
// Compact icon tabs with tooltips — ordered by usage frequency

/** Side panel tab metadata: icon, label key, and tab id */
const SIDE_PANEL_TABS: { id: SidePanelTab; icon: React.ReactNode; labelKey: string }[] = [
  { id: 'outline',    icon: <AlignLeft size={15} />,    labelKey: 'outline.title' },
  { id: 'chat',       icon: <Sparkles size={15} />,     labelKey: 'chat.title' },
  { id: 'backlinks',  icon: <Link2 size={15} />,        labelKey: 'backlinks.title' },
  { id: 'tags',       icon: <Tag size={15} />,          labelKey: 'tags.title' },
  { id: 'properties', icon: <FileText size={15} />,     labelKey: 'properties.title' },
  { id: 'history',    icon: <Clock size={15} />,        labelKey: 'history.title' },
  { id: 'tasks',      icon: <CheckSquare size={15} />,  labelKey: 'tasks.title' },
];

function SidePanelTabs({ activeTab }: { activeTab: SidePanelTab }) {
  const { t } = useTranslation();
  const setSidePanelTab = useUIStore((s) => s.setSidePanelTab);

  return (
    <div className="h-full flex flex-col">
      {/* Icon tab strip */}
      <div className="flex items-center border-b border-theme-border shrink-0 px-1">
        {SIDE_PANEL_TABS.map(({ id, icon, labelKey }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                className={`p-2 rounded-md transition-colors ${
                  activeTab === id
                    ? 'text-theme-accent'
                    : 'text-muted-foreground hover:text-foreground hover:bg-theme-hover'
                }`}
                onClick={() => setSidePanelTab(id)}
                aria-label={t(labelKey)}
              >
                {icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t(labelKey)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {/* Active tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'outline' && <OutlinePanel />}
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'backlinks' && <BacklinksPanel />}
        {activeTab === 'tags' && <TagPanel />}
        {activeTab === 'properties' && <PropertiesPanel />}
        {activeTab === 'history' && <HistoryPanel />}
        {activeTab === 'tasks' && <TaskPanel onClose={() => useUIStore.getState().toggleSidePanel()} />}
      </div>
    </div>
  );
}

function Titlebar() {
  const { t } = useTranslation();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const editorMode = useUIStore((s) => s.editorMode);
  const setEditorMode = useUIStore((s) => s.setEditorMode);
  const setGlobalSearchOpen = useUIStore((s) => s.setGlobalSearchOpen);
  const setGraphViewOpen = useUIStore((s) => s.setGraphViewOpen);
  const setFlashcardOpen = useUIStore((s) => s.setFlashcardOpen);
  const setPresentationMode = useUIStore((s) => s.setPresentationMode);
  const setVideoPanelOpen = useUIStore((s) => s.setVideoPanelOpen);
  const setBrowserPanelOpen = useUIStore((s) => s.setBrowserPanelOpen);
  const sidePanelVisible = useUIStore((s) => s.sidePanelVisible);
  const sidePanelTab = useUIStore((s) => s.sidePanelTab);

  // Smart toggle: open side panel on a specific tab, or close if already there
  const smartToggleTab = (tab: SidePanelTab) => {
    const { toggleSidePanel, setSidePanelTab } = useUIStore.getState();
    if (sidePanelVisible && sidePanelTab === tab) {
      toggleSidePanel();
    } else {
      if (!sidePanelVisible) toggleSidePanel();
      setSidePanelTab(tab);
    }
  };

  // Active state detection for toggle buttons
  const isChatActive = sidePanelVisible && sidePanelTab === 'chat';
  const isBacklinksActive = sidePanelVisible && sidePanelTab === 'backlinks';

  // Base and active button styles
  const btnBase = 'p-1.5 rounded-md transition-colors';
  const btnDefault = `${btnBase} text-muted-foreground hover:text-foreground hover:bg-theme-hover`;
  const btnActive = `${btnBase} text-theme-accent bg-theme-accent/15`;

  return (
    <div
      className="h-11 flex items-center px-3 gap-1 border-b border-theme-border bg-surface select-none shrink-0"
      data-tauri-drag-region
    >
      {/* ── Left: sidebar toggle + brand + mode switch ──── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleSidebar}
            className={sidebarVisible ? btnActive : btnDefault}
            aria-label={t('actions.toggleSidebar')}
          >
            <PanelLeft size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" shortcut="⌘B">{t('actions.toggleSidebar')}</TooltipContent>
      </Tooltip>
      <span className="text-sm font-semibold text-foreground ml-1" data-tauri-drag-region>
        OxideNote
      </span>
      <EditorModeSwitch mode={editorMode} onChange={setEditorMode} />

      <div className="flex-1" data-tauri-drag-region />

      {/* ── Right: primary actions ─────────────────────── */}

      {/* Search */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setGlobalSearchOpen(true)}
            className={btnDefault}
            aria-label={t('actions.search')}
          >
            <Search size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" shortcut="⌘⇧F">{t('actions.search')}</TooltipContent>
      </Tooltip>

      {/* AI Assistant — promoted to titlebar */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => smartToggleTab('chat')}
            className={isChatActive ? btnActive : btnDefault}
            aria-label={t('actions.toggleChat')}
          >
            <Sparkles size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" shortcut="⌘L">{t('actions.toggleChat')}</TooltipContent>
      </Tooltip>

      {/* Backlinks */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => smartToggleTab('backlinks')}
            className={isBacklinksActive ? btnActive : btnDefault}
            aria-label={t('backlinks.title')}
          >
            <Link2 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" shortcut={'⌘\\'}>{t('backlinks.title')}</TooltipContent>
      </Tooltip>

      {/* More tools dropdown — low-frequency features */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={btnDefault}
            title={t('actions.moreTools')}
            aria-label={t('actions.moreTools')}
          >
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem onClick={() => setGraphViewOpen(true)}>
            <Share2 size={14} className="mr-2" />
            {t('actions.knowledgeGraph')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setFlashcardOpen(true)}>
            <Layers size={14} className="mr-2" />
            {t('flashcard.title')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPresentationMode(true)}>
            <Monitor size={14} className="mr-2" />
            {t('presentation.title')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setVideoPanelOpen(!useUIStore.getState().videoPanelOpen)}>
            <Video size={14} className="mr-2" />
            {t('video.title')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setBrowserPanelOpen(!useUIStore.getState().browserPanelOpen)}>
            <Globe size={14} className="mr-2" />
            {t('browser.title')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Settings */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setSettingsOpen(true)}
            className={btnDefault}
            aria-label={t('actions.settings')}
          >
            <Settings size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" shortcut="⌘,">{t('actions.settings')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// ── 编辑 / 预览 / 分屏 模式切换器 ──────────────────────────

function EditorModeSwitch({ mode, onChange }: { mode: EditorMode; onChange: (m: EditorMode) => void }) {
  const { t } = useTranslation();

  const modes: { key: EditorMode; label: string }[] = [
    { key: 'edit', label: t('editor.edit') },
    { key: 'preview', label: t('editor.preview') },
    { key: 'split', label: t('editor.split') },
  ];

  return (
    <div className="flex items-center ml-3 rounded-full bg-background border border-theme-border overflow-hidden">
      {modes.map(({ key, label }) => (
        <button
          key={key}
          className={`px-3 py-1 text-xs font-medium transition-all ${
            mode === key
              ? 'bg-theme-accent text-white rounded-full shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onChange(key)}
          aria-label={label}
          aria-pressed={mode === key}
        >
          {label}
        </button>
      ))}
    </div>
  );
}


