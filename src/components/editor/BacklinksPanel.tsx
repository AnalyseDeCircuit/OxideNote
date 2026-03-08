import { useEffect, useState, useMemo } from 'react';
import { getBacklinks, getBlockBacklinks, type BacklinkResult } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';
import { Boxes } from 'lucide-react';

// ── Block ID detection helper ──────────────────────────────
// Extracts ^blockId from the line at cursor position (1-based cursorLine)
function detectBlockId(content: string, cursorLine: number): string | null {
  const lines = content.split('\n');
  const idx = cursorLine - 1; // 0-based
  if (idx < 0 || idx >= lines.length) return null;
  const match = lines[idx].match(/\s+\^([a-zA-Z0-9_-]+)\s*$/);
  return match ? match[1] : null;
}

export function BacklinksPanel() {
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const activeContent = useNoteStore((s) => s.activeContent);
  const cursorLine = useNoteStore((s) => s.cursorLine);
  const [backlinks, setBacklinks] = useState<BacklinkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();

  // Detect if cursor is on a block ID line
  const blockId = useMemo(
    () => detectBlockId(activeContent, cursorLine),
    [activeContent, cursorLine],
  );

  useEffect(() => {
    if (!activeTabPath) {
      setBacklinks([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const fetchBacklinks = blockId
      ? getBlockBacklinks(activeTabPath, blockId)
      : getBacklinks(activeTabPath);

    fetchBacklinks
      .then((result) => {
        if (!cancelled) setBacklinks(result);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[backlinks] query failed for', activeTabPath, err);
          setBacklinks([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeTabPath, blockId]);

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
      {/* Block context indicator */}
      {blockId && (
        <div className="px-3 py-1.5 border-b border-theme-border flex items-center gap-1.5 text-xs text-theme-accent bg-theme-accent/5">
          <Boxes size={12} />
          <span className="font-mono">^{blockId}</span>
          <span className="text-muted-foreground">{t('backlinks.blockMode')}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-2 text-sm text-muted-foreground">{t('backlinks.loading')}</div>
        ) : backlinks.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">
            {blockId ? t('backlinks.blockEmpty') : t('backlinks.empty')}
          </div>
        ) : (
          <ul className="space-y-1">
            {backlinks.map((bl) => (
              <li key={bl.path}>
                <button
                  onClick={() => openNote(bl.path, bl.title || bl.path)}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-theme-hover transition-colors text-foreground"
                  title={bl.path}
                >
                  <span className="text-theme-accent mr-1.5">←</span>
                  {bl.title || bl.path}
                  {bl.snippet && (
                    <p className="mt-0.5 text-xs text-muted-foreground truncate">
                      {bl.snippet}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
