import { useEffect } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { listen } from '@tauri-apps/api/event';
import { useUIStore, type EditorMode, type SidePanelTab } from '@/store/uiStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { VaultTree } from '@/components/tree/VaultTree';
import { TabBar } from '@/components/editor/TabBar';
import { NoteEditor } from '@/components/editor/NoteEditor';
import { BacklinksPanel } from '@/components/editor/BacklinksPanel';
import { OutlinePanel } from '@/components/editor/OutlinePanel';
import { GraphView } from '@/components/graph/GraphView';
import { listTree } from '@/lib/api';
import { useTranslation } from 'react-i18next';

export function AppShell() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const sidePanelVisible = useUIStore((s) => s.sidePanelVisible);
  const sidePanelTab = useUIStore((s) => s.sidePanelTab);
  const graphViewOpen = useUIStore((s) => s.graphViewOpen);

  // Listen for file system changes from the Rust watcher
  useEffect(() => {
    const unlisten = listen('vault:file-changed', async () => {
      try {
        const tree = await listTree();
        useWorkspaceStore.getState().setTree(tree);
      } catch {
        // Vault may have been removed
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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
        </Group>
      </div>

      {/* ── 知识图谱全屏覆盖层 ──────────────────────────── */}
      {graphViewOpen && <GraphView />}
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
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === 'backlinks' ? <BacklinksPanel /> : <OutlinePanel />}
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
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleSidePanel = useUIStore((s) => s.toggleSidePanel);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const editorMode = useUIStore((s) => s.editorMode);
  const setEditorMode = useUIStore((s) => s.setEditorMode);
  const setGraphViewOpen = useUIStore((s) => s.setGraphViewOpen);

  return (
    <div
      className="h-10 flex items-center px-3 gap-2 border-b border-theme-border bg-surface select-none shrink-0"
      data-tauri-drag-region
    >
      <button
        onClick={toggleSidebar}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title="Toggle Sidebar"
      >
        <SidebarIcon />
      </button>
      <span className="text-sm font-medium text-foreground" data-tauri-drag-region>
        OxideNote
      </span>

      {/* ── 编辑模式切换按钮组 ──────────────────────────── */}
      <EditorModeSwitch mode={editorMode} onChange={setEditorMode} />

      <div className="flex-1" data-tauri-drag-region />

      {/* ── 知识图谱入口 ────────────────────────────────── */}
      <button
        onClick={() => setGraphViewOpen(true)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title="Knowledge Graph"
      >
        <GraphIcon />
      </button>

      <button
        onClick={toggleSidePanel}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title="Toggle Side Panel"
      >
        <BacklinksIcon />
      </button>
      <button
        onClick={() => setSettingsOpen(true)}
        className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
        title="Settings"
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
