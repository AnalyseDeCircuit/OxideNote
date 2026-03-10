// Tag suggestion pills — shown after note save, powered by AI.
//
// Queries the backend `suggest_tags` command and shows dismissible pills.
// Clicking a tag inserts it into the note's frontmatter.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Sparkles, Loader2 } from 'lucide-react';
import { suggestTags, readNote, type ChatConfig } from '@/lib/api';
import { useChatStore } from '@/store/chatStore';
import { getEditorView } from '@/lib/editorViewRef';
import { toast } from '@/hooks/useToast';

interface TagSuggestionProps {
  /** Vault-relative path of the active note */
  path: string;
  /** Note title for context */
  title: string;
}

export function TagSuggestion({ path, title }: TagSuggestionProps) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const lastPathRef = useRef(path);

  // Reset state when switching notes
  useEffect(() => {
    if (path !== lastPathRef.current) {
      setTags([]);
      setDismissed(false);
      lastPathRef.current = path;
    }
  }, [path]);

  // Fetch tag suggestions
  const fetchSuggestions = useCallback(async () => {
    if (loading || dismissed) return;

    const config: ChatConfig = useChatStore.getState().config;
    if (!config.api_key && config.provider !== 'ollama') return;

    setLoading(true);
    try {
      const note = await readNote(path);
      if (!note.content || note.content.length < 50) return;

      // Extract existing tags from the note
      const existingTags = (note.content.match(/#[\w/-]+/g) ?? []).map(t => t.slice(1));
      const suggested = await suggestTags(note.content, title, existingTags, config);

      // Filter out tags that already exist in the note
      const novel = suggested.filter(tag =>
        !existingTags.some(e => e.toLowerCase() === tag.toLowerCase())
      );
      setTags(novel);
    } catch (err) {
      console.warn('Tag suggestion failed:', err);
    } finally {
      setLoading(false);
    }
  }, [path, title, loading, dismissed]);

  // Insert a tag into the editor at cursor position
  const handleAccept = useCallback((tag: string) => {
    const view = getEditorView();
    if (!view) return;

    const formatted = tag.startsWith('#') ? tag : `#${tag}`;
    const cursor = view.state.selection.main.head;
    view.dispatch({ changes: { from: cursor, insert: ` ${formatted}` } });

    // Remove the accepted tag from suggestions
    setTags(prev => prev.filter(t => t !== tag));
    toast({ title: t('smartTags.inserted', { count: 1 }) });
  }, [t]);

  // Dismiss a single tag
  const handleDismiss = useCallback((tag: string) => {
    setTags(prev => prev.filter(t => t !== tag));
  }, []);

  // Dismiss all
  const handleDismissAll = useCallback(() => {
    setDismissed(true);
    setTags([]);
  }, []);

  // Nothing to show
  if (tags.length === 0 && !loading) {
    return (
      <button
        onClick={fetchSuggestions}
        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        title={t('smartTags.suggest')}
      >
        <Sparkles size={10} />
        {t('smartTags.suggest')}
      </button>
    );
  }

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 size={10} className="animate-spin" />
        {t('smartTags.suggest')}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Sparkles size={10} className="text-theme-accent shrink-0" />
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 text-xs rounded-full bg-theme-accent/10 text-theme-accent hover:bg-theme-accent/20 transition-colors cursor-pointer"
        >
          <span onClick={() => handleAccept(tag)} className="select-none">
            #{tag}
          </span>
          <button
            onClick={() => handleDismiss(tag)}
            className="p-0.5 rounded-full hover:bg-theme-accent/30 transition-colors"
          >
            <X size={8} />
          </button>
        </span>
      ))}
      <button
        onClick={handleDismissAll}
        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        title={t('inlineAi.reject')}
      >
        <X size={10} />
      </button>
    </div>
  );
}
