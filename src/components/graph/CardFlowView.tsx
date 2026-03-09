/**
 * CardFlowView — Masonry card layout for browsing notes visually.
 *
 * Displays notes as cards with title, excerpt, and metadata.
 * Supports sorting by name or modification time, filtering by search text.
 * Opened from the More menu; renders as a full-screen overlay.
 */

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Search, ArrowUpDown, Clock, Type, FileText, Tag } from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import { useNoteStore } from '@/store/noteStore';
import { listNotesSummary, readNote, type StatsRecentNote } from '@/lib/api';

// ── Types ───────────────────────────────────────────────────

interface CardNote {
  path: string;
  title: string;
  modified_at: string;
  excerpt: string;
  tags: string[];
}

type SortMode = 'modified' | 'name';

// ── Constants ───────────────────────────────────────────────

const BATCH_SIZE = 20;

// ── Main component ──────────────────────────────────────────

export function CardFlowView() {
  const { t } = useTranslation();
  const setCardFlowOpen = useUIStore((s) => s.setCardFlowOpen);
  const openNote = useNoteStore((s) => s.openNote);

  const [notes, setNotes] = useState<CardNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('modified');
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const offsetRef = useRef(0);

  // Load notes from backend with pagination
  const loadNotes = useCallback(async (cancelled: { value: boolean }) => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const summaries = await listNotesSummary(BATCH_SIZE, offsetRef.current);
      if (cancelled.value) return;

      if (summaries.length < BATCH_SIZE) {
        setHasMore(false);
      }

    // Load excerpts in parallel
    const cards = await Promise.all(
      summaries.map(async (n: StatsRecentNote) => {
        let excerpt = '';
        let tags: string[] = [];
        try {
          const content = await readNote(n.path);
          const lines = content.content.split('\n');
          const textLines = lines
            .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('tags:'))
            .slice(0, 3);
          excerpt = textLines.join(' ').slice(0, 200);

          const tagMatch = content.content.match(/#[\w\-\/]+/g);
          if (tagMatch) tags = [...new Set(tagMatch.slice(0, 5))];
        } catch {
          // Note may have been deleted
        }
        return {
          path: n.path,
          title: n.title || n.path.replace(/\.md$/, '').split('/').pop() || n.path,
          modified_at: n.modified_at,
          excerpt,
          tags,
        };
      })
    );

    if (cancelled.value) return;
    offsetRef.current += summaries.length;
    setNotes((prev) => (offsetRef.current === summaries.length ? cards : [...prev, ...cards]));
    } finally {
      loadingMoreRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    const cancelled = { value: false };
    offsetRef.current = 0;
    setLoading(true);
    loadNotes(cancelled)
      .catch((err) => console.warn('[cardflow] Failed to load notes:', err))
      .finally(() => { if (!cancelled.value) setLoading(false); });
    return () => { cancelled.value = true; };
  }, [loadNotes]);

  // Filtered and sorted notes
  const displayedNotes = useMemo(() => {
    let result = [...notes];
    if (filter) {
      const lower = filter.toLowerCase();
      result = result.filter(
        (n) =>
          n.title.toLowerCase().includes(lower) ||
          n.excerpt.toLowerCase().includes(lower) ||
          n.tags.some((tag) => tag.toLowerCase().includes(lower))
      );
    }
    result.sort((a, b) => {
      if (sortMode === 'name') return a.title.localeCompare(b.title);
      return new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime();
    });
    return result;
  }, [notes, filter, sortMode]);

  // Infinite scroll via IntersectionObserver — load next batch
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const cancelled = { value: false };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadNotes(cancelled).catch(() => {});
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => {
      cancelled.value = true;
      observer.disconnect();
    };
  }, [hasMore, loadNotes]);



  // Keyboard: Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCardFlowOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCardFlowOpen]);

  const handleCardClick = useCallback(
    (note: CardNote) => {
      openNote(note.path, note.title);
      setCardFlowOpen(false);
    },
    [openNote, setCardFlowOpen]
  );

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-theme-border shrink-0">
        <span className="text-sm font-medium text-foreground">{t('cardFlow.title')}</span>
        <div className="flex items-center gap-2">
          {/* Filter input */}
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('cardFlow.filterPlaceholder')}
              className="pl-7 pr-3 py-1.5 text-xs bg-background border border-theme-border rounded text-foreground outline-none focus:ring-1 focus:ring-theme-accent w-48"
            />
          </div>
          {/* Sort toggle */}
          <button
            onClick={() => setSortMode((m) => (m === 'modified' ? 'name' : 'modified'))}
            className="flex items-center gap-1 px-2 py-1.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground hover:bg-theme-hover transition-colors"
            title={t('cardFlow.sortBy')}
          >
            <ArrowUpDown size={12} />
            {sortMode === 'modified' ? <Clock size={12} /> : <Type size={12} />}
          </button>
          {/* Close */}
          <button
            onClick={() => setCardFlowOpen(false)}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Card grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            {t('sidebar.loading')}
          </div>
        ) : displayedNotes.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            {t('cardFlow.noResults')}
          </div>
        ) : (
          <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-3 space-y-3">
            {displayedNotes.map((note) => (
              <NoteCard key={note.path} note={note} onClick={handleCardClick} />
            ))}
          </div>
        )}
        {/* Infinite scroll sentinel */}
        {hasMore && (
          <div ref={sentinelRef} className="h-8 flex items-center justify-center text-xs text-muted-foreground mt-4">
            {t('cardFlow.loadingMore')}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Note Card ───────────────────────────────────────────────

function NoteCard({ note, onClick }: { note: CardNote; onClick: (n: CardNote) => void }) {
  // Format relative time
  const timeAgo = useMemo(() => {
    if (!note.modified_at) return '';
    const delta = Date.now() - new Date(note.modified_at).getTime();
    const mins = Math.floor(delta / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    return `${Math.floor(days / 30)}mo`;
  }, [note.modified_at]);

  return (
    <button
      className="break-inside-avoid w-full text-left rounded-lg border border-theme-border bg-surface p-3 hover:border-theme-accent/50 hover:shadow-sm transition-all group"
      onClick={() => onClick(note)}
    >
      {/* Title */}
      <div className="flex items-start gap-1.5 mb-1.5">
        <FileText size={13} className="text-theme-accent shrink-0 mt-0.5" />
        <h3 className="text-sm font-medium text-foreground leading-tight group-hover:text-theme-accent transition-colors line-clamp-2">
          {note.title}
        </h3>
      </div>

      {/* Excerpt */}
      {note.excerpt && (
        <p className="text-xs text-muted-foreground line-clamp-4 mb-2 leading-relaxed">
          {note.excerpt}
        </p>
      )}

      {/* Tags */}
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {note.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded bg-theme-accent/10 text-theme-accent"
            >
              <Tag size={9} />
              {tag.replace('#', '')}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="truncate max-w-[70%]">{note.path}</span>
        <span>{timeAgo}</span>
      </div>
    </button>
  );
}
