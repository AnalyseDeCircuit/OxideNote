import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { searchNotes, advancedSearch, semanticSearch, type SearchResult, type SemanticSearchResult } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';

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

// ─── Search query parser ─────────────────────────────────────
// Extracts `tag:xxx` and `path:yyy` prefix filters from the raw query string.
// Remaining text is used as the FTS query.

interface ParsedQuery {
  ftsQuery: string;
  tagFilter?: string;
  pathFilter?: string;
}

function parseSearchQuery(raw: string): ParsedQuery {
  let fts = raw;
  let tagFilter: string | undefined;
  let pathFilter: string | undefined;

  // Extract tag:xxx
  const tagMatch = fts.match(/\btag:(\S+)/);
  if (tagMatch) {
    tagFilter = tagMatch[1];
    fts = fts.replace(tagMatch[0], '');
  }

  // Extract path:xxx
  const pathMatch = fts.match(/\bpath:(\S+)/);
  if (pathMatch) {
    pathFilter = pathMatch[1];
    fts = fts.replace(pathMatch[0], '');
  }

  return { ftsQuery: fts.trim(), tagFilter, pathFilter };
}

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

// ── GlobalSearch ─────────────────────────────────────────────────────────────
// Full-text search modal with keyboard navigation.
// ↑↓ to cycle results, Enter to open, Escape to dismiss.
// Results are rendered with highlighted <mark> snippets from FTS5.
// ─────────────────────────────────────────────────────────────────────────────

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [semanticMode, setSemanticMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultListRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openNote = useNoteStore((s) => s.openNote);
  const { t } = useTranslation();

  // Focus input when opened; reset state on close
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setResults([]);
      setSelectedIndex(-1);
    }
  }, [open]);

  // Cancel in-flight debounce when search mode changes to prevent stale results
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [semanticMode]);

  const doSearch = useCallback((value: string) => {
    setQuery(value);
    setSelectedIndex(-1);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        if (semanticMode) {
          // Semantic search via embedding cosine similarity
          const semResults = await semanticSearch(value.trim());
          // Convert SemanticSearchResult → SearchResult for unified display
          setResults(
            semResults.map((r) => ({
              path: r.path,
              title: r.title,
              snippet: `${(r.score * 100).toFixed(0)}% — ${r.snippet}`,
            })),
          );
        } else {
          const parsed = parseSearchQuery(value);
          let res: SearchResult[];
          if (parsed.tagFilter || parsed.pathFilter) {
            res = await advancedSearch(
              parsed.ftsQuery || undefined,
              parsed.tagFilter,
              parsed.pathFilter,
            );
          } else {
            res = await searchNotes(parsed.ftsQuery);
          }
          setResults(res);
        }
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, semanticMode ? 500 : 300); // Slightly longer debounce for semantic
  }, [semanticMode]);

  const handleSelect = useCallback((r: SearchResult) => {
    openNote(r.path, r.title || r.path);
    onClose();
  }, [openNote, onClose]);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  // ArrowDown/ArrowUp cycle through results, Enter opens the selected item.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (results.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev < results.length - 1 ? prev + 1 : 0;
          scrollItemIntoView(next);
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : results.length - 1;
          scrollItemIntoView(next);
          return next;
        });
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault();
        handleSelect(results[selectedIndex]);
      }
    },
    [results, selectedIndex, onClose, handleSelect],
  );

  /** Scroll the result at `idx` into the visible area of the list */
  function scrollItemIntoView(idx: number) {
    const list = resultListRef.current;
    if (!list) return;
    const items = list.querySelectorAll('[data-result-item]');
    items[idx]?.scrollIntoView({ block: 'nearest' });
  }

  if (!open) return null;

  // Parse active filters for display
  const parsed = parseSearchQuery(query);
  const hasFilters = !!(parsed.tagFilter || parsed.pathFilter);

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
            placeholder={semanticMode ? t('search.semanticPlaceholder') : t('search.advancedPlaceholder')}
            className="flex-1 text-sm bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            onKeyDown={handleKeyDown}
          />
          {loading && (
            <span className="text-xs text-muted-foreground">{t('search.searching')}</span>
          )}
          {/* Semantic search toggle */}
          <button
            onClick={() => {
              setSemanticMode((v) => !v);
              setResults([]);
            }}
            className={`p-1 rounded transition-colors shrink-0 ${
              semanticMode
                ? 'bg-theme-accent/20 text-theme-accent'
                : 'hover:bg-theme-hover text-muted-foreground'
            }`}
            title={t('search.semanticToggle')}
          >
            <Brain size={16} />
          </button>
        </div>

        {/* Active filter chips */}
        {hasFilters && (
          <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-theme-border bg-surface/50">
            {parsed.tagFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-theme-accent/15 text-theme-accent">
                tag:{parsed.tagFilter}
              </span>
            )}
            {parsed.pathFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-theme-accent/15 text-theme-accent">
                path:{parsed.pathFilter}
              </span>
            )}
            {parsed.ftsQuery && (
              <span className="text-[10px] text-muted-foreground ml-1">
                + &quot;{parsed.ftsQuery}&quot;
              </span>
            )}
          </div>
        )}

        {/* Syntax hint when input is empty */}
        {!query && (
          <div className="px-4 py-3 text-[11px] text-muted-foreground border-b border-theme-border">
            <p className="mb-1">{t('search.syntaxHint')}</p>
            <code className="text-theme-accent">tag:dev path:projects/ keyword</code>
          </div>
        )}

        {/* Results — keyboard-navigable list */}
        <div ref={resultListRef} className="max-h-[400px] overflow-y-auto">
          {query && results.length === 0 && !loading && (
            <div className="px-4 py-8 text-sm text-muted-foreground text-center">
              {t('search.noContentResults')}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.path}
              data-result-item
              onClick={() => handleSelect(r)}
              className={`w-full text-left px-4 py-3 transition-colors border-b border-theme-border last:border-b-0 ${
                i === selectedIndex
                  ? 'bg-theme-accent/15 text-foreground'
                  : 'hover:bg-theme-hover'
              }`}
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
