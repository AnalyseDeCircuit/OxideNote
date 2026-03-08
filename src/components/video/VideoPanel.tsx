/**
 * VideoPanel — Side panel for watching Bilibili videos alongside notes
 *
 * Features:
 *   · URL/BV number input with auto-extraction
 *   · Embedded Bilibili player via iframe
 *   · Timestamp insertion into the editor
 */

import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Clock, Play } from 'lucide-react';
import { getEditorView } from '@/lib/editorViewRef';

interface VideoPanelProps {
  onClose: () => void;
}

/**
 * Extract BV ID from various Bilibili URL formats:
 *   - BV1xx411c7mD (direct BV number)
 *   - https://www.bilibili.com/video/BV1xx411c7mD
 *   - https://b23.tv/...
 */
function extractBvId(input: string): string | null {
  const trimmed = input.trim();

  // Direct BV number
  const bvMatch = trimmed.match(/^(BV[\w]+)$/i);
  if (bvMatch) return bvMatch[1];

  // URL with BV number
  const urlMatch = trimmed.match(/bilibili\.com\/video\/(BV[\w]+)/i);
  if (urlMatch) return urlMatch[1];

  return null;
}

export function VideoPanel({ onClose }: VideoPanelProps) {
  const { t } = useTranslation();
  const [urlInput, setUrlInput] = useState('');
  const [activeBvId, setActiveBvId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const startTimeRef = useRef<number>(Date.now());

  const handleOpen = useCallback(() => {
    const bvId = extractBvId(urlInput);
    if (bvId) {
      setActiveBvId(bvId);
      setError('');
      startTimeRef.current = Date.now();
    } else {
      setError(t('video.invalidUrl'));
    }
  }, [urlInput, t]);

  // Insert a manual timestamp [MM:SS] at the editor cursor position
  const handleInsertTimestamp = useCallback(() => {
    const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const timestamp = `[${mm}:${ss}] `;

    const view = getEditorView();
    if (!view) return;

    const { from } = view.state.selection.main;
    view.dispatch({
      changes: { from, to: from, insert: timestamp },
      selection: { anchor: from + timestamp.length },
    });
    view.focus();
  }, []);

  return (
    <div className="h-full flex flex-col bg-surface border-l border-theme-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <span className="text-sm font-medium text-foreground">{t('video.title')}</span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-theme-hover text-muted-foreground"
          title={t('video.close')}
        >
          <X size={14} />
        </button>
      </div>

      {/* URL input */}
      <div className="flex gap-2 px-3 py-2 border-b border-theme-border shrink-0">
        <input
          className="flex-1 min-w-0 bg-background text-foreground text-sm px-2 py-1 rounded border border-theme-border outline-none focus:border-theme-accent"
          placeholder={t('video.inputPlaceholder')}
          value={urlInput}
          onChange={(e) => { setUrlInput(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleOpen(); }}
        />
        <button
          onClick={handleOpen}
          className="px-3 py-1 rounded bg-theme-accent text-white text-sm hover:opacity-90 transition-opacity flex items-center gap-1"
        >
          <Play size={12} />
          {t('video.open')}
        </button>
      </div>

      {error && (
        <div className="px-3 py-1 text-xs text-red-400">{error}</div>
      )}

      {/* Video player */}
      {activeBvId ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0">
            <iframe
              src={`https://player.bilibili.com/player.html?bvid=${activeBvId}&autoplay=0&high_quality=1`}
              className="w-full h-full border-0"
              allow="fullscreen"
              sandbox="allow-scripts allow-same-origin allow-popups"
              title="Bilibili Player"
            />
          </div>
          {/* Timestamp toolbar */}
          <div className="flex items-center gap-2 px-3 py-2 border-t border-theme-border shrink-0">
            <button
              onClick={handleInsertTimestamp}
              className="flex items-center gap-1 px-3 py-1 rounded text-sm border border-theme-border hover:bg-theme-hover text-muted-foreground transition-colors"
            >
              <Clock size={12} />
              {t('video.insertTimestamp')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {t('video.inputPlaceholder')}
        </div>
      )}
    </div>
  );
}
