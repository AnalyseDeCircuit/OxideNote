import { useEffect, useState, useCallback, useRef } from 'react';
import { Command } from 'cmdk';
import { useUIStore } from '@/store/uiStore';
import { useNoteStore } from '@/store/noteStore';
import { searchByFilename, type SearchResult } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';

export function QuickOpen() {
  const open = useUIStore((s) => s.quickOpenOpen);
  const setOpen = useUIStore((s) => s.setQuickOpenOpen);
  const openNote = useNoteStore((s) => s.openNote);
  const recentNotes = useNoteStore((s) => s.recentNotes);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();

  // 150ms debounce 避免每次按键都触发 IPC + DB 查询
  const doSearch = useCallback((value: string) => {
    setQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      setResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      searchByFilename(value)
        .then(setResults)
        .catch(() => setResults([]));
    }, 150);
  }, []);

  // Reset state when closing
  useEffect(() => {
    if (!open) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      setQuery('');
      setResults([]);
    }
  }, [open]);

  const handleSelect = (path: string, title: string) => {
    openNote(path, title);
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[520px] rounded-lg border border-theme-border bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false} className="flex flex-col">
          <Command.Input
            value={query}
            onValueChange={doSearch}
            placeholder={t('search.quickOpenPlaceholder')}
            className="w-full px-4 py-3 text-sm bg-transparent text-foreground outline-none border-b border-theme-border placeholder:text-muted-foreground"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <Command.List className="max-h-[300px] overflow-y-auto p-1">
            {/* Show recent notes when query is empty */}
            {!query && recentNotes.length > 0 && (
              <Command.Group heading={t('search.recent')}>
                {recentNotes.map((r) => (
                  <Command.Item
                    key={r.path}
                    value={r.path}
                    onSelect={() => handleSelect(r.path, r.title)}
                    className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer text-foreground data-[selected=true]:bg-theme-hover"
                  >
                    <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{r.title || r.path}</div>
                      <div className="truncate text-xs text-muted-foreground">{r.path}</div>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {query && results.length === 0 && (
              <Command.Empty className="px-4 py-6 text-sm text-muted-foreground text-center">
                {t('search.noResults')}
              </Command.Empty>
            )}
            {results.map((r) => (
              <Command.Item
                key={r.path}
                value={r.path}
                onSelect={() => handleSelect(r.path, r.title)}
                className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer text-foreground data-[selected=true]:bg-theme-hover"
              >
                <NoteIcon />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{r.title || r.path}</div>
                  <div className="truncate text-xs text-muted-foreground">{r.path}</div>
                </div>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}
