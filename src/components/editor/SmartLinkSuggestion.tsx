// Smart link suggestion pills — powered by AI.
//
// Uses the `suggest_links` backend command to recommend WikiLinks
// based on note content. Clicking a link inserts it at cursor position.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Link2, Loader2 } from 'lucide-react';
import { suggestLinks, readNote, type ChatConfig } from '@/lib/api';
import { useChatStore } from '@/store/chatStore';
import { useNoteStore } from '@/store/noteStore';
import { getEditorView } from '@/lib/editorViewRef';
import { toast } from '@/hooks/useToast';
import { stripNoteExtension } from '@/lib/utils';

interface SmartLinkSuggestionProps {
  /** Vault-relative path of the active note */
  path: string;
  /** Note title for context */
  title: string;
}

export function SmartLinkSuggestion({ path, title }: SmartLinkSuggestionProps) {
  const { t } = useTranslation();
  const [links, setLinks] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const lastPathRef = useRef(path);

  // Reset on note switch
  useEffect(() => {
    if (path !== lastPathRef.current) {
      setLinks([]);
      setDismissed(false);
      lastPathRef.current = path;
    }
  }, [path]);

  // Fetch link suggestions from AI
  const fetchSuggestions = useCallback(async () => {
    if (loading || dismissed) return;

    const config: ChatConfig = useChatStore.getState().config;
    if (!config.api_key && config.provider !== 'ollama') return;

    setLoading(true);
    try {
      const note = await readNote(path);
      if (!note.content || note.content.length < 50) return;

      // Gather all note titles in the vault for context
      const openTabs = useNoteStore.getState().openTabs;
      const allTitles = openTabs.map((tab: { path: string }) => stripNoteExtension(tab.path).split('/').pop() ?? '').filter(Boolean);

      const suggested = await suggestLinks(note.content, title, allTitles, config);

      // Filter out links that already exist in the note
      const existing = note.content.match(/\[\[([^\]]+)\]\]/g)?.map(m => m.slice(2, -2).toLowerCase()) ?? [];
      const novel = suggested.filter(link =>
        !existing.some(e => e === link.toLowerCase())
      );
      setLinks(novel);
    } catch (err) {
      console.warn('Link suggestion failed:', err);
    } finally {
      setLoading(false);
    }
  }, [path, title, loading, dismissed]);

  // Insert a WikiLink at cursor
  const handleAccept = useCallback((link: string) => {
    const view = getEditorView();
    if (!view) return;

    const wikilink = `[[${link}]]`;
    const cursor = view.state.selection.main.head;
    view.dispatch({ changes: { from: cursor, insert: ` ${wikilink}` } });

    setLinks(prev => prev.filter(l => l !== link));
    toast({ title: t('smartLinks.inserted', { count: 1 }) });
  }, [t]);

  const handleDismiss = useCallback((link: string) => {
    setLinks(prev => prev.filter(l => l !== link));
  }, []);

  const handleDismissAll = useCallback(() => {
    setDismissed(true);
    setLinks([]);
  }, []);

  if (links.length === 0 && !loading) {
    return (
      <button
        onClick={fetchSuggestions}
        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        title={t('smartLinks.suggest')}
      >
        <Link2 size={10} />
        {t('smartLinks.suggest')}
      </button>
    );
  }

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 size={10} className="animate-spin" />
        {t('smartLinks.suggest')}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Link2 size={10} className="text-theme-accent shrink-0" />
      {links.map((link) => (
        <span
          key={link}
          className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 text-xs rounded-full bg-theme-accent/10 text-theme-accent hover:bg-theme-accent/20 transition-colors cursor-pointer"
        >
          <span onClick={() => handleAccept(link)} className="select-none">
            [[{link}]]
          </span>
          <button
            onClick={() => handleDismiss(link)}
            className="p-0.5 rounded-full hover:bg-theme-accent/30 transition-colors"
          >
            <X size={8} />
          </button>
        </span>
      ))}
      <button
        onClick={handleDismissAll}
        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
      >
        <X size={10} />
      </button>
    </div>
  );
}
