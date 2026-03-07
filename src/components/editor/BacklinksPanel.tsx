import { useEffect, useState } from 'react';
import { getBacklinks, type BacklinkResult } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';

export function BacklinksPanel() {
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const [backlinks, setBacklinks] = useState<BacklinkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (!activeTabPath) {
      setBacklinks([]);
      return;
    }

    setLoading(true);
    getBacklinks(activeTabPath)
      .then(setBacklinks)
      .catch((err) => {
        // Non-fatal: show empty list but log for debugging.
        // Common cause: note was just deleted or index is stale.
        console.warn('[backlinks] query failed for', activeTabPath, err);
        setBacklinks([]);
      })
      .finally(() => setLoading(false));
  }, [activeTabPath]);

  const openNote = useNoteStore((s) => s.openNote);

  if (!activeTabPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('backlinks.noNote')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-2 text-sm text-muted-foreground">{t('backlinks.loading')}</div>
        ) : backlinks.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">{t('backlinks.empty')}</div>
        ) : (
          <ul className="space-y-1">
            {backlinks.map((bl) => (
              <li key={bl.path}>
                <button
                  onClick={() => openNote(bl.path, bl.title || bl.path)}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-theme-hover transition-colors truncate text-foreground"
                  title={bl.path}
                >
                  <span className="text-theme-accent mr-1.5">←</span>
                  {bl.title || bl.path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
