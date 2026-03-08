import { useEffect, useState, useCallback, useMemo } from 'react';
import { listAllTags, searchByTag, type TagCount, type SearchResult } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';
import { Tag, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';

// ─── Tag tree node for hierarchical display ──────────────────

interface TagTreeNode {
  /** Leaf segment of the tag (e.g. "rust" in "dev/rust") */
  segment: string;
  /** Full tag path (e.g. "dev/rust") */
  fullTag: string;
  /** Aggregate note count (self + descendants) */
  count: number;
  /** Direct note count for this exact tag */
  selfCount: number;
  children: TagTreeNode[];
}

/** Build a tree structure from a flat list of tags */
function buildTagTree(tags: TagCount[]): TagTreeNode[] {
  const root: TagTreeNode[] = [];

  for (const { tag, count } of tags) {
    const parts = tag.split('/');
    let current = root;
    let pathSoFar = '';

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      let node = current.find((n) => n.segment === segment);
      if (!node) {
        node = { segment, fullTag: pathSoFar, count: 0, selfCount: 0, children: [] };
        current.push(node);
      }
      // Accumulate counts upward
      node.count += count;
      // Only the leaf gets the self count
      if (i === parts.length - 1) {
        node.selfCount = count;
      }
      current = node.children;
    }
  }

  return root;
}

export function TagPanel() {
  const { t } = useTranslation();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [notes, setNotes] = useState<SearchResult[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tagTree = useMemo(() => buildTagTree(tags), [tags]);

  const loadTags = useCallback(async () => {
    try {
      const result = await listAllTags();
      setTags(result);
    } catch (err) {
      console.warn('[tags] Failed to load tags:', err);
    }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  // Select a tag: search with hierarchical matching
  const handleTagClick = useCallback(async (tag: string) => {
    setSelectedTag(tag);
    try {
      const result = await searchByTag(tag, true);
      setNotes(result);
    } catch {
      setNotes([]);
    }
  }, []);

  const handleBack = useCallback(() => {
    setSelectedTag(null);
    setNotes([]);
  }, []);

  const toggleExpand = useCallback((tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  // Render a tag tree node recursively
  const renderNode = useCallback((node: TagTreeNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.fullTag);

    return (
      <div key={node.fullTag}>
        <div
          className="flex items-center gap-1 px-2 py-1 rounded text-sm hover:bg-theme-hover transition-colors cursor-pointer group"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => handleTagClick(node.fullTag)}
        >
          {hasChildren ? (
            <button
              onClick={(e) => toggleExpand(node.fullTag, e)}
              className="p-0.5 text-muted-foreground hover:text-foreground shrink-0"
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <Tag size={10} className="text-muted-foreground shrink-0" />
          <span className="truncate">{node.segment}</span>
          <span className="text-muted-foreground text-[10px] ml-auto shrink-0">
            {node.count}
          </span>
        </div>
        {hasChildren && isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }, [expanded, handleTagClick, toggleExpand]);

  // Detail view: showing notes for a selected tag
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
        <div className="space-y-0.5">
          {tagTree.map((node) => renderNode(node, 0))}
        </div>
      )}
    </div>
  );
}
