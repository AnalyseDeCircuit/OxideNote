import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { History, RotateCcw, Diff } from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';
import {
  listNoteHistory,
  diffWithCurrent,
  restoreSnapshot,
  readHistorySnapshot,
  type HistoryEntry,
  type DiffChunk,
} from '@/lib/api';
import { toast } from '@/hooks/useToast';
import { confirm } from '@tauri-apps/plugin-dialog';

// ── Time formatting helper ──────────────────────────────────

function formatRelativeTime(timestampMs: number): string {
  const delta = Date.now() - timestampMs;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Main component ──────────────────────────────────────────

export function HistoryPanel() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const openNote = useNoteStore((s) => s.openNote);

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffChunk[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Load history list when active note changes
  const loadHistory = useCallback(() => {
    if (!activeTabPath) {
      setEntries([]);
      setSelectedId(null);
      setDiff(null);
      return;
    }

    setLoading(true);
    listNoteHistory(activeTabPath)
      .then((list) => {
        setEntries(list);
        setSelectedId(null);
        setDiff(null);
      })
      .catch((err) => {
        console.warn('[history] load failed', err);
        setEntries([]);
      })
      .finally(() => setLoading(false));
  }, [activeTabPath]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Load diff for a selected snapshot
  const handleViewDiff = useCallback(
    (entry: HistoryEntry) => {
      if (!activeTabPath) return;
      setSelectedId(entry.id);
      setDiffLoading(true);
      diffWithCurrent(activeTabPath, entry.id)
        .then(setDiff)
        .catch((err) => {
          console.warn('[history] diff failed', err);
          setDiff(null);
        })
        .finally(() => setDiffLoading(false));
    },
    [activeTabPath],
  );

  // Restore a snapshot
  const handleRestore = useCallback(
    async (entry: HistoryEntry) => {
      if (!activeTabPath) return;
      const confirmed = await confirm(t('history.restoreConfirm'), {
        title: t('history.restore'),
        kind: 'warning',
      });
      if (!confirmed) return;

      try {
        await restoreSnapshot(activeTabPath, entry.id);
        toast({ title: t('history.restored') });
        // Reload the note in the editor
        const title = activeTabPath.split('/').pop()?.replace('.md', '') ?? activeTabPath;
        openNote(activeTabPath, title);
        loadHistory();
      } catch (err) {
        toast({ title: t('history.restoreFailed'), variant: 'error' });
      }
    },
    [activeTabPath, t, openNote, loadHistory],
  );

  if (!activeTabPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('backlinks.noNote')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Snapshot list */}
      <div className={`overflow-y-auto p-2 ${diff ? 'max-h-[40%] shrink-0 border-b border-theme-border' : 'flex-1'}`}>
        {loading ? (
          <div className="p-2 text-sm text-muted-foreground">{t('sidebar.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">{t('history.empty')}</div>
        ) : (
          <ul className="space-y-0.5">
            {entries.map((entry) => (
              <li key={entry.id}>
                <div
                  className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors cursor-pointer
                    ${selectedId === entry.id ? 'bg-theme-accent/15 text-theme-accent' : 'hover:bg-theme-hover text-foreground'}`}
                  onClick={() => handleViewDiff(entry)}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5 text-muted-foreground" />
                      {t('history.timeAgo', { time: formatRelativeTime(entry.timestamp) })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatSize(entry.size)}
                    </span>
                  </div>
                  <div className="flex mt-1 gap-1">
                    <button
                      className="text-xs px-1.5 py-0.5 rounded bg-theme-hover hover:bg-theme-accent/20 text-muted-foreground hover:text-theme-accent transition-colors flex items-center gap-0.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewDiff(entry);
                      }}
                      title={t('history.diff')}
                    >
                      <Diff className="w-3 h-3" />
                      {t('history.diff')}
                    </button>
                    <button
                      className="text-xs px-1.5 py-0.5 rounded bg-theme-hover hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors flex items-center gap-0.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRestore(entry);
                      }}
                      title={t('history.restore')}
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t('history.restore')}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Diff viewer */}
      {diff && (
        <div className="flex-1 min-h-0 overflow-y-auto p-2 font-mono text-xs leading-relaxed">
          {diffLoading ? (
            <div className="p-2 text-sm text-muted-foreground">{t('sidebar.loading')}</div>
          ) : (
            diff.map((chunk, i) => (
              <span
                key={i}
                className={
                  chunk.tag === 'insert'
                    ? 'bg-green-500/20 text-green-300'
                    : chunk.tag === 'delete'
                      ? 'bg-red-500/20 text-red-300 line-through'
                      : 'text-muted-foreground'
                }
              >
                {chunk.value}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}
