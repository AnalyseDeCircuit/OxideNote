/**
 * SidebarContent — renders the content area beside the Activity Bar.
 *
 * Switches on the active sidebar section to display the appropriate panel:
 * - explorer: VaultTree + BookmarkList
 * - search:   Inline FTS search with results
 * - backlinks: BacklinksPanel + OutlinePanel (tabbed)
 * - chat:     ChatPanel
 * - agent:    AgentPanel
 * - dashboard: DashboardPanel (tags, tasks, properties, history)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useUIStore, type SidebarSection } from '@/store/uiStore';
import { useNoteStore } from '@/store/noteStore';
import { VaultTree } from '@/components/tree/VaultTree';
import { BookmarkList } from '@/components/tree/BookmarkList';
import { BacklinksPanel } from '@/components/editor/BacklinksPanel';
import { OutlinePanel } from '@/components/editor/OutlinePanel';
import { TagPanel } from '@/components/editor/TagPanel';
import { TaskPanel } from '@/components/editor/TaskPanel';
import { PropertiesPanel } from '@/components/editor/PropertiesPanel';
import { HistoryPanel } from '@/components/editor/HistoryPanel';
import { DashboardPanel } from '@/components/editor/DashboardPanel';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { AgentPanel } from '@/components/agent/AgentPanel';
import { searchNotes, type SearchResult } from '@/lib/api';

// ── Section header with title ───────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="h-9 flex items-center px-3 border-b border-theme-border shrink-0">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
    </div>
  );
}

// ── Inline search panel (replaces the old GlobalSearch dialog for sidebar) ──

function InlineSearchPanel() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openNote = useNoteStore((s) => s.openNote);

  // Auto-focus input when section becomes active
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const doSearch = useCallback((value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!value.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await searchNotes(value);
        setResults(res);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <SectionHeader title={t('sidebar.search')} />
      {/* Search input */}
      <div className="px-2 py-2 border-b border-theme-border">
        <div className="flex items-center gap-1.5 bg-background rounded-md border border-theme-border px-2 py-1.5">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => doSearch(e.target.value)}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          {query && (
            <button
              onClick={() => doSearch('')}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">
            {t('search.searching')}
          </div>
        )}
        {!loading && query && results.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">
            {t('search.noResults')}
          </div>
        )}
        {results.map((result) => (
          <button
            key={result.path}
            className="w-full text-left px-3 py-2 hover:bg-theme-hover transition-colors border-b border-theme-border/50"
            onClick={() => openNote(result.path, result.title)}
          >
            <div className="text-sm font-medium text-foreground truncate">
              {result.title}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {result.path}
            </div>
            {result.snippet && (
              <div
                className="text-xs text-muted-foreground mt-1 line-clamp-2 [&_mark]:bg-theme-accent/30 [&_mark]:text-foreground [&_mark]:rounded-sm"
                dangerouslySetInnerHTML={{ __html: result.snippet }}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Backlinks+Outline tabbed section ────────────────────────

function BacklinksSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'backlinks' | 'outline'>('backlinks');

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center border-b border-theme-border shrink-0">
        <button
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'backlinks'
              ? 'text-theme-accent border-b-2 border-theme-accent'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setTab('backlinks')}
        >
          {t('backlinks.title')}
        </button>
        <button
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'outline'
              ? 'text-theme-accent border-b-2 border-theme-accent'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setTab('outline')}
        >
          {t('outline.title')}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'backlinks' ? <BacklinksPanel /> : <OutlinePanel />}
      </div>
    </div>
  );
}

// ── Dashboard section (tags, tasks, properties, history) ────

function DashboardSection() {
  const { t } = useTranslation();
  type DashTab = 'dashboard' | 'tags' | 'tasks' | 'properties' | 'history';
  const [tab, setTab] = useState<DashTab>('dashboard');

  const tabs: { key: DashTab; label: string }[] = [
    { key: 'dashboard',  label: t('dashboard.title') },
    { key: 'tags',       label: t('tags.title') },
    { key: 'tasks',      label: t('tasks.title') },
    { key: 'properties', label: t('properties.title') },
    { key: 'history',    label: t('history.title') },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Scrollable tab strip for many sub-tabs */}
      <div className="flex items-center border-b border-theme-border shrink-0 overflow-x-auto">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            className={`whitespace-nowrap px-3 py-2 text-xs font-medium transition-colors ${
              tab === key
                ? 'text-theme-accent border-b-2 border-theme-accent'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'dashboard' && <DashboardPanel />}
        {tab === 'tags' && <TagPanel />}
        {tab === 'tasks' && <TaskPanel onClose={() => useUIStore.getState().toggleSidebar()} />}
        {tab === 'properties' && <PropertiesPanel />}
        {tab === 'history' && <HistoryPanel />}
      </div>
    </div>
  );
}

// ── Main SidebarContent component ───────────────────────────

export function SidebarContent() {
  const { t } = useTranslation();
  const activeSidebarSection = useUIStore((s) => s.activeSidebarSection);

  return (
    <div className="h-full bg-surface">
      {activeSidebarSection === 'explorer' && (
        <div className="h-full flex flex-col">
          <SectionHeader title={t('sidebar.explorer')} />
          <div className="flex-1 min-h-0 flex flex-col">
            <BookmarkList />
            <VaultTree />
          </div>
        </div>
      )}
      {activeSidebarSection === 'search' && <InlineSearchPanel />}
      {activeSidebarSection === 'backlinks' && <BacklinksSection />}
      {activeSidebarSection === 'chat' && <ChatPanel />}
      {activeSidebarSection === 'agent' && <AgentPanel />}
      {activeSidebarSection === 'dashboard' && <DashboardSection />}
    </div>
  );
}
