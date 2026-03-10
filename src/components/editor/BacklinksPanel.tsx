import { useEffect, useState, useMemo, useCallback } from 'react';
import { getBacklinks, getBlockBacklinks, suggestLinks, getGraphData, type BacklinkResult } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useChatStore } from '@/store/chatStore';
import { useTranslation } from 'react-i18next';
import { Boxes, Sparkles, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

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

  // Potential links state
  const [potentialLinks, setPotentialLinks] = useState<string[]>([]);
  const [potentialLoading, setPotentialLoading] = useState(false);
  const [potentialExpanded, setPotentialExpanded] = useState(false);

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

  // Fetch AI-suggested potential links
  const handleFetchPotential = useCallback(async () => {
    if (!activeTabPath || !activeContent) return;
    setPotentialLoading(true);
    setPotentialExpanded(true);
    try {
      const config = useChatStore.getState().config;
      // Get all vault note titles via graph data for comprehensive coverage
      const graphData = await getGraphData();
      const allTitles = graphData.nodes.map((n) => n.title).filter(Boolean);
      const noteTitle = activeTabPath.replace(/\.md$/, '').split('/').pop() ?? '';
      const results = await suggestLinks(activeContent, noteTitle, allTitles, config);
      setPotentialLinks(results);
    } catch (err) {
      console.warn('[backlinks] potential links failed:', err);
      setPotentialLinks([]);
    } finally {
      setPotentialLoading(false);
    }
  }, [activeTabPath, activeContent]);

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

      {/* Potential links section (AI-suggested) */}
      <div className="border-t border-theme-border">
        <button
          onClick={() => {
            if (!potentialExpanded && potentialLinks.length === 0) {
              handleFetchPotential();
            } else {
              setPotentialExpanded((v) => !v);
            }
          }}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:bg-theme-hover transition-colors"
        >
          <Sparkles size={12} />
          <span className="font-medium">{t('backlinks.potentialLinks')}</span>
          <div className="flex-1" />
          {potentialLoading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : potentialExpanded ? (
            <ChevronUp size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
        </button>
        {potentialExpanded && (
          <div className="px-2 pb-2">
            {potentialLinks.length === 0 && !potentialLoading ? (
              <div className="p-2 text-xs text-muted-foreground">{t('backlinks.noPotential')}</div>
            ) : (
              <ul className="space-y-0.5">
                {potentialLinks.map((link) => (
                  <li key={link}>
                    <button
                      onClick={() => openNote(link.endsWith('.md') ? link : `${link}.md`, link)}
                      className="w-full text-left px-2 py-1 text-xs rounded hover:bg-theme-hover transition-colors text-foreground"
                    >
                      <ChevronDown size={10} className="inline text-theme-accent mr-1 -rotate-90" />
                      {link}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
