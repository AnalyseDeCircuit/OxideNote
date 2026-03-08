/**
 * CanvasEditor — Lightweight freehand drawing canvas
 *
 * A simple SVG-based whiteboard for quick sketches and diagrams.
 * Drawings are saved as SVG files in the vault's `.attachments/` directory.
 *
 * Features:
 *   · Freehand drawing with configurable stroke width/color
 *   · Eraser mode (removes last stroke under cursor area)
 *   · Undo/redo via stroke history
 *   · Export to SVG and save as attachment
 *   · Resizable canvas area
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { saveAttachment } from '@/lib/api';
import { toast } from '@/hooks/useToast';

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

const COLORS = ['#e2e8f0', '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#000000'];
const WIDTHS = [2, 4, 6, 8];

export function CanvasEditor({ onSaved, onClose }: CanvasEditorProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undoneStrokes, setUndoneStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [strokeColor, setStrokeColor] = useState('#e2e8f0');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [isErasing, setIsErasing] = useState(false);
  const [saving, setSaving] = useState(false);
  const isDrawing = useRef(false);
  const eraseRafRef = useRef<number | null>(null);
  const pendingErasePoint = useRef<{ x: number; y: number } | null>(null);

  // Start a new stroke
  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;

    isDrawing.current = true;
    svg.setPointerCapture(e.pointerId);

    const rect = svg.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    if (isErasing) {
      // Erase mode: remove strokes near the pointer
      setStrokes((prev) =>
        prev.filter((s) =>
          !s.points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < 12)
        )
      );
    } else {
      setCurrentStroke({ points: [point], color: strokeColor, width: strokeWidth });
    }
  }, [strokeColor, strokeWidth, isErasing]);

  // Continue the stroke
  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDrawing.current) return;
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    if (isErasing) {
      // Throttled erase via requestAnimationFrame to avoid O(n·m) per pointer move
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
    } else {
      setCurrentStroke((prev) => {
        if (!prev) return prev;
        return { ...prev, points: [...prev.points, point] };
      });
    }
  }, [isErasing]);

  // Finish the stroke
  const handlePointerUp = useCallback(() => {
    isDrawing.current = false;
    if (currentStroke && currentStroke.points.length > 1) {
      setStrokes((prev) => [...prev, currentStroke]);
      setUndoneStrokes([]); // Clear redo stack on new stroke
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

  // Undo last stroke
  const handleUndo = useCallback(() => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const removed = prev[prev.length - 1];
      setUndoneStrokes((u) => [...u, removed]);
      return prev.slice(0, -1);
    });
  }, []);

  // Redo undone stroke
  const handleRedo = useCallback(() => {
    setUndoneStrokes((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      setStrokes((s) => [...s, restored]);
      return prev.slice(0, -1);
    });
  }, []);

  // Clear all strokes
  const handleClear = useCallback(() => {
    setStrokes([]);
    setUndoneStrokes([]);
    setCurrentStroke(null);
  }, []);

  // Save as SVG attachment
  const handleSave = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg || strokes.length === 0) return;

    setSaving(true);
    try {
      // Clone SVG and serialize
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
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
  }, [strokes, onSaved, t]);

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

  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-theme-border bg-surface shrink-0">
        <span className="text-sm font-medium text-foreground">{t('canvas.title')}</span>

        <div className="flex-1" />

        {/* Color picker */}
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`w-5 h-5 rounded-full border-2 transition-transform ${
                strokeColor === c && !isErasing ? 'border-theme-accent scale-125' : 'border-transparent hover:scale-110'
              }`}
              style={{ backgroundColor: c }}
              onClick={() => { setStrokeColor(c); setIsErasing(false); }}
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
                strokeWidth === w && !isErasing ? 'border-theme-accent text-theme-accent' : 'border-theme-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => { setStrokeWidth(w); setIsErasing(false); }}
            >
              {w}px
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-theme-border mx-1" />

        {/* Tools */}
        <button
          className={`px-2 py-0.5 text-xs rounded border ${
            isErasing ? 'border-theme-accent text-theme-accent bg-theme-accent/10' : 'border-theme-border text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setIsErasing(!isErasing)}
        >
          {t('canvas.eraser')}
        </button>
        <button onClick={handleUndo} disabled={strokes.length === 0} className="px-2 py-0.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground disabled:opacity-30">
          {t('canvas.undo')}
        </button>
        <button onClick={handleRedo} disabled={undoneStrokes.length === 0} className="px-2 py-0.5 text-xs rounded border border-theme-border text-muted-foreground hover:text-foreground disabled:opacity-30">
          {t('canvas.redo')}
        </button>
        <button onClick={handleClear} disabled={strokes.length === 0} className="px-2 py-0.5 text-xs rounded border border-theme-border text-red-400 hover:text-red-300 disabled:opacity-30">
          {t('canvas.clear')}
        </button>

        <div className="w-px h-5 bg-theme-border mx-1" />

        <button
          onClick={handleSave}
          disabled={saving || strokes.length === 0}
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
      <div className="flex-1 overflow-hidden cursor-crosshair">
        <svg
          ref={svgRef}
          className="w-full h-full"
          style={{ touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
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
        </svg>
      </div>
    </div>
  );
}
