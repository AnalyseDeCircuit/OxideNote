import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, RotateCcw, XCircle, Folder, FileText } from 'lucide-react';
import {
  listTrash,
  restoreFromTrash,
  permanentDelete,
  emptyTrash,
  type TrashEntry,
} from '@/lib/api';
import { toast } from '@/hooks/useToast';
import { confirm } from '@tauri-apps/plugin-dialog';

// ── Time formatting ─────────────────────────────────────────

function formatDeletedAt(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

// ── Props ───────────────────────────────────────────────────

interface TrashViewProps {
  onClose: () => void;
}

// ── Main component ──────────────────────────────────────────

export function TrashView({ onClose }: TrashViewProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadTrash = useCallback(() => {
    setLoading(true);
    listTrash()
      .then(setEntries)
      .catch((err) => {
        console.warn('[trash] load failed', err);
        setEntries([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadTrash();
  }, [loadTrash]);

  // Restore a single item
  const handleRestore = useCallback(
    async (entry: TrashEntry) => {
      const name = entry.original_path.split('/').pop() ?? entry.original_path;
      try {
        await restoreFromTrash(entry.id);
        toast({ title: t('trash.restored', { name }) });
        loadTrash();
      } catch {
        toast({ title: t('trash.restoreFailed'), variant: 'error' });
      }
    },
    [t, loadTrash],
  );

  // Permanently delete a single item
  const handlePermanentDelete = useCallback(
    async (entry: TrashEntry) => {
      const name = entry.original_path.split('/').pop() ?? entry.original_path;
      const confirmed = await confirm(t('trash.permanentDeleteConfirm', { name }), {
        title: t('trash.permanentDelete'),
        kind: 'warning',
      });
      if (!confirmed) return;

      try {
        await permanentDelete(entry.id);
        toast({ title: t('trash.deleted') });
        loadTrash();
      } catch {
        toast({ title: t('trash.deleteFailed'), variant: 'error' });
      }
    },
    [t, loadTrash],
  );

  // Empty all trash
  const handleEmptyTrash = useCallback(async () => {
    const confirmed = await confirm(t('trash.emptyTrashConfirm'), {
      title: t('trash.emptyTrash'),
      kind: 'warning',
    });
    if (!confirmed) return;

    try {
      await emptyTrash();
      toast({ title: t('trash.emptied') });
      setEntries([]);
    } catch {
      toast({ title: t('trash.emptyFailed'), variant: 'error' });
    }
  }, [t]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <div className="flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('trash.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          {entries.length > 0 && (
            <button
              className="text-xs px-2 py-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors"
              onClick={handleEmptyTrash}
            >
              {t('trash.emptyTrash')}
            </button>
          )}
          <button
            className="text-xs px-2 py-1 rounded hover:bg-theme-hover text-muted-foreground transition-colors"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Retention note */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-theme-border">
        {t('trash.retentionNote')}
      </div>

      {/* Trash list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-2 text-sm text-muted-foreground">{t('sidebar.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">{t('trash.empty')}</div>
        ) : (
          <ul className="space-y-1">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="px-2 py-2 rounded hover:bg-theme-hover transition-colors group"
              >
                <div className="flex items-start gap-2">
                  {entry.is_dir ? (
                    <Folder className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  ) : (
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate" title={entry.original_path}>
                      {entry.original_path}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {t('trash.deletedAt', { time: formatDeletedAt(entry.deleted_at) })}
                    </div>
                  </div>
                </div>
                {/* Action buttons — visible on hover */}
                <div className="flex gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    className="text-xs px-2 py-0.5 rounded bg-theme-hover hover:bg-theme-accent/20 text-muted-foreground hover:text-theme-accent transition-colors flex items-center gap-1"
                    onClick={() => handleRestore(entry)}
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('trash.restore')}
                  </button>
                  <button
                    className="text-xs px-2 py-0.5 rounded bg-theme-hover hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors flex items-center gap-1"
                    onClick={() => handlePermanentDelete(entry)}
                  >
                    <XCircle className="w-3 h-3" />
                    {t('trash.permanentDelete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
