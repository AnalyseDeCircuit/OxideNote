/**
 * BrowserPanel — Simple URL input panel for in-app browsing
 *
 * Opens URLs in a new Tauri webview window or the system's default browser.
 * Maintains a session history of visited URLs.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowserWindow } from '@/lib/api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from '@/hooks/useToast';

interface BrowserPanelProps {
  onClose: () => void;
}

export function BrowserPanel({ onClose }: BrowserPanelProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [history, setHistory] = useState<string[]>([]);

  // Normalize URL — add https:// if no scheme
  const normalizeUrl = useCallback((input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }, []);

  // Open URL in a new Tauri webview window
  const handleOpen = useCallback(async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;

    try {
      await openBrowserWindow(normalized);
      // Add to history (deduplicate)
      setHistory((prev) => [normalized, ...prev.filter((u) => u !== normalized)].slice(0, 20));
      setUrl('');
    } catch (err) {
      toast({ title: t('browser.invalidUrl'), description: String(err), variant: 'error' });
    }
  }, [url, normalizeUrl, t]);

  // Open URL in system default browser
  const handleOpenExternal = useCallback(async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    try {
      await openUrl(normalized);
      setHistory((prev) => [normalized, ...prev.filter((u) => u !== normalized)].slice(0, 20));
      setUrl('');
    } catch (err) {
      toast({ title: t('browser.invalidUrl'), description: String(err), variant: 'error' });
    }
  }, [url, normalizeUrl, t]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <span className="text-xs font-medium text-foreground">{t('browser.title')}</span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ✕
        </button>
      </div>

      {/* URL input */}
      <div className="flex gap-1 px-3 py-2 border-b border-theme-border">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('browser.urlPlaceholder')}
          className="flex-1 px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground outline-none focus:border-theme-accent"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleOpen();
          }}
        />
        <button
          onClick={handleOpen}
          className="px-2 py-1 text-xs rounded bg-theme-accent text-white hover:opacity-90"
          title={t('browser.open')}
        >
          {t('browser.open')}
        </button>
        <button
          onClick={handleOpenExternal}
          className="px-2 py-1 text-xs rounded border border-theme-border hover:bg-theme-hover text-muted-foreground"
          title={t('browser.openExternal')}
        >
          ↗
        </button>
      </div>

      {/* History */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {history.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">
            {t('browser.urlPlaceholder')}
          </div>
        ) : (
          <div className="space-y-1">
            {history.map((histUrl, i) => (
              <button
                key={i}
                onClick={() => setUrl(histUrl)}
                onDoubleClick={async () => {
                  try {
                    await openBrowserWindow(histUrl);
                  } catch (err) {
                    toast({ title: t('browser.invalidUrl'), description: String(err), variant: 'error' });
                  }
                }}
                className="w-full text-left px-2 py-1 text-xs rounded hover:bg-theme-hover text-foreground truncate"
              >
                {histUrl}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
