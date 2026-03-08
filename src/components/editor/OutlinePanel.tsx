/**
 * OutlinePanel — Document outline & block reference panel
 *
 * Extracts heading hierarchy from current note's Markdown content
 * to build a navigable TOC (Table of Contents) tree.
 *
 * Also extracts ^blockId markers for drag-and-drop to canvas.
 *
 * Extraction strategy:
 *   · Regex-match ATX heading syntax (# ~ ######)
 *   · Skip # inside fenced code blocks
 *   · Level indentation via paddingLeft
 *   · Block IDs matched via ^block-id pattern at line end
 *
 * Clicking a heading scrolls the editor to that line.
 * Block items are draggable — drop onto canvas to create linked cards.
 */

import { useMemo, useCallback } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { useTranslation } from 'react-i18next';
import { EditorView } from '@codemirror/view';
import { getEditorView } from '@/lib/editorViewRef';
import { Boxes } from 'lucide-react';

// ── 标题条目类型 ────────────────────────────────────────────
interface HeadingItem {
  /** 标题层级 1~6 */
  level: number;
  /** 标题文本 */
  text: string;
  /** 在源文档中的行号（0-based） */
  line: number;
}

/**
 * 从 Markdown 源文本中提取标题列表
 *
 * 规则：
 *   · 跳过围栏代码块内的行 (``` / ~~~)
 *   · 匹配 ATX 标题格式：^#{1,6}\s+(.*)$
 */
function extractHeadings(content: string): HeadingItem[] {
  const lines = content.split('\n');
  const headings: HeadingItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测围栏代码块边界
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // 匹配 ATX 标题
    const match = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i,
      });
    }
  }

  return headings;
}

// ── Block reference item type ──────────────────────────────
interface BlockItem {
  /** Block ID (without the ^ prefix) */
  blockId: string;
  /** Content of the line/paragraph containing the block ID */
  content: string;
  /** Line number in source document (0-based) */
  line: number;
}

/**
 * Extract block IDs from Markdown source text
 *
 * Rules:
 *   · Skip fenced code blocks
 *   · Match ^block-id at end of line: \s+\^([a-zA-Z0-9_-]+)\s*$
 *   · Capture remaining line content (without the ^id marker)
 */
function extractBlocks(contentStr: string): BlockItem[] {
  const lines = contentStr.split('\n');
  const blocks: BlockItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match ^block-id at line end
    const match = line.match(/\s+\^([a-zA-Z0-9_-]+)\s*$/);
    if (match) {
      const blockId = match[1];
      // Remove the ^id marker to get the clean content
      const content = line.replace(/\s+\^[a-zA-Z0-9_-]+\s*$/, '').trim();
      blocks.push({ blockId, content, line: i });
    }
  }

  return blocks;
}

// ═══════════════════════════════════════════════════════════════
// OutlinePanel component
// ═══════════════════════════════════════════════════════════════

export function OutlinePanel() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);

  // 根据是否有打开的笔记显示不同状态
  if (!activeTabPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('outline.noNote')}
      </div>
    );
  }

  return <OutlinePanelContent />;
}

/**
 * Inner component: reads current note content and renders outline + blocks.
 *
 * Reactively updates when editor content changes via noteStore.
 */
function OutlinePanelContent() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const headings = useEditorHeadings();
  const blocks = useEditorBlocks();

  const hasContent = headings.length > 0 || blocks.length > 0;

  if (!hasContent) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('outline.empty')}
      </div>
    );
  }

  // Compute minimum heading level for relative indentation
  const minLevel = headings.length > 0
    ? Math.min(...headings.map((h) => h.level))
    : 1;

  return (
    <div className="flex-1 overflow-y-auto py-2">
      {/* Heading outline */}
      {headings.length > 0 && (
        <ul className="space-y-0.5">
          {headings.map((heading, idx) => (
            <li key={`h-${heading.line}-${idx}`}>
              <button
                className="w-full text-left px-3 py-1 text-[13px] truncate hover:bg-theme-hover transition-colors text-foreground/80 hover:text-foreground"
                style={{ paddingLeft: `${(heading.level - minLevel) * 16 + 12}px` }}
                onClick={() => scrollToLine(heading.line, heading.text)}
                title={heading.text}
              >
                <span className="text-theme-accent mr-1.5 text-xs font-mono opacity-50">
                  {'#'.repeat(heading.level)}
                </span>
                {heading.text}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Block references — draggable to canvas */}
      {blocks.length > 0 && (
        <div className="mt-3 border-t border-theme-border pt-2">
          <div className="px-3 pb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
            <Boxes size={12} />
            {t('outline.blocks')}
          </div>
          <ul className="space-y-0.5">
            {blocks.map((block) => (
              <BlockDragItem
                key={block.blockId}
                block={block}
                notePath={activeTabPath || ''}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Draggable block reference item.
 * Sets `application/x-oxide-block` drag data for canvas drop.
 */
function BlockDragItem({ block, notePath }: { block: BlockItem; notePath: string }) {
  const handleDragStart = useCallback((e: React.DragEvent) => {
    const dragData = JSON.stringify({
      notePath,
      blockId: block.blockId,
      content: block.content,
    });
    e.dataTransfer.setData('application/x-oxide-block', dragData);
    e.dataTransfer.effectAllowed = 'copy';
  }, [notePath, block.blockId, block.content]);

  return (
    <li>
      <button
        className="w-full text-left px-3 py-1 text-[13px] truncate hover:bg-theme-hover transition-colors text-foreground/80 hover:text-foreground cursor-grab active:cursor-grabbing"
        draggable
        onDragStart={handleDragStart}
        onClick={() => scrollToLine(block.line, '')}
        title={`^${block.blockId}: ${block.content}`}
      >
        <span className="text-theme-accent mr-1.5 text-xs font-mono opacity-50">^</span>
        <span className="font-mono text-xs text-theme-accent/70 mr-1.5">{block.blockId}</span>
        {block.content && (
          <span className="text-foreground/50 text-xs">{block.content}</span>
        )}
      </button>
    </li>
  );
}

// ── Reactive heading + block extraction from noteStore ──────

function useEditorHeadings(): HeadingItem[] {
  const activeContent = useNoteStore((s) => s.activeContent);
  return useMemo(() => extractHeadings(activeContent), [activeContent]);
}

function useEditorBlocks(): BlockItem[] {
  const activeContent = useNoteStore((s) => s.activeContent);
  return useMemo(() => extractBlocks(activeContent), [activeContent]);
}

// ── Scroll editor/preview to a specific line ────────────────
// Edit mode: scroll CodeMirror to line
// Preview mode: locate matching heading in preview panel

function scrollToLine(line: number, headingText: string) {
  const editorMode = useUIStore.getState().editorMode;

  // 预览模式下，在预览面板中查找匹配标题并滚动
  if (editorMode === 'preview') {
    const preview = document.querySelector('.oxide-markdown-preview');
    if (!preview) return;
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const el of headings) {
      if (el.textContent?.trim() === headingText) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    return;
  }

  // 编辑/分屏模式：通过 CodeMirror API 精确滚动到行
  const view = getEditorView();
  if (!view) return;

  // CodeMirror 行号 1-based，extractHeadings 的 line 是 0-based
  const lineNumber = line + 1;
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return;

  const docLine = view.state.doc.line(lineNumber);
  view.dispatch({
    effects: EditorView.scrollIntoView(docLine.from, { y: 'center' }),
    selection: { anchor: docLine.from },
  });
  view.focus();
}
