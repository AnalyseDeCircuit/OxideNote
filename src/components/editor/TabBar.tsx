// ── TabBar ──────────────────────────────────────────────────────────────────
// Horizontal tab strip showing all open notes.
// Features:
//   • Click to activate, ✕ or middle-click to close
//   • Right-click context menu: close / close others / close all
//   • Dirty indicator (accent dot) for unsaved changes
// ────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, memo, useCallback } from 'react';
import { X } from 'lucide-react';
import { useNoteStore, flushPendingSave, type Tab } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';

export function TabBar() {
  const openTabs = useNoteStore((s) => s.openTabs);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);

  if (openTabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      className="flex items-center border-b border-theme-border bg-surface overflow-x-auto shrink-0"
    >
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

// ── Context menu state ──────────────────────────────────────────────────────
interface CtxMenu {
  x: number;
  y: number;
  path: string;
}

const TabItem = memo(function TabItem({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const setActiveTab = useNoteStore((s) => s.setActiveTab);
  const closeTab = useNoteStore((s) => s.closeTab);
  const closeAllTabs = useNoteStore((s) => s.closeAllTabs);
  const closeOtherTabs = useNoteStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useNoteStore((s) => s.closeTabsToRight);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

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
        className={`group flex items-center gap-1.5 px-3 py-1.5 text-[13px] cursor-pointer select-none border-r border-theme-border transition-colors ${
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-theme-hover hover:text-foreground'
        }`}
        onClick={() => setActiveTab(tab.path)}
        // Middle-click (button === 1) to close
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            flushPendingSave(tab.path).then(() => closeTab(tab.path));
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, path: tab.path });
        }}
      >
        {/* Dirty indicator */}
        {tab.isDirty && (
          <span className="w-2 h-2 rounded-full bg-theme-accent shrink-0" />
        )}
        <span className="truncate max-w-[150px]">{tab.title}</span>
        <button
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-theme-hover transition-opacity"
          aria-label={t('actions.closeTab', 'Close tab')}
          onClick={(e) => {
            e.stopPropagation();
            flushPendingSave(tab.path).then(() => closeTab(tab.path));
          }}
        >
          <X size={12} />
        </button>
      </div>

      {/* ── Tab context menu ─────────────────────────────────────────────── */}
      {ctx && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-theme-border bg-surface shadow-lg py-1 text-sm"
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <CtxMenuItem
            label={t('tabs.close', '关闭')}
            onClick={() => { flushPendingSave(ctx.path).then(() => closeTab(ctx.path)); setCtx(null); }}
          />
          <CtxMenuItem
            label={t('tabs.closeOthers', '关闭其他')}
            onClick={() => { closeOtherTabs(ctx.path); setCtx(null); }}
          />
          <CtxMenuItem
            label={t('tabs.closeRight', '关闭右侧')}
            onClick={() => { closeTabsToRight(ctx.path); setCtx(null); }}
          />
          <CtxMenuItem
            label={t('tabs.closeAll', '关闭所有')}
            onClick={() => { closeAllTabs(); setCtx(null); }}
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
    >
      {label}
    </button>
  );
}
