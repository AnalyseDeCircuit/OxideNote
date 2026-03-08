import { useEffect, useRef } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { listen } from '@tauri-apps/api/event';
import { useUIStore, type EditorMode, type SidePanelTab } from '@/store/uiStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { VaultTree } from '@/components/tree/VaultTree';
import { TabBar } from '@/components/editor/TabBar';
import { NoteEditor } from '@/components/editor/NoteEditor';
import { StatusBar } from '@/components/editor/StatusBar';
import { BacklinksPanel } from '@/components/editor/BacklinksPanel';
import { OutlinePanel } from '@/components/editor/OutlinePanel';
import { TagPanel } from '@/components/editor/TagPanel';
import { TaskPanel } from '@/components/editor/TaskPanel';
import { PropertiesPanel } from '@/components/editor/PropertiesPanel';
import { GraphView } from '@/components/graph/GraphView';
import { FlashcardView } from '@/components/flashcard/FlashcardView';
import { VideoPanel } from '@/components/video/VideoPanel';
import { BrowserPanel } from '@/components/browser/BrowserPanel';
import { listTree } from '@/lib/api';
import { useTranslation } from 'react-i18next';

export function AppShell() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const sidePanelVisible = useUIStore((s) => s.sidePanelVisible);
  const sidePanelTab = useUIStore((s) => s.sidePanelTab);
  const graphViewOpen = useUIStore((s) => s.graphViewOpen);
  const flashcardOpen = useUIStore((s) => s.flashcardOpen);
  const videoPanelOpen = useUIStore((s) => s.videoPanelOpen);
  const browserPanelOpen = useUIStore((s) => s.browserPanelOpen);
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
    </div>
  );
}

// ── 右侧面板标签切换 ────────────────────────────────────────
// 在「反向链接」和「文档大纲」之间切换

function SidePanelTabs({ activeTab }: { activeTab: SidePanelTab }) {
  const { t } = useTranslation();
  const setSidePanelTab = useUIStore((s) => s.setSidePanelTab);

  return (
    <div className="h-full flex flex-col">
      <div className="flex border-b border-theme-border shrink-0">
        <TabButton
          active={activeTab === 'backlinks'}
          onClick={() => setSidePanelTab('backlinks')}
          label={t('backlinks.title')}
        />
        <TabButton
          active={activeTab === 'outline'}
          onClick={() => setSidePanelTab('outline')}
          label={t('outline.title')}
        />
        <TabButton
          active={activeTab === 'tags'}
          onClick={() => setSidePanelTab('tags')}
          label={t('tags.title', '标签')}
        />
        <TabButton
          active={activeTab === 'tasks'}
          onClick={() => setSidePanelTab('tasks')}
          label={t('tasks.title')}
        />
        <TabButton
          active={activeTab === 'properties'}
          onClick={() => setSidePanelTab('properties')}
          label={t('properties.title')}
        />
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === 'backlinks' && <BacklinksPanel />}
        {activeTab === 'outline' && <OutlinePanel />}
        {activeTab === 'tags' && <TagPanel />}
        {activeTab === 'tasks' && <TaskPanel onClose={() => useUIStore.getState().toggleSidePanel()} />}
        {activeTab === 'properties' && <PropertiesPanel />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'text-theme-accent border-b-2 border-theme-accent'
          : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Titlebar() {
  const { t } = useTranslation();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const editorMode = useUIStore((s) => s.editorMode);
  const setEditorMode = useUIStore((s) => s.setEditorMode);
  const setGraphViewOpen = useUIStore((s) => s.setGraphViewOpen);
  const setGlobalSearchOpen = useUIStore((s) => s.setGlobalSearchOpen);
  const setFlashcardOpen = useUIStore((s) => s.setFlashcardOpen);
  const setVideoPanelOpen = useUIStore((s) => s.setVideoPanelOpen);
  const setBrowserPanelOpen = useUIStore((s) => s.setBrowserPanelOpen);

  // 智能切换右侧面板：点反链图标，如已显示反链则收起，否则打开并切到反链
  const handleBacklinksToggle = () => {
    const { sidePanelVisible, sidePanelTab, toggleSidePanel, setSidePanelTab } = useUIStore.getState();
    if (sidePanelVisible && sidePanelTab === 'backlinks') {
      toggleSidePanel();
    } else {
      if (!sidePanelVisible) toggleSidePanel();
      setSidePanelTab('backlinks');
    }
  };

  return (
    <div
      className="h-10 flex items-center px-3 gap-2 border-b border-theme-border bg-surface select-none shrink-0"
      data-tauri-drag-region
    >
      <button
        onClick={toggleSidebar}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('actions.toggleSidebar')}
        aria-label={t('actions.toggleSidebar')}
      >
        <SidebarIcon />
      </button>
      <span className="text-sm font-medium text-foreground" data-tauri-drag-region>
        OxideNote
      </span>

      {/* ── 编辑模式切换按钮组 ──────────────────────────── */}
      <EditorModeSwitch mode={editorMode} onChange={setEditorMode} />

      <div className="flex-1" data-tauri-drag-region />

      {/* ── 全局搜索入口 ────────────────────────────────── */}
      <button
        onClick={() => setGlobalSearchOpen(true)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('actions.search')}
        aria-label={t('actions.search')}
      >
        <SearchIcon />
      </button>

      {/* ── 知识图谱入口 ────────────────────────────────── */}
      <button
        onClick={() => setGraphViewOpen(true)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('actions.knowledgeGraph')}
        aria-label={t('actions.knowledgeGraph')}
      >
        <GraphIcon />
      </button>

      {/* ── 闪卡入口 ────────────────────────────────────── */}
      <button
        onClick={() => setFlashcardOpen(true)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('flashcard.title')}
        aria-label={t('flashcard.title')}
      >
        <FlashcardIcon />
      </button>

      {/* ── 视频面板入口 ────────────────────────────────── */}
      <button
        onClick={() => setVideoPanelOpen(!useUIStore.getState().videoPanelOpen)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('video.title')}
        aria-label={t('video.title')}
      >
        <VideoIcon />
      </button>

      {/* ── 浏览器面板入口 ──────────────────────────────── */}
      <button
        onClick={() => setBrowserPanelOpen(!useUIStore.getState().browserPanelOpen)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('browser.title')}
        aria-label={t('browser.title')}
      >
        <BrowserIcon />
      </button>

      {/* ── 反向链接面板 ────────────────────────────────── */}
      <button
        onClick={handleBacklinksToggle}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('backlinks.title')}
        aria-label={t('backlinks.title')}
      >
        <BacklinksIcon />
      </button>
      <button
        onClick={() => setSettingsOpen(true)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title={t('actions.settings')}
        aria-label={t('actions.settings')}
      >
        <SettingsIcon />
      </button>
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
    <div className="flex items-center ml-3 bg-background rounded border border-theme-border overflow-hidden">
      {modes.map(({ key, label }) => (
        <button
          key={key}
          className={`px-2.5 py-0.5 text-xs font-medium transition-colors ${
            mode === key
              ? 'bg-theme-accent text-white'
              : 'text-muted-foreground hover:text-foreground hover:bg-theme-hover'
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

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" x2="16.65" y1="21" y2="16.65" />
    </svg>
  );
}

function BacklinksIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" x2="16" y1="12" y2="12" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="12" cy="18" r="3" />
      <line x1="8.5" y1="7.5" x2="10.5" y2="16" />
      <line x1="15.5" y1="7.5" x2="13.5" y2="16" />
      <line x1="9" y1="6" x2="15" y2="6" />
    </svg>
  );
}

function FlashcardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polygon points="10,8 16,12 10,16" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
