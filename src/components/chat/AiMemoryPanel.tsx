/**
 * AiMemoryPanel — manage persistent AI memory entries.
 *
 * Memories are injected into the system prompt for every chat conversation,
 * allowing the AI to retain context across sessions. Users can add, pin,
 * and delete memory entries organized by category.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Pin, X } from 'lucide-react';
import {
  listAiMemories,
  addAiMemory,
  deleteAiMemory,
  toggleAiMemoryPin,
  type AiMemory,
} from '@/lib/api';
import { toast } from '@/hooks/useToast';

// Predefined categories for organizing memories
const CATEGORIES = ['general', 'preference', 'style', 'context', 'instruction'] as const;

interface AiMemoryPanelProps {
  onClose: () => void;
}

export function AiMemoryPanel({ onClose }: AiMemoryPanelProps) {
  const { t } = useTranslation();
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<string>('general');
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load memories on mount
  useEffect(() => {
    listAiMemories()
      .then(setMemories)
      .catch((err) => console.warn('[memory] Failed to load:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleAdd = useCallback(async () => {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    try {
      const memory = await addAiMemory(trimmed, newCategory);
      setMemories((prev) => [memory, ...prev]);
      setNewContent('');
      inputRef.current?.focus();
    } catch (err) {
      toast({ variant: 'error', title: String(err) });
    }
  }, [newContent, newCategory]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await deleteAiMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      toast({ variant: 'error', title: String(err) });
    }
  }, []);

  const handleTogglePin = useCallback(async (id: number) => {
    // Optimistic update
    setMemories((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, pinned: !m.pinned } : m
      ).sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.created_at - a.created_at;
      })
    );
    try {
      await toggleAiMemoryPin(id);
    } catch (err) {
      // Rollback on failure
      setMemories((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, pinned: !m.pinned } : m
        ).sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.created_at - a.created_at;
        })
      );
      toast({ variant: 'error', title: String(err) });
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border">
        <span className="text-xs font-medium text-foreground">
          {t('memory.title')}
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-theme-hover text-muted-foreground"
        >
          <X size={14} />
        </button>
      </div>

      {/* Description */}
      <div className="px-3 py-2 text-[11px] text-muted-foreground border-b border-theme-border">
        {t('memory.description')}
      </div>

      {/* Add new memory */}
      <div className="px-3 py-2 border-b border-theme-border space-y-1.5">
        <div className="flex gap-1.5">
          <input
            ref={inputRef}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder={t('memory.placeholder')}
            maxLength={500}
            className="flex-1 text-xs px-2 py-1 rounded border border-theme-border bg-background
                       text-foreground placeholder:text-muted-foreground focus:outline-none
                       focus:border-theme-accent"
          />
          <button
            onClick={handleAdd}
            disabled={!newContent.trim()}
            className="p-1 rounded bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25
                       disabled:opacity-40 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        <select
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          className="text-[11px] px-1.5 py-0.5 rounded border border-theme-border bg-background
                     text-foreground"
        >
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`memory.category.${cat}`)}
            </option>
          ))}
        </select>
      </div>

      {/* Memory list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            {t('memory.loading')}
          </div>
        ) : memories.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            {t('memory.empty')}
          </div>
        ) : (
          <div className="divide-y divide-theme-border">
            {memories.map((m) => (
              <div
                key={m.id}
                className="px-3 py-2 hover:bg-theme-hover/50 transition-colors group"
              >
                <div className="flex items-start gap-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground break-words">{m.content}</p>
                    <span className="text-[10px] text-muted-foreground">
                      {t(`memory.category.${m.category}`, m.category)}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleTogglePin(m.id)}
                      className={`p-0.5 rounded transition-colors ${
                        m.pinned
                          ? 'text-theme-accent'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title={t('memory.pin')}
                    >
                      <Pin size={12} />
                    </button>
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="p-0.5 rounded text-muted-foreground hover:text-red-500 transition-colors"
                      title={t('memory.delete')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
