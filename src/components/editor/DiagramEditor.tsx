/**
 * DiagramEditor — Lightweight freehand drawing / sketch tool.
 *
 * Provides a canvas-based drawing surface for quick sketches and diagrams.
 * Supports freehand pen, eraser, color picker, brush size, and undo/redo.
 * Drawings are saved as JSON (strokes array) embedded in .md via a code fence.
 *
 * Opens as a modal overlay triggered from the editor toolbar.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Pen, Eraser, Undo2, Redo2, Download, Trash2 } from 'lucide-react';

// ── Types ───────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  points: Point[];
  color: string;
  width: number;
}

interface DiagramEditorProps {
  /** Initial strokes data (from previously saved diagram) */
  initialData?: string;
  /** Called when the user saves — passes JSON string of strokes */
  onSave: (data: string) => void;
  onClose: () => void;
}

// ── Preset colors ───────────────────────────────────────────

const COLORS = [
  '#f4f4f5', '#a1a1aa', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4',
];

const BRUSH_SIZES = [2, 4, 6, 10, 16];

// ── Main component ──────────────────────────────────────────

export function DiagramEditor({ initialData, onSave, onClose }: DiagramEditorProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [strokes, setStrokes] = useState<Stroke[]>(() => {
    if (initialData) {
      try { return JSON.parse(initialData); } catch { return []; }
    }
    return [];
  });
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Point[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState('#f4f4f5');
  const [brushSize, setBrushSize] = useState(4);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');

  // Refs for stable access in event handlers (avoids stale closures)
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const currentStrokeRef = useRef(currentStroke);
  currentStrokeRef.current = currentStroke;
  const colorRef = useRef(color);
  colorRef.current = color;
  const brushSizeRef = useRef(brushSize);
  brushSizeRef.current = brushSize;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  // ── Canvas rendering ──────────────────────────────────────

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw all committed strokes
    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke);
    }

    // Draw current in-progress stroke
    const cs = currentStrokeRef.current;
    if (cs.length > 1) {
      if (toolRef.current === 'eraser') {
        drawEraseStroke(ctx, cs, brushSizeRef.current * 3);
      } else {
        drawStroke(ctx, {
          points: cs,
          color: colorRef.current,
          width: brushSizeRef.current,
        });
      }
    }
  }, [currentStroke, color, brushSize, tool, strokes]);

  // Store redraw in a ref for the ResizeObserver
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  useEffect(() => {
    redraw();
  }, [redraw]);

  // ── Canvas resize (stable — does not depend on redraw) ────

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);
      redrawRef.current();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Pointer events (stable callbacks via refs) ────────────

  const getCanvasPoint = useCallback((e: React.PointerEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDrawing(true);
    setCurrentStroke([getCanvasPoint(e)]);
  }, [getCanvasPoint]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    setCurrentStroke((prev) => [...prev, getCanvasPoint(e)]);
  }, [getCanvasPoint]);

  const handlePointerUp = useCallback(() => {
    if (!drawingRef.current) return;
    setDrawing(false);
    const cs = currentStrokeRef.current;
    if (cs.length > 1) {
      const isEraser = toolRef.current === 'eraser';
      const newStroke: Stroke = {
        points: cs,
        color: isEraser ? 'eraser' : colorRef.current,
        width: isEraser ? brushSizeRef.current * 3 : brushSizeRef.current,
      };
      setStrokes((prev) => [...prev, newStroke]);
      setRedoStack([]);
    }
    setCurrentStroke([]);
  }, []);

  // ── Actions ───────────────────────────────────────────────

  const undo = useCallback(() => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, last]);
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setStrokes((s) => [...s, last]);
      return prev.slice(0, -1);
    });
  }, []);

  const clear = useCallback(() => {
    setStrokes([]);
    setRedoStack([]);
  }, []);

  const handleSave = useCallback(() => {
    onSave(JSON.stringify(strokes));
  }, [strokes, onSave]);

  const exportPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'diagram.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, undo, redo, handleSave]);

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <div className="flex items-center gap-2">
          {/* Pen / Eraser toggle */}
          <button
            onClick={() => setTool('pen')}
            className={`p-1.5 rounded transition-colors ${
              tool === 'pen' ? 'bg-theme-accent/20 text-theme-accent' : 'text-muted-foreground hover:bg-theme-hover'
            }`}
          >
            <Pen size={16} />
          </button>
          <button
            onClick={() => setTool('eraser')}
            className={`p-1.5 rounded transition-colors ${
              tool === 'eraser' ? 'bg-theme-accent/20 text-theme-accent' : 'text-muted-foreground hover:bg-theme-hover'
            }`}
          >
            <Eraser size={16} />
          </button>

          <div className="w-px h-5 bg-theme-border mx-1" />

          {/* Color palette */}
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => { setColor(c); setTool('pen'); }}
                className={`w-5 h-5 rounded-full border-2 transition-transform ${
                  color === c && tool === 'pen' ? 'border-theme-accent scale-110' : 'border-transparent'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="w-px h-5 bg-theme-border mx-1" />

          {/* Brush size */}
          <div className="flex items-center gap-1">
            {BRUSH_SIZES.map((s) => (
              <button
                key={s}
                onClick={() => setBrushSize(s)}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors ${
                  brushSize === s ? 'bg-theme-accent/20 text-theme-accent' : 'text-muted-foreground hover:bg-theme-hover'
                }`}
              >
                <div
                  className="rounded-full bg-current"
                  style={{ width: Math.min(s, 12), height: Math.min(s, 12) }}
                />
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-theme-border mx-1" />

          {/* Undo / Redo / Clear */}
          <button onClick={undo} disabled={strokes.length === 0} className="p-1.5 rounded text-muted-foreground hover:bg-theme-hover disabled:opacity-30">
            <Undo2 size={16} />
          </button>
          <button onClick={redo} disabled={redoStack.length === 0} className="p-1.5 rounded text-muted-foreground hover:bg-theme-hover disabled:opacity-30">
            <Redo2 size={16} />
          </button>
          <button onClick={clear} disabled={strokes.length === 0} className="p-1.5 rounded text-muted-foreground hover:bg-theme-hover disabled:opacity-30">
            <Trash2 size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={exportPng}
            className="px-2.5 py-1.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground hover:bg-theme-hover transition-colors"
          >
            <Download size={12} className="inline mr-1" />
            PNG
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs rounded bg-theme-accent text-white hover:bg-theme-accent-hover transition-colors"
          >
            {t('actions.save')}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Canvas surface */}
      <div ref={containerRef} className="flex-1 min-h-0 cursor-crosshair bg-[#09090b]">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className="touch-none"
        />
      </div>
    </div>
  );
}

// ── Canvas drawing helpers ──────────────────────────────────

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.points.length < 2) return;

  // Eraser strokes use destination-out composite for true erasing
  if (stroke.color === 'eraser') {
    drawEraseStroke(ctx, stroke.points, stroke.width);
    return;
  }

  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const [first, ...rest] = stroke.points;
  ctx.moveTo(first.x, first.y);
  for (const p of rest) {
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

/** Erase along a path using destination-out compositing */
function drawEraseStroke(ctx: CanvasRenderingContext2D, points: Point[], width: number) {
  if (points.length < 2) return;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const [first, ...rest] = points;
  ctx.moveTo(first.x, first.y);
  for (const p of rest) {
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.globalCompositeOperation = prevOp;
}
