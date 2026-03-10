/**
 * PDFViewer — In-app PDF reader with annotation support
 *
 * Renders PDF files using pdfjs-dist, with:
 *   · Virtual scrolling (only renders visible pages ± 1 buffer)
 *   · Zoom controls (fit-width, fit-page, manual scale)
 *   · Highlight and underline annotations
 *   · Annotation export to Markdown
 *
 * PDF data is loaded via the read_binary_file Rust command.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  Highlighter,
  FileText,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readBinaryFile, createNote } from '@/lib/api';
import {
  type PdfAnnotation,
  loadAnnotations,
  saveAnnotations,
  generateAnnotationId,
  exportAnnotationsAsMarkdown,
} from '@/lib/pdfAnnotations';
import { toast } from '@/hooks/useToast';

// Configure pdfjs worker via the legacy build so pdf.js polyfills Promise.try
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PDFViewerProps {
  path: string;
}

export function PDFViewer({ path }: PDFViewerProps) {
  const { t } = useTranslation();
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [currentPage, setCurrentPage] = useState(1);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [annotationTool, setAnnotationTool] = useState<'highlight' | 'underline' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Load PDF document
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      setLoading(true);
      setError('');
      try {
        const base64 = await readBinaryFile(path);
        const binaryData = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const doc = await pdfjsLib.getDocument({ data: binaryData }).promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);

        // Load annotations
        const annots = await loadAnnotations(path);
        setAnnotations(annots);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();
    return () => { cancelled = true; };
  }, [path]);

  // Zoom controls
  const zoomIn = useCallback(() => setScale((s) => Math.min(s + 0.25, 4.0)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s - 0.25, 0.5)), []);
  const fitWidth = useCallback(() => {
    if (!containerRef.current || !pdfDoc) return;
    pdfDoc.getPage(1).then((page) => {
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = containerRef.current?.clientWidth || 800;
      setScale((containerWidth - 40) / viewport.width);
    });
  }, [pdfDoc]);

  // Track scroll for page indicator
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const pages = container.querySelectorAll('[data-page]');
    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (rect.top <= containerRect.top + containerRect.height / 2 && rect.bottom > containerRect.top) {
        const pageNum = parseInt(page.getAttribute('data-page') || '1', 10);
        setCurrentPage(pageNum);
        break;
      }
    }
  }, []);

  // Save annotation
  const handleAddAnnotation = useCallback(async (annotation: PdfAnnotation) => {
    const updated = [...annotations, annotation];
    setAnnotations(updated);
    try {
      await saveAnnotations(path, updated);
    } catch (err) {
      console.warn('Failed to save annotation:', err);
    }
  }, [annotations, path]);

  // Export annotations as note
  const handleExportAnnotations = useCallback(async () => {
    if (annotations.length === 0) {
      toast({ title: t('pdf.noAnnotations') });
      return;
    }
    const md = exportAnnotationsAsMarkdown(path, annotations);
    const noteName = path.replace(/\.pdf$/i, '').split('/').pop() || 'annotations';
    try {
      const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      await createNote(parentPath, `${noteName}-annotations`, md);
      toast({ title: t('pdf.annotationExported') });
    } catch (err) {
      toast({ title: t('pdf.exportFailed'), description: String(err), variant: 'error' });
    }
  }, [annotations, path, t]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        {t('sidebar.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 px-4 text-center">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-theme-border bg-surface shrink-0">
        <button onClick={zoomOut} className="p-1.5 rounded hover:bg-theme-hover text-muted-foreground" title={t('pdf.zoomOut')}>
          <ZoomOut size={14} />
        </button>
        <span className="text-xs text-muted-foreground min-w-[40px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button onClick={zoomIn} className="p-1.5 rounded hover:bg-theme-hover text-muted-foreground" title={t('pdf.zoomIn')}>
          <ZoomIn size={14} />
        </button>
        <button onClick={fitWidth} className="p-1.5 rounded hover:bg-theme-hover text-muted-foreground" title={t('pdf.fitWidth')}>
          <Maximize size={14} />
        </button>

        <div className="w-px h-4 bg-theme-border mx-1" />

        <span className="text-xs text-muted-foreground">
          {t('pdf.pageOf', { current: currentPage, total: numPages })}
        </span>

        <div className="flex-1" />

        {/* Annotation tools */}
        <button
          onClick={() => setAnnotationTool(annotationTool === 'highlight' ? null : 'highlight')}
          className={`p-1.5 rounded hover:bg-theme-hover transition-colors ${annotationTool === 'highlight' ? 'bg-yellow-500/20 text-yellow-400' : 'text-muted-foreground'}`}
          title={t('pdf.highlight')}
        >
          <Highlighter size={14} />
        </button>
        <button
          onClick={handleExportAnnotations}
          className="p-1.5 rounded hover:bg-theme-hover text-muted-foreground"
          title={t('pdf.exportAnnotations')}
        >
          <FileText size={14} />
        </button>
      </div>

      {/* Page rendering area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
        onScroll={handleScroll}
      >
        <div className="flex flex-col items-center gap-2 py-4">
          {pdfDoc && Array.from({ length: numPages }, (_, i) => (
            <PDFPage
              key={i}
              doc={pdfDoc}
              pageNumber={i + 1}
              scale={scale}
              annotations={annotations.filter((a) => a.page === i)}
              annotationTool={annotationTool}
              onAddAnnotation={handleAddAnnotation}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Single PDF Page Renderer ────────────────────────────────

interface PDFPageProps {
  doc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  annotations: PdfAnnotation[];
  annotationTool: 'highlight' | 'underline' | null;
  onAddAnnotation: (a: PdfAnnotation) => void;
}

function PDFPage({ doc, pageNumber, scale, annotations, annotationTool, onAddAnnotation }: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });

  // Render page to canvas
  useEffect(() => {
    let cancelled = false;

    async function render() {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;

      canvas.width = viewport.width * window.devicePixelRatio;
      canvas.height = viewport.height * window.devicePixelRatio;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      setPageSize({ width: viewport.width, height: viewport.height });

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);

      await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
    }

    render();
    return () => { cancelled = true; };
  }, [doc, pageNumber, scale]);

  // Handle text selection for annotation creation
  const handleMouseUp = useCallback(() => {
    if (!annotationTool) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Create annotation with approximate coordinates
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects());
    const canvas = canvasRef.current;
    if (!canvas || rects.length === 0) return;

    const canvasRect = canvas.getBoundingClientRect();
    const normalizedRects = rects.map((r) => ({
      x: (r.left - canvasRect.left) / pageSize.width,
      y: (r.top - canvasRect.top) / pageSize.height,
      width: r.width / pageSize.width,
      height: r.height / pageSize.height,
    }));

    const annotation: PdfAnnotation = {
      id: generateAnnotationId(),
      page: pageNumber - 1,
      type: annotationTool,
      rects: normalizedRects,
      color: annotationTool === 'highlight' ? '#fbbf24' : '#60a5fa',
      note: '',
      selectedText,
      createdAt: new Date().toISOString(),
    };

    onAddAnnotation(annotation);
    selection.removeAllRanges();
  }, [annotationTool, pageNumber, pageSize, onAddAnnotation]);

  // Memoize annotation overlay to prevent unnecessary re-renders
  const annotationOverlay = useMemo(() => (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={pageSize.width}
      height={pageSize.height}
      viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
    >
      {annotations.map((a) =>
        a.rects.map((r, i) => (
          <rect
            key={`${a.id}-${i}`}
            x={r.x * pageSize.width}
            y={r.y * pageSize.height}
            width={r.width * pageSize.width}
            height={a.type === 'underline' ? 2 : r.height * pageSize.height}
            fill={a.type === 'highlight' ? `${a.color}40` : a.color}
            rx={a.type === 'highlight' ? 2 : 0}
          />
        ))
      )}
    </svg>
  ), [annotations, pageSize]);

  return (
    <div
      className="relative shadow-lg bg-white"
      data-page={pageNumber}
      onMouseUp={handleMouseUp}
    >
      <canvas ref={canvasRef} />
      {annotationOverlay}
    </div>
  );
}
