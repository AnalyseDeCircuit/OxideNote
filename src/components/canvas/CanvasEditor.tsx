/**
 * CanvasEditor — Persistent whiteboard with freehand drawing and note cards
 *
 * An SVG-based whiteboard for sketches, diagrams, and visual note linking.
 * Supports two modes:
 *   · Persistent mode (canvasPath): loads from .canvas JSON, debounced auto-save
 *   · Overlay mode (onSaved/onClose): full-screen overlay for toolbar embedding
 *
 * Features:
 *   · Freehand drawing with configurable stroke width/color
 *   · Eraser mode (removes strokes under cursor)
 *   · Note cards: draggable text blocks that optionally link to vault notes/blocks
 *   · Undo/redo via history stack
 *   · Block drop support: receive blocks dragged from OutlinePanel (Phase 2)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  readCanvas,
  writeCanvas,
  saveAttachment,
  type CanvasData,
  type CanvasCard as ApiCanvasCard,
} from '@/lib/api';
import { useNoteStore, registerPendingSave, unregisterPendingSave } from '@/store/noteStore';
import { toast } from '@/hooks/useToast';
import { StickyNote, Type, MousePointer, Pen, FileText } from 'lucide-react';

// ── Props ─────────────────────────────────────────────────

interface CanvasEditorPersistentProps {
  /** Vault-relative path to the .canvas file */
  canvasPath: string;
  onSaved?: never;
  onClose?: never;
}

interface CanvasEditorOverlayProps {
  canvasPath?: never;
  /** Called with the relative path of the saved SVG attachment */
  onSaved: (relativePath: string) => void;
  /** Called when the user closes the canvas */
  onClose: () => void;
}

type CanvasEditorProps = CanvasEditorPersistentProps | CanvasEditorOverlayProps;

// ── Internal types ────────────────────────────────────────

interface Stroke {
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

/** A note card placed on the canvas surface */
interface NoteCard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  /** Optional link to a vault note path */
  linkedNote?: string;
  /** Optional link to a specific block */
  linkedBlock?: { notePath: string; blockId: string };
}

type CanvasTool = 'draw' | 'eraser' | 'select' | 'card';

const COLORS = ['#e2e8f0', '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#000000'];
const WIDTHS = [2, 4, 6, 8];
const CARD_COLORS = ['#1e293b', '#1e3a5f', '#3b1e1e', '#1e3b2c', '#3b351e', '#2d1e3b'];

const AUTO_SAVE_DELAY = 1500;

let cardIdCounter = 0;
function generateCardId(): string {
  return `card-${Date.now().toString(36)}-${(cardIdCounter++).toString(36)}`;
}

// ── Serialization helpers ─────────────────────────────────

/** Convert internal NoteCard[] to API CanvasCard[] for saving */
function cardsToApi(cards: NoteCard[]): ApiCanvasCard[] {
  return cards.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
    text: c.text,
    color: c.color,
    linked_note: c.linkedNote,
    linked_block: c.linkedBlock
      ? { note_path: c.linkedBlock.notePath, block_id: c.linkedBlock.blockId }
      : undefined,
  }));
}

/** Convert API CanvasCard[] to internal NoteCard[] */
function cardsFromApi(cards: ApiCanvasCard[]): NoteCard[] {
  return cards.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
    text: c.text,
    color: c.color,
    linkedNote: c.linked_note,
    linkedBlock: c.linked_block
      ? { notePath: c.linked_block.note_path, blockId: c.linked_block.block_id }
      : undefined,
  }));
}

// ═══════════════════════════════════════════════════════════
// CanvasEditor Component
// ═══════════════════════════════════════════════════════════

export function CanvasEditor(props: CanvasEditorProps) {
  const isPersistent = 'canvasPath' in props && !!props.canvasPath;
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undoneStrokes, setUndoneStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [strokeColor, setStrokeColor] = useState('#e2e8f0');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [tool, setTool] = useState<CanvasTool>('draw');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!isPersistent);
  const isDrawing = useRef(false);
  const eraseRafRef = useRef<number | null>(null);
  const pendingErasePoint = useRef<{ x: number; y: number } | null>(null);

  // Cancel any pending erase animation frame on unmount
  useEffect(() => {
    return () => {
      if (eraseRafRef.current !== null) cancelAnimationFrame(eraseRafRef.current);
    };
  }, []);

  // Note cards state
  const [noteCards, setNoteCards] = useState<NoteCard[]>([]);
  const [draggingCard, setDraggingCard] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Auto-save timer for persistent mode
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether data has changed since initial load (avoids spurious saves)
  const dirtyAfterLoad = useRef(false);
  // Refs that track the latest state for the save callback
  const strokesRef = useRef(strokes);
  const noteCardsRef = useRef(noteCards);
  strokesRef.current = strokes;
  noteCardsRef.current = noteCards;

  // ── Persistent mode: load data on mount ─────────────────
  useEffect(() => {
    if (!isPersistent) return;
    const canvasPath = (props as CanvasEditorPersistentProps).canvasPath;

    readCanvas(canvasPath)
      .then((data) => {
        setStrokes(data.strokes as Stroke[]);
        setNoteCards(cardsFromApi(data.cards));
        // Reset dirty flag so the initial state set doesn't trigger auto-save
        dirtyAfterLoad.current = false;
        setLoaded(true);
      })
      .catch((err) => {
        console.warn('[canvas] Failed to load canvas:', err);
        setLoaded(true);
      });
  }, [isPersistent, isPersistent ? (props as CanvasEditorPersistentProps).canvasPath : null]);

  // ── Persistent mode: register flush callback ───────────
  useEffect(() => {
    if (!isPersistent) return;
    const canvasPath = (props as CanvasEditorPersistentProps).canvasPath;

    // Flush callback for tab close / app exit
    registerPendingSave(canvasPath, async () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await persistCanvas(canvasPath, strokesRef.current, noteCardsRef.current);
      useNoteStore.getState().markClean(canvasPath);
      return 'saved';
    });

    return () => {
      unregisterPendingSave(canvasPath);
      // Flush any pending save on unmount
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        persistCanvas(canvasPath, strokesRef.current, noteCardsRef.current).catch(() => {});
      }
    };
  }, [isPersistent, isPersistent ? (props as CanvasEditorPersistentProps).canvasPath : null]);

  // ── Persistent mode: debounced auto-save on data change ─
  useEffect(() => {
    if (!isPersistent || !loaded) return;

    // Skip the first trigger after load to avoid spurious saves
    if (!dirtyAfterLoad.current) {
      dirtyAfterLoad.current = true;
      return;
    }

    const canvasPath = (props as CanvasEditorPersistentProps).canvasPath;

    // Mark dirty in tab bar
    useNoteStore.getState().markDirty(canvasPath);

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      await persistCanvas(canvasPath, strokes, noteCards);
      useNoteStore.getState().markClean(canvasPath);
    }, AUTO_SAVE_DELAY);
  }, [strokes, noteCards, loaded, isPersistent]);

  // Get SVG-relative coordinates from a pointer event
  const getSvgPoint = useCallback((e: React.PointerEvent<SVGSVGElement> | React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // Start a new stroke (draw/erase mode only)
  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (tool !== 'draw' && tool !== 'eraser') return;
    const svg = svgRef.current;
    if (!svg) return;

    isDrawing.current = true;
    svg.setPointerCapture(e.pointerId);
    const point = getSvgPoint(e);

    if (tool === 'eraser') {
      setStrokes((prev) =>
        prev.filter((s) =>
          !s.points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < 12)
        )
      );
    } else {
      setCurrentStroke({ points: [point], color: strokeColor, width: strokeWidth });
    }
  }, [strokeColor, strokeWidth, tool, getSvgPoint]);

  // Continue the stroke
  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDrawing.current) return;
    const point = getSvgPoint(e);

    if (tool === 'eraser') {
      pendingErasePoint.current = point;
      if (eraseRafRef.current === null) {
        eraseRafRef.current = requestAnimationFrame(() => {
          const pt = pendingErasePoint.current;
          if (pt) {
            setStrokes((prev) =>
              prev.filter((s) =>
                !s.points.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < 12)
              )
            );
          }
          eraseRafRef.current = null;
        });
      }
    } else if (tool === 'draw') {
      setCurrentStroke((prev) => {
        if (!prev) return prev;
        return { ...prev, points: [...prev.points, point] };
      });
    }
  }, [tool, getSvgPoint]);

  // Finish the stroke
  const handlePointerUp = useCallback(() => {
    isDrawing.current = false;
    if (currentStroke && currentStroke.points.length > 1) {
      setStrokes((prev) => [...prev, currentStroke]);
      setUndoneStrokes([]);
    }
    setCurrentStroke(null);
  }, [currentStroke]);

  // Build SVG path data from points (smooth quadratic curves)
  const buildPathData = useCallback((points: { x: number; y: number }[]): string => {
    if (points.length < 2) return '';
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const mid = {
        x: (points[i].x + points[i + 1].x) / 2,
        y: (points[i].y + points[i + 1].y) / 2,
      };
      d += ` Q ${points[i].x} ${points[i].y} ${mid.x} ${mid.y}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }, []);

  const handleUndo = useCallback(() => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const removed = prev[prev.length - 1];
      setUndoneStrokes((u) => [...u, removed]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setUndoneStrokes((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      setStrokes((s) => [...s, restored]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleClear = useCallback(() => {
    setStrokes([]);
    setUndoneStrokes([]);
    setCurrentStroke(null);
    setNoteCards([]);
  }, []);

  // ── Note card operations ───────────────────────────────────

  // Click on SVG in "card" tool mode: place a new card
  const handleSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (tool !== 'card') return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newCard: NoteCard = {
      id: generateCardId(),
      x,
      y,
      width: 200,
      height: 120,
      text: '',
      color: CARD_COLORS[noteCards.length % CARD_COLORS.length],
    };
    setNoteCards((prev) => [...prev, newCard]);
    setEditingCard(newCard.id);
    setTool('select');
  }, [tool, noteCards.length]);

  // Start dragging a card
  const handleCardDragStart = useCallback((cardId: string, e: React.PointerEvent) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    const card = noteCards.find((c) => c.id === cardId);
    if (!card) return;
    const svg = svgRef.current;
    if (!svg) return;
    setDraggingCard(cardId);
    const rect = svg.getBoundingClientRect();
    dragOffset.current = { x: (e.clientX - rect.left) - card.x, y: (e.clientY - rect.top) - card.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [tool, noteCards]);

  const handleCardDragMove = useCallback((e: React.PointerEvent) => {
    if (!draggingCard) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const newX = e.clientX - rect.left - dragOffset.current.x;
    const newY = e.clientY - rect.top - dragOffset.current.y;
    setNoteCards((prev) =>
      prev.map((c) => c.id === draggingCard
        ? { ...c, x: newX, y: newY }
        : c
      )
    );
  }, [draggingCard]);

  const handleCardDragEnd = useCallback(() => {
    setDraggingCard(null);
  }, []);

  const handleCardTextChange = useCallback((cardId: string, text: string) => {
    setNoteCards((prev) =>
      prev.map((c) => c.id === cardId ? { ...c, text } : c)
    );
  }, []);

  const handleCardDelete = useCallback((cardId: string) => {
    setNoteCards((prev) => prev.filter((c) => c.id !== cardId));
    if (editingCard === cardId) setEditingCard(null);
  }, [editingCard]);

  // Open linked note or block
  const handleCardOpenNote = useCallback((card: NoteCard) => {
    if (card.linkedBlock) {
      // Jump to the block's note and scroll to the block line
      const { notePath, blockId } = card.linkedBlock;
      const title = notePath.replace(/\.md$/i, '').split('/').pop() || notePath;
      useNoteStore.getState().setPendingScrollTarget({ blockId });
      useNoteStore.getState().openNote(notePath, title);
    } else if (card.linkedNote) {
      const title = card.linkedNote.replace(/\.md$/i, '').split('/').pop() || card.linkedNote;
      useNoteStore.getState().openNote(card.linkedNote, title);
    }
  }, []);

  // ── Phase 2: Handle block drop from OutlinePanel ────────
  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const blockData = e.dataTransfer.getData('application/x-oxide-block');
    if (!blockData) return;
    e.preventDefault();

    try {
      const { notePath, blockId, content } = JSON.parse(blockData) as {
        notePath: string;
        blockId: string;
        content: string;
      };

      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const newCard: NoteCard = {
        id: generateCardId(),
        x,
        y,
        width: 240,
        height: 140,
        text: content,
        color: CARD_COLORS[noteCards.length % CARD_COLORS.length],
        linkedBlock: { notePath, blockId },
      };
      setNoteCards((prev) => [...prev, newCard]);
    } catch {
      // Invalid drop data
    }
  }, [noteCards.length]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-oxide-block')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  // ── Overlay mode: save as SVG attachment ────────────────
  const handleOverlaySave = useCallback(async () => {
    if (!('onSaved' in props) || !props.onSaved) return;
    const svg = svgRef.current;
    if (!svg || (strokes.length === 0 && noteCards.length === 0)) return;

    setSaving(true);
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (noteCards.length > 0) {
        const meta = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
        meta.setAttribute('data-note-cards', JSON.stringify(noteCards));
        clone.prepend(meta);
      }
      const svgData = new XMLSerializer().serializeToString(clone);
      const encoder = new TextEncoder();
      const svgBytes = encoder.encode(svgData);
      const binary = Array.from(svgBytes, (b) => String.fromCharCode(b)).join('');
      const base64 = btoa(binary);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `canvas-${timestamp}.svg`;
      const relPath = await saveAttachment(base64, filename);
      props.onSaved(relPath);
      toast({ title: t('canvas.saved'), description: relPath });
    } catch (err) {
      toast({ title: t('canvas.saveFailed'), description: String(err), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [strokes, noteCards, props, t]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleUndo, handleRedo]);

  // Cursor style based on active tool
  const cursorClass = tool === 'draw' ? 'cursor-crosshair' :
    tool === 'eraser' ? 'cursor-crosshair' :
    tool === 'card' ? 'cursor-cell' : 'cursor-default';

  // ── Toolbar (shared between modes) ──────────────────────
  const toolbar = (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-theme-border bg-surface shrink-0">
      <span className="text-sm font-medium text-foreground">{t('canvas.title')}</span>

      <div className="flex-1" />

      {/* Tool selector */}
      <div className="flex items-center gap-1 mr-2">
        <ToolBtn active={tool === 'select'} onClick={() => setTool('select')} title={t('canvas.selectTool')}>
          <MousePointer size={14} />
        </ToolBtn>
        <ToolBtn active={tool === 'draw'} onClick={() => setTool('draw')} title={t('canvas.drawTool')}>
          <Pen size={14} />
        </ToolBtn>
        <ToolBtn active={tool === 'card'} onClick={() => setTool('card')} title={t('canvas.addCard')}>
          <StickyNote size={14} />
        </ToolBtn>
      </div>

      <div className="w-px h-5 bg-theme-border mx-1" />

      {/* Color picker */}
      <div className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`w-5 h-5 rounded-full border-2 transition-transform ${
              strokeColor === c && tool === 'draw' ? 'border-theme-accent scale-125' : 'border-transparent hover:scale-110'
            }`}
            style={{ backgroundColor: c }}
            onClick={() => { setStrokeColor(c); setTool('draw'); }}
            title={c}
          />
        ))}
      </div>

      <div className="w-px h-5 bg-theme-border mx-1" />

      {/* Width picker */}
      <div className="flex items-center gap-1">
        {WIDTHS.map((w) => (
          <button
            key={w}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${
              strokeWidth === w && tool === 'draw' ? 'border-theme-accent text-theme-accent' : 'border-theme-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setStrokeWidth(w); setTool('draw'); }}
          >
            {w}px
          </button>
        ))}
      </div>

      <div className="w-px h-5 bg-theme-border mx-1" />

      {/* Action buttons */}
      <button
        className={`px-2 py-0.5 text-xs rounded border ${
          tool === 'eraser' ? 'border-theme-accent text-theme-accent bg-theme-accent/10' : 'border-theme-border text-muted-foreground hover:text-foreground'
        }`}
        onClick={() => setTool(tool === 'eraser' ? 'draw' : 'eraser')}
      >
        {t('canvas.eraser')}
      </button>
      <button onClick={handleUndo} disabled={strokes.length === 0} className="px-2 py-0.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground disabled:opacity-30">
        {t('canvas.undo')}
      </button>
      <button onClick={handleRedo} disabled={undoneStrokes.length === 0} className="px-2 py-0.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground disabled:opacity-30">
        {t('canvas.redo')}
      </button>
      <button onClick={handleClear} disabled={strokes.length === 0 && noteCards.length === 0} className="px-2 py-0.5 text-xs rounded border border-theme-border text-red-400 hover:text-red-300 disabled:opacity-30">
        {t('canvas.clear')}
      </button>

      {/* Mode-specific buttons */}
      {!isPersistent && (
        <>
          <div className="w-px h-5 bg-theme-border mx-1" />
          <button
            onClick={handleOverlaySave}
            disabled={saving || (strokes.length === 0 && noteCards.length === 0)}
            className="px-3 py-0.5 text-xs rounded bg-theme-accent text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? t('canvas.saving') : t('canvas.save')}
          </button>
          <button
            onClick={(props as CanvasEditorOverlayProps).onClose}
            className="px-2 py-0.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground"
          >
            {t('canvas.close')}
          </button>
        </>
      )}
    </div>
  );

  // ── SVG drawing area (shared) ───────────────────────────
  const drawingArea = (
    <div
      className={`flex-1 overflow-hidden ${cursorClass}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={(e) => {
          handlePointerMove(e);
          if (draggingCard) handleCardDragMove(e);
        }}
        onPointerUp={() => {
          handlePointerUp();
          handleCardDragEnd();
        }}
        onPointerLeave={() => {
          handlePointerUp();
          handleCardDragEnd();
        }}
        onClick={handleSvgClick}
      >
        {/* Committed strokes */}
        {strokes.map((stroke, i) => (
          <path
            key={i}
            d={buildPathData(stroke.points)}
            stroke={stroke.color}
            strokeWidth={stroke.width}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/* Current in-progress stroke */}
        {currentStroke && (
          <path
            d={buildPathData(currentStroke.points)}
            stroke={currentStroke.color}
            strokeWidth={currentStroke.width}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.7}
          />
        )}

        {/* Note cards rendered as foreignObject */}
        {noteCards.map((card) => (
          <foreignObject
            key={card.id}
            x={card.x}
            y={card.y}
            width={card.width}
            height={card.height}
          >
            <div
              className="w-full h-full rounded-lg border border-theme-border shadow-lg flex flex-col overflow-hidden"
              style={{ backgroundColor: card.color }}
              onPointerDown={(e) => handleCardDragStart(card.id, e)}
            >
              {/* Card header */}
              <div className="flex items-center justify-between px-2 py-1 border-b border-white/10 shrink-0">
                <span className="text-[10px] text-white/60 truncate flex items-center gap-1">
                  {card.linkedBlock ? (
                    <>
                      <FileText size={10} className="shrink-0" />
                      {card.linkedBlock.notePath.replace(/\.md$/i, '').split('/').pop()}
                      <span className="text-white/40">^{card.linkedBlock.blockId}</span>
                    </>
                  ) : (
                    card.linkedNote || t('canvas.noteCard')
                  )}
                </span>
                <div className="flex items-center gap-1">
                  {(card.linkedNote || card.linkedBlock) && (
                    <button
                      className="text-[10px] text-theme-accent hover:underline"
                      onClick={(e) => { e.stopPropagation(); handleCardOpenNote(card); }}
                    >
                      {t('canvas.openNote')}
                    </button>
                  )}
                  <button
                    className="text-[10px] text-red-400 hover:text-red-300"
                    onClick={(e) => { e.stopPropagation(); handleCardDelete(card.id); }}
                  >
                    ×
                  </button>
                </div>
              </div>
              {/* Card body — editable text */}
              {editingCard === card.id ? (
                <textarea
                  className="flex-1 text-xs text-white bg-transparent p-2 outline-none resize-none"
                  value={card.text}
                  onChange={(e) => handleCardTextChange(card.id, e.target.value)}
                  onBlur={() => setEditingCard(null)}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  autoFocus
                  placeholder={t('canvas.cardPlaceholder')}
                />
              ) : (
                <div
                  className="flex-1 text-xs text-white/90 p-2 overflow-hidden whitespace-pre-wrap"
                  onDoubleClick={(e) => { e.stopPropagation(); setEditingCard(card.id); }}
                >
                  {card.text || <span className="text-white/40 italic">{t('canvas.cardPlaceholder')}</span>}
                </div>
              )}
            </div>
          </foreignObject>
        ))}
      </svg>
    </div>
  );

  // ── Render based on mode ────────────────────────────────
  if (isPersistent) {
    // Embedded in tab — fill parent container
    return (
      <div className="h-full w-full flex flex-col bg-background">
        {toolbar}
        {!loaded ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            {t('canvas.loading')}
          </div>
        ) : (
          drawingArea
        )}
      </div>
    );
  }

  // Overlay mode — full-screen fixed overlay
  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
      {toolbar}
      {drawingArea}
    </div>
  );
}

// ── Small toolbar button component ────────────────────────

function ToolBtn({ active, onClick, title, children }: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`p-1.5 rounded border text-xs ${
        active
          ? 'border-theme-accent text-theme-accent bg-theme-accent/10'
          : 'border-theme-border text-muted-foreground hover:text-foreground'
      }`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

// ── Persist canvas data to disk ───────────────────────────

async function persistCanvas(path: string, strokes: Stroke[], cards: NoteCard[]): Promise<void> {
  const data: CanvasData = {
    version: 1,
    strokes: strokes.map((s) => ({
      points: s.points,
      color: s.color,
      width: s.width,
    })),
    cards: cardsToApi(cards),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  await writeCanvas(path, data);
}
