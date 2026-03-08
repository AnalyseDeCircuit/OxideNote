import { useEffect, useState, useCallback } from 'react';
import { listAllTags, searchByTag, type TagCount, type SearchResult } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';
import { Tag, ChevronLeft } from 'lucide-react';

export function TagPanel() {
  const { t } = useTranslation();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [notes, setNotes] = useState<SearchResult[]>([]);

  const loadTags = useCallback(async () => {
    try {
      const result = await listAllTags();
      setTags(result);
    } catch (err) {
      console.warn('[tags] Failed to load tags:', err);
    }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  const handleTagClick = useCallback(async (tag: string) => {
    setSelectedTag(tag);
    try {
      const result = await searchByTag(tag);
      setNotes(result);
    } catch {
      setNotes([]);
    }
  }, []);

  const handleBack = useCallback(() => {
    setSelectedTag(null);
    setNotes([]);
  }, []);

  if (selectedTag) {
    return (
      <div className="p-3 text-sm">
        <button
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground mb-3 transition-colors"
          onClick={handleBack}
        >
          <ChevronLeft size={14} />
          <span className="text-xs">{t('tags.backToAll', '所有标签')}</span>
        </button>
        <h3 className="text-xs font-medium text-muted-foreground mb-2">
          #{selectedTag} ({notes.length})
        </h3>
        <div className="space-y-0.5">
          {notes.map((note) => (
            <button
              key={note.path}
              className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-theme-hover transition-colors truncate"
              onClick={() => useNoteStore.getState().openNote(note.path, note.title || note.path)}
            >
              {note.title || note.path}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground mb-2">{t('tags.title', '标签')}</h3>
      {tags.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('tags.empty', '暂无标签')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tc) => (
            <button
              key={tc.tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-theme-hover text-foreground hover:bg-theme-accent hover:text-white transition-colors"
              onClick={() => handleTagClick(tc.tag)}
            >
              <Tag size={10} />
              <span>{tc.tag}</span>
              <span className="text-muted-foreground">({tc.count})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
