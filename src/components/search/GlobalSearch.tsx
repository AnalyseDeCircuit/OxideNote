import { useState, useRef, useEffect, useCallback } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { searchNotes, type SearchResult } from '@/lib/api';
import { useTranslation } from 'react-i18next';

/** Sanitize FTS snippet: only allow <mark> and </mark> tags */
function sanitizeSnippet(html: string): string {
  // Replace <mark> and </mark> with placeholders, escape everything else, then restore
  const MARK_OPEN = '\x00MARK_OPEN\x00';
  const MARK_CLOSE = '\x00MARK_CLOSE\x00';
  const safe = html
    .replace(/<mark>/gi, MARK_OPEN)
    .replace(/<\/mark>/gi, MARK_CLOSE)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(new RegExp(MARK_OPEN.replace(/\x00/g, '\\x00'), 'g'), '<mark>')
    .replace(new RegExp(MARK_CLOSE.replace(/\x00/g, '\\x00'), 'g'), '</mark>');
  return safe;
}

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openNote = useNoteStore((s) => s.openNote);
  const { t } = useTranslation();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setResults([]);
    }
  }, [open]);

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
      }
      setLoading(false);
    }, 300);
  }, []);

  const handleSelect = (r: SearchResult) => {
    openNote(r.path, r.title || r.path);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-[600px] rounded-lg border border-theme-border bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-theme-border">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => doSearch(e.target.value)}
            placeholder={t('search.searchContent')}
            className="flex-1 text-sm bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
          {loading && (
            <span className="text-xs text-muted-foreground">{t('search.searching')}</span>
          )}
        </div>

        {/* Results */}
        <div className="max-h-[400px] overflow-y-auto">
          {query && results.length === 0 && !loading && (
            <div className="px-4 py-8 text-sm text-muted-foreground text-center">
              {t('search.noContentResults')}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.path}
              onClick={() => handleSelect(r)}
              className="w-full text-left px-4 py-3 hover:bg-theme-hover transition-colors border-b border-theme-border last:border-b-0"
            >
              <div className="text-sm font-medium text-foreground truncate">
                {r.title || r.path}
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {r.path}
              </div>
              {r.snippet && (
                <div
                  className="text-xs text-muted-foreground mt-1 line-clamp-2 [&_mark]:bg-theme-accent/30 [&_mark]:text-foreground [&_mark]:px-0.5 [&_mark]:rounded"
                  dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
                />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground shrink-0">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
