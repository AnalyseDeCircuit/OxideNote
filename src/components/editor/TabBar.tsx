// ── TabBar ──────────────────────────────────────────────────────────────────
// Horizontal tab strip showing all open notes.
// Features:
//   • Click to activate, ✕ or middle-click to close
//   • Right-click context menu: close / close others / close all
//   • Dirty indicator (accent dot) for unsaved changes
// ────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, memo, useCallback } from 'react';
import { X, Pin, Layout } from 'lucide-react';
import { useNoteStore, flushPendingSave, type SaveOutcome, type Tab } from '@/store/noteStore';
import { toast } from '@/hooks/useToast';
import { useTranslation } from 'react-i18next';

export function TabBar() {
  const openTabs = useNoteStore((s) => s.openTabs);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (openTabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      className="flex items-center border-b border-theme-border bg-surface overflow-x-auto shrink-0 h-9"
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDragOverIndex(null)}
      onDrop={() => setDragOverIndex(null)}
    >
      {openTabs.map((tab, index) => (
        <TabItem
          key={tab.path}
          tab={tab}
          index={index}
          isActive={tab.path === activeTabPath}
          dragOverIndex={dragOverIndex}
          setDragOverIndex={setDragOverIndex}
        />
      ))}
    </div>
  );
}

// ── Context menu state ──────────────────────────────────────────────────────
interface CtxMenu {
  x: number;
  y: number;
  path: string;
}

const TabItem = memo(function TabItem({ tab, index, isActive, dragOverIndex, setDragOverIndex }: {
  tab: Tab;
  index: number;
  isActive: boolean;
  dragOverIndex: number | null;
  setDragOverIndex: (i: number | null) => void;
}) {
  const openTabs = useNoteStore((s) => s.openTabs);
  const setActiveTab = useNoteStore((s) => s.setActiveTab);
  const closeTab = useNoteStore((s) => s.closeTab);
  const moveTab = useNoteStore((s) => s.moveTab);
  const togglePinTab = useNoteStore((s) => s.togglePinTab);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  const tryCloseTab = useCallback(async (path: string) => {
    const outcome = await flushPendingSave(path);
    if (outcome === 'saved' || outcome === 'noop') {
      closeTab(path);
      return;
    }

    setActiveTab(path);
    toast({
      title: t('conflict.resolveBeforeCloseTitle'),
      description: t('conflict.resolveBeforeCloseMessage'),
      variant: 'warning',
    });
  }, [closeTab, setActiveTab, t]);

  const tryCloseTabs = useCallback(async (paths: string[]) => {
    const blockedPaths: string[] = [];

    for (const path of paths) {
      const outcome = await flushPendingSave(path);
      if (outcome === 'saved' || outcome === 'noop') {
        closeTab(path);
      } else {
        blockedPaths.push(path);
      }
    }

    if (blockedPaths.length > 0) {
      setActiveTab(blockedPaths[0]);
      toast({
        title: t('conflict.resolveBeforeCloseTitle'),
        description: t('conflict.resolveBeforeCloseMessage'),
        variant: 'warning',
      });
    }
  }, [closeTab, setActiveTab, t]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, [index]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, [index, setDragOverIndex]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const fromIndex = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(fromIndex)) {
      moveTab(fromIndex, index);
    }
    setDragOverIndex(null);
  }, [index, moveTab, setDragOverIndex]);

  // Dismiss the context menu on outside click or scroll
  useEffect(() => {
    if (!ctx) return;
    const dismiss = () => setCtx(null);
    window.addEventListener('click', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [ctx]);

  return (
    <>
      <div
        role="tab"
        aria-selected={isActive}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`group relative flex items-center gap-1.5 px-3.5 py-2 text-[13px] cursor-pointer select-none border-r border-theme-border transition-colors ${
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-theme-hover hover:text-foreground'
        }${dragOverIndex === index ? ' ring-1 ring-theme-accent' : ''}`}
        onClick={() => setActiveTab(tab.path)}
        // Middle-click (button === 1) to close
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            void tryCloseTab(tab.path);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, path: tab.path });
        }}
      >
        {/* Pinned indicator */}
        {tab.isPinned && (
          <Pin size={10} className="shrink-0 text-theme-accent rotate-45" />
        )}
        {/* Dirty indicator */}
        {tab.isDirty && (
          <span className="w-2 h-2 rounded-full bg-theme-accent shrink-0" />
        )}
        {/* Canvas file icon */}
        {tab.path.endsWith('.canvas') && (
          <Layout size={12} className="shrink-0 text-muted-foreground" />
        )}
        <span className="truncate max-w-[150px]">{tab.title}</span>
        {!tab.isPinned && (
          <button
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-theme-hover transition-opacity"
            aria-label={t('actions.closeTab')}
            onClick={(e) => {
              e.stopPropagation();
              void tryCloseTab(tab.path);
            }}
          >
            <X size={12} />
          </button>
        )}
        {/* Active tab bottom accent line */}
        {isActive && (
          <span className="absolute bottom-0 left-1 right-1 h-0.5 rounded-full bg-theme-accent" />
        )}
      </div>

      {/* ── Tab context menu ─────────────────────────────────────────────── */}
      {ctx && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-theme-border bg-surface shadow-lg py-1 text-sm"
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <CtxMenuItem
            label={t('tabs.close')}
            onClick={() => { void tryCloseTab(ctx.path); setCtx(null); }}
          />
          <CtxMenuItem
            label={tab.isPinned ? t('tabs.unpin') : t('tabs.pin')}
            onClick={() => { togglePinTab(ctx.path); setCtx(null); }}
          />
          <CtxMenuItem
            label={t('tabs.closeOthers')}
            onClick={() => {
              void tryCloseTabs(openTabs.filter((openTab) => openTab.path !== ctx.path).map((openTab) => openTab.path));
              setCtx(null);
            }}
          />
          <CtxMenuItem
            label={t('tabs.closeRight')}
            onClick={() => {
              const currentIndex = openTabs.findIndex((openTab) => openTab.path === ctx.path);
              if (currentIndex >= 0) {
                void tryCloseTabs(openTabs.slice(currentIndex + 1).map((openTab) => openTab.path));
              }
              setCtx(null);
            }}
          />
          <CtxMenuItem
            label={t('tabs.closeAll')}
            onClick={() => {
              void tryCloseTabs(openTabs.map((openTab) => openTab.path));
              setCtx(null);
            }}
          />
        </div>
      )}
    </>
  );
});

/** A single row in the tab context menu */
function CtxMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-theme-hover transition-colors"
      onClick={onClick}
      role="menuitem"
    >
      {label}
    </button>
  );
}
