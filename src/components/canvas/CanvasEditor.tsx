/**
 * CanvasEditor — Freehand drawing canvas with note card support
 *
 * An SVG-based whiteboard for sketches, diagrams, and visual note linking.
 * Supports both freehand strokes and embedded Markdown note cards.
 *
 * Features:
 *   · Freehand drawing with configurable stroke width/color
 *   · Eraser mode (removes strokes under cursor)
 *   · Note cards: draggable text blocks that optionally link to vault notes
 *   · Undo/redo via history stack
 *   · Export to SVG attachment
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { saveAttachment } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { toast } from '@/hooks/useToast';
import { StickyNote, Type, MousePointer } from 'lucide-react';

interface CanvasEditorProps {
  /** Called with the relative path of the saved SVG attachment */
  onSaved: (relativePath: string) => void;
  /** Called when the user closes the canvas */
  onClose: () => void;
}

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
}

type CanvasTool = 'draw' | 'eraser' | 'select' | 'card';

const COLORS = ['#e2e8f0', '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#000000'];
const WIDTHS = [2, 4, 6, 8];
const CARD_COLORS = ['#1e293b', '#1e3a5f', '#3b1e1e', '#1e3b2c', '#3b351e', '#2d1e3b'];

let cardIdCounter = 0;
function generateCardId(): string {
  return `card-${Date.now().toString(36)}-${(cardIdCounter++).toString(36)}`;
}

export function CanvasEditor({ onSaved, onClose }: CanvasEditorProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undoneStrokes, setUndoneStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [strokeColor, setStrokeColor] = useState('#e2e8f0');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [tool, setTool] = useState<CanvasTool>('draw');
  const [saving, setSaving] = useState(false);
  const isDrawing = useRef(false);
  const eraseRafRef = useRef<number | null>(null);
  const pendingErasePoint = useRef<{ x: number; y: number } | null>(null);

  // Note cards state
  const [noteCards, setNoteCards] = useState<NoteCard[]>([]);
  const [draggingCard, setDraggingCard] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

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

  // Click on SVG in "card" tool mode → place a new card
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
    // Switch back to select mode after placing
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
    // Store offset as SVG-relative: cursor position in SVG coords minus card position
    dragOffset.current = { x: (e.clientX - rect.left) - card.x, y: (e.clientY - rect.top) - card.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [tool, noteCards]);

  const handleCardDragMove = useCallback((e: React.PointerEvent) => {
    if (!draggingCard) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Compute SVG-relative coordinates using drag offset
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

  // Update card text
  const handleCardTextChange = useCallback((cardId: string, text: string) => {
    setNoteCards((prev) =>
      prev.map((c) => c.id === cardId ? { ...c, text } : c)
    );
  }, []);

  // Delete a card
  const handleCardDelete = useCallback((cardId: string) => {
    setNoteCards((prev) => prev.filter((c) => c.id !== cardId));
    if (editingCard === cardId) setEditingCard(null);
  }, [editingCard]);

  // Open linked note
  const handleCardOpenNote = useCallback((card: NoteCard) => {
    if (card.linkedNote) {
      const title = card.linkedNote.replace(/\.md$/i, '').split('/').pop() || card.linkedNote;
      useNoteStore.getState().openNote(card.linkedNote, title);
    }
  }, []);

  // Save as SVG attachment
  const handleSave = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg || (strokes.length === 0 && noteCards.length === 0)) return;

    setSaving(true);
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // Embed note card data as a hidden metadata element for reloading
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
      onSaved(relPath);
      toast({ title: t('canvas.saved'), description: relPath });
    } catch (err) {
      toast({ title: t('canvas.saveFailed'), description: String(err), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [strokes, noteCards, onSaved, t]);

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

  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-theme-border bg-surface shrink-0">
        <span className="text-sm font-medium text-foreground">{t('canvas.title')}</span>

        <div className="flex-1" />

        {/* Tool selector */}
        <div className="flex items-center gap-1 mr-2">
          <button
            className={`p-1.5 rounded border text-xs ${
              tool === 'select' ? 'border-theme-accent text-theme-accent bg-theme-accent/10' : 'border-theme-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTool('select')}
            title={t('canvas.selectTool')}
          >
            <MousePointer size={14} />
          </button>
          <button
            className={`p-1.5 rounded border text-xs ${
              tool === 'draw' ? 'border-theme-accent text-theme-accent bg-theme-accent/10' : 'border-theme-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTool('draw')}
            title={t('canvas.drawTool')}
          >
            <Type size={14} />
          </button>
          <button
            className={`p-1.5 rounded border text-xs ${
              tool === 'card' ? 'border-theme-accent text-theme-accent bg-theme-accent/10' : 'border-theme-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTool('card')}
            title={t('canvas.addCard')}
          >
            <StickyNote size={14} />
          </button>
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

        {/* Tool buttons */}
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

        <div className="w-px h-5 bg-theme-border mx-1" />

        <button
          onClick={handleSave}
          disabled={saving || (strokes.length === 0 && noteCards.length === 0)}
          className="px-3 py-0.5 text-xs rounded bg-theme-accent text-white hover:opacity-90 disabled:opacity-40"
        >
          {saving ? t('canvas.saving') : t('canvas.save')}
        </button>
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground"
        >
          {t('canvas.close')}
        </button>
      </div>

      {/* Drawing area */}
      <div className={`flex-1 overflow-hidden ${cursorClass}`}>
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
                  <span className="text-[10px] text-white/60 truncate">
                    {card.linkedNote || t('canvas.noteCard')}
                  </span>
                  <div className="flex items-center gap-1">
                    {card.linkedNote && (
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
    </div>
  );
}
