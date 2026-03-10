import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';
import {
  listBookmarks,
  removeBookmark,
  type BookmarkEntry,
} from '@/lib/api';
import { toast } from '@/hooks/useToast';

// ── Main component ──────────────────────────────────────────
// Collapsible section displayed above the file tree in the left sidebar.

export function BookmarkList() {
  const { t } = useTranslation();
  const openNote = useNoteStore((s) => s.openNote);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const loadBookmarks = useCallback(() => {
    listBookmarks()
      .then(setBookmarks)
      .catch((err) => {
        console.warn('[bookmarks] load failed', err);
        setBookmarks([]);
      });
  }, []);

  // Reload when vault changes or on mount
  useEffect(() => {
    loadBookmarks();

    // Listen for bookmark-change events to refresh the list
    const handler = () => loadBookmarks();
    window.addEventListener('bookmarks:changed', handler);
    return () => window.removeEventListener('bookmarks:changed', handler);
  }, [loadBookmarks]);

  const handleRemove = useCallback(
    async (path: string) => {
      try {
        await removeBookmark(path);
        toast({ title: t('bookmarks.removed') });
        loadBookmarks();
        window.dispatchEvent(new Event('bookmarks:changed'));
      } catch {
        toast({ title: t('bookmarks.removeFailed'), variant: 'error' });
      }
    },
    [t, loadBookmarks],
  );

  // Don't render if no bookmarks
  if (bookmarks.length === 0) return null;

  return (
    <div className="border-b border-theme-border">
      {/* Toggle header */}
      <button
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
        <Star className="w-3.5 h-3.5 text-yellow-500" />
        {t('bookmarks.title')}
        <span className="ml-auto text-muted-foreground">{bookmarks.length}</span>
      </button>

      {/* Bookmark items */}
      {!collapsed && (
        <ul className="pb-1">
          {bookmarks.map((bm) => {
            const name = bm.path.split('/').pop()?.replace(/\.(md|typ|tex)$/, '') ?? bm.path;
            return (
              <li key={bm.path} className="group">
                <button
                  className="w-full flex items-center gap-2 px-4 py-1 text-sm text-foreground hover:bg-theme-hover transition-colors"
                  onClick={() => openNote(bm.path, name)}
                >
                  <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{name}</span>
                  {/* Remove button — visible on hover */}
                  <Star
                    className="w-3.5 h-3.5 text-yellow-500 shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-yellow-300"
                    fill="currentColor"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(bm.path);
                    }}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
