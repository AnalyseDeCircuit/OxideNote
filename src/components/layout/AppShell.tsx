import { useEffect, useRef } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { listen } from '@tauri-apps/api/event';
import {
  PanelLeft,
  MoreHorizontal, Share2, Layers, Monitor, Video, Globe,
  LayoutGrid, PenTool,
} from 'lucide-react';
import { useUIStore, type EditorMode } from '@/store/uiStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ActivityBar } from '@/components/layout/ActivityBar';
import { SidebarContent } from '@/components/layout/SidebarContent';
import { TabBar } from '@/components/editor/TabBar';
import { NoteEditor } from '@/components/editor/NoteEditor';
import { StatusBar } from '@/components/editor/StatusBar';
import { GraphView } from '@/components/graph/GraphView';
import { CardFlowView } from '@/components/graph/CardFlowView';
import { DiagramEditor } from '@/components/editor/DiagramEditor';
import { getEditorView } from '@/lib/editorViewRef';
import { FlashcardView } from '@/components/flashcard/FlashcardView';
import { VideoPanel } from '@/components/video/VideoPanel';
import { BrowserPanel } from '@/components/browser/BrowserPanel';
import { PresentationView } from '@/components/presentation/PresentationView';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { listTree, readNote } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { initPreviewCacheInvalidation } from '@/lib/previewCache';
import { useTranslation } from 'react-i18next';

export function AppShell() {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const graphViewOpen = useUIStore((s) => s.graphViewOpen);
  const flashcardOpen = useUIStore((s) => s.flashcardOpen);
  const cardFlowOpen = useUIStore((s) => s.cardFlowOpen);
  const diagramEditorOpen = useUIStore((s) => s.diagramEditorOpen);
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

      // Validate persisted tabs — remove any whose files no longer exist
      const tabs = useNoteStore.getState().openTabs;
      for (const tab of tabs) {
        try {
          await readNote(tab.path);
        } catch {
          useNoteStore.getState().closeTab(tab.path);
        }
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
      <div className="flex-1 min-h-0 flex">
        {/* Activity Bar — always visible, fixed 48px */}
        <ActivityBar />

        {/* Sidebar content — collapsible via ResizablePanel */}
        <Group orientation="horizontal" id="oxidenote-layout">
          {!sidebarCollapsed && (
            <>
              <Panel
                id="sidebar-content"
                defaultSize="22%"
                minSize="15%"
                maxSize="35%"
                className="bg-surface"
              >
                <SidebarContent />
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

      {/* ── 卡片流全屏覆盖层 ──────────────────────────── */}
      {cardFlowOpen && <CardFlowView />}

      {/* ── 绘图板全屏覆盖层 ──────────────────────────── */}
      {diagramEditorOpen && (
        <DiagramEditor
          onSave={(data) => {
            // Insert diagram data as a code block at cursor position
            const view = getEditorView();
            if (view) {
              const block = `\n\`\`\`oxidenote-diagram\n${data}\n\`\`\`\n`;
              const pos = view.state.selection.main.head;
              view.dispatch({ changes: { from: pos, insert: block } });
            }
            useUIStore.getState().setDiagramEditorOpen(false);
          }}
          onClose={() => useUIStore.getState().setDiagramEditorOpen(false)}
        />
      )}

      {/* ── 演示模式全屏覆盖层 ──────────────────────────── */}
      {presentationMode && <PresentationView onClose={() => useUIStore.getState().setPresentationMode(false)} />}
    </div>
  );
}

// ── Simplified Titlebar ─────────────────────────────────────
// Only: sidebar toggle + brand + mode switch + more tools + drag region

function Titlebar() {
  const { t } = useTranslation();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const editorMode = useUIStore((s) => s.editorMode);
  const setEditorMode = useUIStore((s) => s.setEditorMode);
  const setGraphViewOpen = useUIStore((s) => s.setGraphViewOpen);
  const setFlashcardOpen = useUIStore((s) => s.setFlashcardOpen);
  const setPresentationMode = useUIStore((s) => s.setPresentationMode);
  const setVideoPanelOpen = useUIStore((s) => s.setVideoPanelOpen);
  const setBrowserPanelOpen = useUIStore((s) => s.setBrowserPanelOpen);

  const btnBase = 'p-1.5 rounded-md transition-colors';
  const btnDefault = `${btnBase} text-muted-foreground hover:text-foreground hover:bg-theme-hover`;
  const btnActive = `${btnBase} text-theme-accent bg-theme-accent/15`;

  return (
    <div
      className="h-11 flex items-center px-3 gap-1 border-b border-theme-border bg-surface select-none shrink-0"
      data-tauri-drag-region
    >
      {/* Left: sidebar toggle + brand + mode switch */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleSidebar}
            className={!sidebarCollapsed ? btnActive : btnDefault}
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

      {/* Right: more tools dropdown (low-frequency features only) */}
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
          <DropdownMenuItem onClick={() => useUIStore.getState().setCardFlowOpen(true)}>
            <LayoutGrid size={14} className="mr-2" />
            {t('cardFlow.title')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => useUIStore.getState().setDiagramEditorOpen(true)}>
            <PenTool size={14} className="mr-2" />
            {t('diagram.title')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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


