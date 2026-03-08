/**
 * ImageLightbox — fullscreen image overlay triggered by clicking images in preview.
 *
 * Features:
 *   · Click backdrop or press Escape to close
 *   · Mouse wheel or +/- to zoom
 *   · Drag to pan when zoomed in
 *   · Double-click to reset zoom
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Zoom with mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.max(0.1, Math.min(10, s - e.deltaY * 0.001)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    setOffset((prev) => ({
      x: prev.x + e.clientX - lastPos.current.x,
      y: prev.y + e.clientY - lastPos.current.y,
    }));
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const resetZoom = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image lightbox"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
      onWheel={handleWheel}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Toolbar */}
      <div
        className="absolute top-4 right-4 flex items-center gap-2 z-[101]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          aria-label="Zoom in"
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={() => setScale((s) => Math.min(10, s + 0.25))}
        >
          <ZoomIn className="w-5 h-5" />
        </button>
        <button
          aria-label="Zoom out"
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={() => setScale((s) => Math.max(0.1, s - 0.25))}
        >
          <ZoomOut className="w-5 h-5" />
        </button>
        <button
          aria-label="Reset zoom"
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={resetZoom}
        >
          <RotateCcw className="w-5 h-5" />
        </button>
        <button
          aria-label="Close"
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={onClose}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Zoom indicator */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm bg-black/50 px-3 py-1 rounded-full">
        {Math.round(scale * 100)}%
      </div>

      {/* Image */}
      <img
        src={src}
        alt={alt || ''}
        className="max-w-[90vw] max-h-[90vh] object-contain select-none"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'default',
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={resetZoom}
        onMouseDown={handleMouseDown}
        draggable={false}
      />
    </div>
  );
}
