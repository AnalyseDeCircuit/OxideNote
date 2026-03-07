import { X } from 'lucide-react';
import { useNoteStore, type Tab } from '@/store/noteStore';

export function TabBar() {
  const openTabs = useNoteStore((s) => s.openTabs);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);

  if (openTabs.length === 0) return null;

  return (
    <div className="flex items-center border-b border-theme-border bg-surface overflow-x-auto shrink-0">
      {openTabs.map((tab) => (
        <TabItem
          key={tab.path}
          tab={tab}
          isActive={tab.path === activeTabPath}
        />
      ))}
    </div>
  );
}

function TabItem({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const setActiveTab = useNoteStore((s) => s.setActiveTab);
  const closeTab = useNoteStore((s) => s.closeTab);

  return (
    <div
      className={`group flex items-center gap-1.5 px-3 py-1.5 text-[13px] cursor-pointer select-none border-r border-theme-border transition-colors ${
        isActive
          ? 'bg-background text-foreground'
          : 'text-muted-foreground hover:bg-theme-hover hover:text-foreground'
      }`}
      onClick={() => setActiveTab(tab.path)}
    >
      {/* Dirty indicator */}
      {tab.isDirty && (
        <span className="w-2 h-2 rounded-full bg-theme-accent shrink-0" />
      )}
      <span className="truncate max-w-[150px]">{tab.title}</span>
      <button
        className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-theme-hover transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.path);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
