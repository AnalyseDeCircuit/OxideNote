import { Panel, Group, Separator } from 'react-resizable-panels';
import { useUIStore } from '@/store/uiStore';

export function AppShell() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);

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
                <SidebarPlaceholder />
              </Panel>
              <Separator className="w-px bg-theme-border hover:bg-theme-accent transition-colors" />
            </>
          )}
          <Panel id="editor" minSize="30%" className="bg-background">
            <EditorAreaPlaceholder />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function Titlebar() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

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
      <div className="flex-1" data-tauri-drag-region />
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

function SidebarPlaceholder() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      Sidebar
    </div>
  );
}

function EditorAreaPlaceholder() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      Editor Area
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
