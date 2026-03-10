/**
 * OutlinePanel — Document outline & block reference panel
 *
 * Extracts heading hierarchy from the current note to build a
 * navigable TOC (Table of Contents) tree.
 *
 * Supported formats:
 *   · Markdown — ATX headings (# ~ ######)
 *   · Typst    — heading markers (= ~ ======)
 *   · LaTeX    — sectioning commands (\part ~ \paragraph)
 *
 * Also extracts ^blockId markers for drag-and-drop to canvas.
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

// ── Heading item type ───────────────────────────────────────
interface HeadingItem {
  /** Heading level 1~6 */
  level: number;
  /** Heading text */
  text: string;
  /** 0-based line number in source document */
  line: number;
}

// ── File-type detection helpers ─────────────────────────────

type NoteFileType = 'markdown' | 'typst' | 'latex';

function detectFileType(path: string | null): NoteFileType {
  if (!path) return 'markdown';
  const lower = path.toLowerCase();
  if (lower.endsWith('.typ')) return 'typst';
  if (lower.endsWith('.tex')) return 'latex';
  return 'markdown';
}

/** Level indicator character per file type */
function levelIndicator(fileType: NoteFileType, level: number): string {
  switch (fileType) {
    case 'typst':    return '='.repeat(level);
    case 'latex':    return '§'.repeat(level);
    case 'markdown': return '#'.repeat(level);
  }
}

// ── Markdown heading extractor ─────────────────────────────

/**
 * Extract headings from Markdown source text.
 *
 * Rules:
 *   · Skip fenced code blocks (``` / ~~~)
 *   · Match ATX heading: ^#{1,6}\s+(.*)$
 */
function extractHeadingsMarkdown(content: string): HeadingItem[] {
  const lines = content.split('\n');
  const headings: HeadingItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

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

// ── Typst heading extractor ────────────────────────────────

/**
 * Extract headings from Typst source text.
 *
 * Typst heading syntax: = Title, == Subtitle, === Sub-sub, etc.
 * Skips fenced code blocks (```) and commented lines (//).
 */
function extractHeadingsTypst(content: string): HeadingItem[] {
  const lines = content.split('\n');
  const headings: HeadingItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Typst raw blocks use ```
    if (/^(`{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Skip line comments
    if (/^\s*\/\//.test(line)) continue;

    // Match Typst heading: one or more '=' followed by a space and text
    const match = line.match(/^(={1,6})\s+(.+)$/);
    if (match) {
      // Strip trailing Typst labels like <intro>
      const text = match[2].replace(/<[a-zA-Z0-9_-]+>\s*$/, '').trim();
      headings.push({
        level: match[1].length,
        text,
        line: i,
      });
    }
  }

  return headings;
}

// ── LaTeX heading extractor ────────────────────────────────

/** LaTeX sectioning commands mapped to outline levels.
 * Brace pattern handles one level of nesting (e.g. \section{A \textbf{B}}) */
const LATEX_SECTION_PATTERNS: [RegExp, number][] = [
  [/\\part\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 1],
  [/\\chapter\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 2],
  [/\\section\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 3],
  [/\\subsection\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 4],
  [/\\subsubsection\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 5],
  [/\\paragraph\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 6],
  [/\\subparagraph\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, 6],
];

/**
 * Extract headings from LaTeX source text.
 *
 * Matches sectioning commands: \part, \chapter, \section, \subsection,
 * \subsubsection, \paragraph (with optional *).
 * Skips lines that are commented out (leading %).
 */
function extractHeadingsLatex(content: string): HeadingItem[] {
  const lines = content.split('\n');
  const headings: HeadingItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip LaTeX comment lines
    if (/^\s*%/.test(line)) continue;

    for (const [regex, level] of LATEX_SECTION_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        headings.push({
          level,
          text: match[1].trim(),
          line: i,
        });
        break; // One heading per line
      }
    }
  }

  return headings;
}

/** Dispatch heading extraction based on file type */
function extractHeadingsByType(content: string, fileType: NoteFileType): HeadingItem[] {
  switch (fileType) {
    case 'typst':    return extractHeadingsTypst(content);
    case 'latex':    return extractHeadingsLatex(content);
    case 'markdown': return extractHeadingsMarkdown(content);
  }
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
  const fileType = detectFileType(activeTabPath);
  const headings = useEditorHeadings(fileType);
  // Block references (^blockId) are a Markdown-specific concept
  const blocks = fileType === 'markdown' ? useEditorBlocks() : [];

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
                  {levelIndicator(fileType, heading.level)}
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

function useEditorHeadings(fileType: NoteFileType): HeadingItem[] {
  const activeContent = useNoteStore((s) => s.activeContent);
  return useMemo(
    () => extractHeadingsByType(activeContent, fileType),
    [activeContent, fileType],
  );
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
  const activeTabPath = useNoteStore.getState().activeTabPath;
  const fileType = detectFileType(activeTabPath);

  // For Markdown in preview mode, locate heading in rendered preview DOM
  if (editorMode === 'preview' && fileType === 'markdown') {
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

  // Edit / split mode (or non-Markdown preview): scroll CodeMirror to line.
  // Note: for Typst/LaTeX in split mode, only the editor pane scrolls;
  // the compiled PDF preview cannot be scrolled to a specific heading.
  const view = getEditorView();
  if (!view) return;

  // CodeMirror uses 1-based line numbers; extractors use 0-based
  const lineNumber = line + 1;
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return;

  const docLine = view.state.doc.line(lineNumber);
  view.dispatch({
    effects: EditorView.scrollIntoView(docLine.from, { y: 'center' }),
    selection: { anchor: docLine.from },
  });
  view.focus();
}
