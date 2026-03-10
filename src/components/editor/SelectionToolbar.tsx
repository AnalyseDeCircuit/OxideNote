/**
 * SelectionToolbar — Floating formatting toolbar above text selection
 *
 * Appears when the user selects text in the CodeMirror editor,
 * providing quick access to inline formatting actions (bold, italic,
 * strikethrough, code, link, highlight) and AI transforms.
 *
 * Positioning is computed from CodeMirror coordsAtPos() and updated
 * on every selection change via an EditorView updateListener.
 */

import { useEffect, useState, useCallback, useRef, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { useTranslation } from 'react-i18next';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  Highlighter,
  Sparkles,
  Heading1,
  Heading2,
  Quote,
} from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';
import { useChatStore } from '@/store/chatStore';
import { triggerAiTransform } from '@/components/editor/extensions/aiInline';
import { toast } from '@/hooks/useToast';

// ═══════════════════════════════════════════════════════════════
// Types & constants
// ═══════════════════════════════════════════════════════════════

interface Position {
  x: number;
  y: number;
}

interface SelectionToolbarProps {
  viewRef: RefObject<EditorView | null>;
  /** Parent container element for relative positioning */
  containerRef: RefObject<HTMLDivElement | null>;
}

// Minimum selection length to trigger the toolbar (avoids flicker on click)
const MIN_SELECTION_LENGTH = 1;

// Vertical gap between the toolbar and the selection top edge
const TOOLBAR_GAP = 8;

// Toolbar approximate dimensions for boundary clamping
const TOOLBAR_WIDTH = 320;
const TOOLBAR_HEIGHT = 36;

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function SelectionToolbar({ viewRef, containerRef }: SelectionToolbarProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [showAiMenu, setShowAiMenu] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);

  // Track if the toolbar interaction is ongoing to prevent hiding on blur
  const interactingRef = useRef(false);

  // ── Compute toolbar position from CodeMirror selection ────
  const updatePosition = useCallback(() => {
    const view = viewRef.current;
    const container = containerRef.current;
    if (!view || !container) {
      setVisible(false);
      return;
    }

    const { from, to } = view.state.selection.main;
    const selLength = to - from;

    if (selLength < MIN_SELECTION_LENGTH) {
      setVisible(false);
      setShowAiMenu(false);
      return;
    }

    // Get coordinates of the selection head (cursor end)
    const headCoords = view.coordsAtPos(from);
    const tailCoords = view.coordsAtPos(to);
    if (!headCoords || !tailCoords) {
      setVisible(false);
      return;
    }

    // Position toolbar above the selection, centered horizontally
    const containerRect = container.getBoundingClientRect();
    const selLeft = Math.min(headCoords.left, tailCoords.left);
    const selRight = Math.max(headCoords.right, tailCoords.right);
    const selCenterX = (selLeft + selRight) / 2;
    const selTopY = Math.min(headCoords.top, tailCoords.top);

    // Convert to container-relative coordinates
    let x = selCenterX - containerRect.left - TOOLBAR_WIDTH / 2;
    let y = selTopY - containerRect.top - TOOLBAR_HEIGHT - TOOLBAR_GAP;

    // Clamp horizontal position within container bounds
    x = Math.max(4, Math.min(x, containerRect.width - TOOLBAR_WIDTH - 4));

    // If toolbar would go above the container, place it below the selection
    if (y < 4) {
      const selBottomY = Math.max(headCoords.bottom, tailCoords.bottom);
      y = selBottomY - containerRect.top + TOOLBAR_GAP;
    }

    setPosition({ x, y });
    setVisible(true);
  }, [viewRef, containerRef]);

  // ── Listen to CM selection changes ────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Use a DOM listener on the editor to detect selection changes
    // after mouseup (avoids jitter during drag-select)
    const handleMouseUp = () => {
      // Small delay to let CM finalize the selection
      requestAnimationFrame(() => {
        interactingRef.current = false;
        updatePosition();
      });
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Update on shift+arrow or select-all (Cmd/Ctrl+A)
      if (e.shiftKey || ((e.metaKey || e.ctrlKey) && e.key === 'a')) {
        requestAnimationFrame(() => updatePosition());
      }
    };

    // Hide on scroll (position becomes stale)
    const handleScroll = () => {
      setVisible(false);
      setShowAiMenu(false);
    };

    const scrollDOM = view.scrollDOM;
    const contentDOM = view.contentDOM;

    contentDOM.addEventListener('mouseup', handleMouseUp);
    contentDOM.addEventListener('keyup', handleKeyUp);
    scrollDOM.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      contentDOM.removeEventListener('mouseup', handleMouseUp);
      contentDOM.removeEventListener('keyup', handleKeyUp);
      scrollDOM.removeEventListener('scroll', handleScroll);
    };
  }, [viewRef, updatePosition]);

  // ── Close on outside click ────────────────────────────────
  useEffect(() => {
    if (!visible) return;

    const handleMouseDown = (e: MouseEvent) => {
      const toolbar = toolbarRef.current;
      const aiMenu = aiMenuRef.current;
      if (toolbar && toolbar.contains(e.target as Node)) {
        interactingRef.current = true;
        return;
      }
      if (aiMenu && aiMenu.contains(e.target as Node)) {
        interactingRef.current = true;
        return;
      }
      interactingRef.current = false;
      setVisible(false);
      setShowAiMenu(false);
    };

    // Delay adding the listener to avoid catching the selection mousedown
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleMouseDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [visible]);

  // ── Formatting actions (operate on the shared EditorView) ──
  const wrapSelection = useCallback((prefix: string, suffix: string) => {
    const view = viewRef.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (!selected) return;

    // Check if already wrapped — toggle off
    const beforeFrom = Math.max(0, from - prefix.length);
    const afterTo = Math.min(view.state.doc.length, to + suffix.length);
    const before = view.state.sliceDoc(beforeFrom, from);
    const after = view.state.sliceDoc(to, afterTo);

    if (before === prefix && after === suffix) {
      view.dispatch({
        changes: [
          { from: beforeFrom, to: from, insert: '' },
          { from: to, to: afterTo, insert: '' },
        ],
        selection: { anchor: beforeFrom, head: beforeFrom + selected.length },
      });
    } else {
      const wrapped = `${prefix}${selected}${suffix}`;
      view.dispatch({
        changes: { from, to, insert: wrapped },
        selection: { anchor: from + prefix.length, head: from + prefix.length + selected.length },
      });
    }
    view.focus();
    // Re-check position after format change and reset interaction flag
    interactingRef.current = false;
    requestAnimationFrame(() => updatePosition());
  }, [viewRef, updatePosition]);

  const applyHeading = useCallback((level: number) => {
    const view = viewRef.current;
    if (!view) return;

    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const lineText = view.state.sliceDoc(line.from, line.to);
    const headingMatch = lineText.match(/^(#{1,6})\s/);
    const prefix = '#'.repeat(level) + ' ';

    if (headingMatch) {
      if (headingMatch[1].length === level) {
        view.dispatch({
          changes: { from: line.from, to: line.from + headingMatch[0].length, insert: '' },
        });
      } else {
        view.dispatch({
          changes: { from: line.from, to: line.from + headingMatch[0].length, insert: prefix },
        });
      }
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.from, insert: prefix },
      });
    }
    view.focus();
    interactingRef.current = false;
  }, [viewRef]);

  const insertQuote = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const startLine = view.state.doc.lineAt(from);
    const endLine = view.state.doc.lineAt(to);

    // Apply '> ' prefix to every line in the selection range
    const changes = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
      const line = view.state.doc.line(i);
      changes.push({ from: line.from, to: line.from, insert: '> ' });
    }
    view.dispatch({ changes });
    view.focus();
    interactingRef.current = false;
  }, [viewRef]);

  const insertLink = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (!selected) return;

    const wrapped = `[${selected}](url)`;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      // Place cursor inside the url placeholder
      selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 },
    });
    view.focus();
    setVisible(false);
  }, [viewRef]);

  // ── AI transform handler ──────────────────────────────────
  const handleAiAction = useCallback((instruction: string) => {
    setShowAiMenu(false);
    setVisible(false);
    const view = viewRef.current;
    if (!view) return;
    const config = useChatStore.getState().config;
    const activePath = useNoteStore.getState().activeTabPath || '';
    const noteTitle = activePath.replace(/\.[^.]+$/, '').split('/').pop() || '';
    const fileExt = activePath.split('.').pop() || 'md';
    triggerAiTransform(view, instruction, config, noteTitle, fileExt).catch((err) => {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    });
  }, [viewRef, t]);

  if (!visible) return null;

  return (
    <div
      ref={toolbarRef}
      className="absolute z-50 flex items-center gap-0.5 px-1.5 py-1 rounded-lg
                 bg-surface border border-theme-border shadow-lg
                 animate-in fade-in-0 zoom-in-95 duration-100"
      style={{
        left: position.x,
        top: position.y,
        pointerEvents: 'auto',
      }}
      onMouseDown={(e) => {
        // Prevent selection from being cleared when clicking toolbar buttons
        e.preventDefault();
        interactingRef.current = true;
      }}
    >
      {/* Inline formatting actions */}
      <SelBtn
        icon={<Bold size={14} />}
        title={t('toolbar.bold')}
        onClick={() => wrapSelection('**', '**')}
      />
      <SelBtn
        icon={<Italic size={14} />}
        title={t('toolbar.italic')}
        onClick={() => wrapSelection('*', '*')}
      />
      <SelBtn
        icon={<Strikethrough size={14} />}
        title={t('toolbar.strikethrough')}
        onClick={() => wrapSelection('~~', '~~')}
      />
      <SelBtn
        icon={<Code size={14} />}
        title={t('toolbar.code')}
        onClick={() => wrapSelection('`', '`')}
      />
      <SelBtn
        icon={<Highlighter size={14} />}
        title={t('selectionToolbar.highlight')}
        onClick={() => wrapSelection('==', '==')}
      />
      <SelBtn
        icon={<Link size={14} />}
        title={t('toolbar.link')}
        onClick={insertLink}
      />

      <BtnDivider />

      {/* Block-level actions */}
      <SelBtn
        icon={<Heading1 size={14} />}
        title={t('toolbar.heading1')}
        onClick={() => applyHeading(1)}
      />
      <SelBtn
        icon={<Heading2 size={14} />}
        title={t('toolbar.heading2')}
        onClick={() => applyHeading(2)}
      />
      <SelBtn
        icon={<Quote size={14} />}
        title={t('toolbar.quote')}
        onClick={insertQuote}
      />

      <BtnDivider />

      {/* AI actions */}
      <div className="relative">
        <SelBtn
          icon={<Sparkles size={14} />}
          title={t('inlineAi.title')}
          onClick={() => setShowAiMenu((prev) => !prev)}
        />
        {showAiMenu && (
          <div
            ref={aiMenuRef}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50
                       min-w-[140px] bg-surface border border-theme-border
                       rounded-lg shadow-lg py-1"
          >
            {QUICK_AI_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-foreground
                           hover:bg-theme-hover transition-colors whitespace-nowrap"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleAiAction(action.instruction)}
              >
                {t(`inlineAi.${action.key}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Quick AI actions subset (most common for selection) ──────

const QUICK_AI_ACTIONS = [
  { key: 'rewrite', instruction: 'Rewrite this text to be clearer and more concise' },
  { key: 'improve', instruction: 'Improve the writing quality while preserving the meaning' },
  { key: 'shorter', instruction: 'Make this text shorter while keeping the key points' },
  { key: 'translate', instruction: 'Translate this text to the other language (Chinese↔English)' },
  { key: 'summarize', instruction: 'Summarize this text into bullet points' },
] as const;

// ── Sub-components ──────────────────────────────────────────

function SelBtn({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="p-1 rounded hover:bg-theme-hover text-muted-foreground
                 hover:text-foreground transition-colors"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function BtnDivider() {
  return <div className="w-px h-4 bg-theme-border mx-0.5" />;
}
