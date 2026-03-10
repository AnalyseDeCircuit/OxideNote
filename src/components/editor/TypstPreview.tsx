// Typst compiled preview — renders SVG output of .typ files.
//
// On each content change (debounced), sends the source to the Rust backend
// for compilation via `compileTypstToSvg()`, then renders the resulting
// SVG pages. Diagnostics (errors/warnings) are shown inline.

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { compileTypstToSvg, compileTypstToPdf, type TypstCompileResult, type TypstDiagnostic } from '@/lib/api';
import { AlertTriangle, FileWarning, Clock, FileDown, ZoomIn, ZoomOut, Maximize, ChevronDown, ChevronRight } from 'lucide-react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { toast } from '@/hooks/useToast';
import DOMPurify from 'dompurify';
import { getEditorView } from '@/lib/editorViewRef';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorSelection } from '@codemirror/state';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';

interface TypstPreviewProps {
  /** Vault-relative path of the .typ file being previewed */
  path: string;
  className?: string;
}

interface SvgPageSize {
  width: number;
  height: number;
}

/** Debounce interval (ms) before triggering recompilation */
const COMPILE_DEBOUNCE_MS = 400;
/** Debounce before committing gesture zoom to React state */
const ZOOM_COMMIT_DELAY_MS = 200;
const MIN_SVG_SCALE = 0.25;
const MAX_SVG_SCALE = 4.0;

/** Sanitize SVG output from the Typst compiler, stripping scripts and event handlers */
function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
  });
}

function extractSvgPageSize(raw: string): SvgPageSize | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'image/svg+xml');
  const svg = doc.documentElement;

  if (svg.tagName.toLowerCase() !== 'svg') {
    return null;
  }

  const widthAttr = svg.getAttribute('width');
  const heightAttr = svg.getAttribute('height');
  const parsedWidth = widthAttr ? parseSvgLength(widthAttr) : null;
  const parsedHeight = heightAttr ? parseSvgLength(heightAttr) : null;

  if (parsedWidth && parsedHeight) {
    return { width: parsedWidth, height: parsedHeight };
  }

  const viewBox = svg.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3])) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  return null;
}

function parseSvgLength(value: string): number | null {
  const match = value.trim().match(/^([0-9]*\.?[0-9]+)(px|pt|pc|mm|cm|in)?$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = (match[2] ?? 'px').toLowerCase();
  switch (unit) {
    case 'px':
      return amount;
    case 'pt':
      return amount * (96 / 72);
    case 'pc':
      return amount * 16;
    case 'mm':
      return amount * (96 / 25.4);
    case 'cm':
      return amount * (96 / 2.54);
    case 'in':
      return amount * 96;
    default:
      return null;
  }
}

// Module-level cache: avoids recompilation when switching tabs and returning.
// Key = vault-relative path, value = last successful compile result.
const typstResultCache = new Map<string, TypstCompileResult>();

function clampSvgScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_SVG_SCALE), MAX_SVG_SCALE);
}

export function TypstPreview({ path, className }: TypstPreviewProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<TypstCompileResult | null>(
    // Restore cached result for instant display on remount
    () => typstResultCache.get(path) ?? null,
  );
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const lastPathRef = useRef(path);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const sourceMappingRef = useRef<[number, number][]>([]);
  // Two-phase zoom: committedScale drives React rendering (SVG page sizes),
  // liveScaleRef tracks the visual scale during gesture (applied via CSS zoom).
  const [committedScale, setCommittedScale] = useState(1.0);
  const liveScaleRef = useRef(1.0);
  const committedScaleRef = useRef(1.0);
  committedScaleRef.current = committedScale;
  const [displayPercent, setDisplayPercent] = useState(100);
  const gestureCommitTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [pageSizes, setPageSizes] = useState<Array<SvgPageSize | null>>(
    () => (typstResultCache.get(path)?.pages ?? []).map(extractSvgPageSize),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(true);

  // Compile on path change (debounced to avoid rapid fire during saves)
  const triggerCompile = useCallback(async (filePath: string) => {
    setCompiling(true);
    setError(null);
    // Update status bar compile indicator
    useUIStore.getState().setCompileStatus('compiling');
    try {
      const res = await compileTypstToSvg(filePath);
      setResult(res);
      typstResultCache.set(filePath, res);
      sourceMappingRef.current = res.source_mapping ?? [];

      // Update status bar with result
      const hasErrors = res.diagnostics.some((d) => d.severity === 'error');
      useUIStore.getState().setCompileStatus(
        hasErrors ? 'error' : 'success',
        res.compile_time_ms,
      );

      // Store diagnostics in noteStore for chat context injection
      useNoteStore.getState().setLastCompileDiagnostics(res.diagnostics);

      // Dispatch diagnostics to CM6 lint layer for inline display
      const view = getEditorView();
      if (view && res.diagnostics.length > 0) {
        const doc = view.state.doc;
        const cmDiags = res.diagnostics
          .map((d) => {
            // Convert 1-based line/column to 0-based offset
            if (d.line < 1 || d.line > doc.lines) return null;
            const lineObj = doc.line(d.line);
            const from = Math.min(lineObj.from + Math.max(0, d.column - 1), lineObj.to);
            const to = Math.min(from + 1, lineObj.to); // Underline at least 1 char
            return {
              from,
              to,
              severity: d.severity as Diagnostic['severity'],
              message: d.message,
            };
          })
          .filter((d): d is Diagnostic => d !== null);
        view.dispatch(setDiagnostics(view.state, cmDiags));
      } else if (view) {
        // Clear diagnostics on successful compile
        view.dispatch(setDiagnostics(view.state, []));
      }
    } catch (err) {
      setError(String(err));
      useUIStore.getState().setCompileStatus('error');
    } finally {
      setCompiling(false);
    }
  }, []);

  // Recompile when path changes or content is saved (via vault:file-changed)
  useEffect(() => {
    lastPathRef.current = path;
    let disposed = false;
    const cachedResult = typstResultCache.get(path) ?? null;

    liveScaleRef.current = 1.0;
    setCommittedScale(1.0);
    setDisplayPercent(100);
    if (gestureCommitTimerRef.current) clearTimeout(gestureCommitTimerRef.current);
    setResult(cachedResult);
    setPageSizes((cachedResult?.pages ?? []).map(extractSvgPageSize));
    sourceMappingRef.current = cachedResult?.source_mapping ?? [];
    setError(null);

    // Initial compile (only if no cached result available)
    if (!typstResultCache.has(path)) {
      triggerCompile(path);
    }

    // Listen for file-changed events to recompile after saves
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ path: string }>('vault:file-changed', (event) => {
        if (event.payload.path === path) {
          // Debounce to coalesce rapid watcher events
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            if (lastPathRef.current === path) {
              triggerCompile(path);
            }
          }, COMPILE_DEBOUNCE_MS);
        }
      }).then((fn) => {
        // If component already unmounted, unregister immediately
        if (disposed) { fn(); } else { unlisten = fn; }
      });
    });

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      unlisten?.();
    };
  }, [path, triggerCompile]);

  useEffect(() => {
    setPageSizes((result?.pages ?? []).map(extractSvgPageSize));
  }, [result]);

  // After React re-renders with new committed scale, remove CSS gesture zoom
  useLayoutEffect(() => {
    const pages = pagesContainerRef.current;
    if (pages) {
      pages.style.zoom = '';
    }
    liveScaleRef.current = committedScale;
  }, [committedScale]);

  // Listen for toolbar compile-request events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path === path) {
        triggerCompile(path);
      }
    };
    window.addEventListener('compile-request', handler);
    return () => window.removeEventListener('compile-request', handler);
  }, [path, triggerCompile]);

  const errors = result?.diagnostics.filter(d => d.severity === 'error') ?? [];
  const warnings = result?.diagnostics.filter(d => d.severity === 'warning') ?? [];

  // Export the current .typ file to PDF via save dialog
  const handleExportPdf = useCallback(async () => {
    const defaultName = path.replace(/\.typ$/i, '.pdf').split('/').pop() ?? 'output.pdf';
    const outPath = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!outPath) return;
    try {
      await compileTypstToPdf(path, outPath);
      toast({ title: t('typst.exportSuccess') });
    } catch (err) {
      toast({ title: t('typst.exportFailed'), description: String(err), variant: 'error' });
    }
  }, [path, t]);

  // Reverse search: click on a page → jump editor to the corresponding source line
  const handlePageClick = useCallback((pageIndex: number) => {
    const mapping = sourceMappingRef.current;
    if (pageIndex < 0 || pageIndex >= mapping.length) return;

    const [startLine] = mapping[pageIndex];
    const view = getEditorView();
    if (!view) return;

    // Jump to the start of the mapped source line (1-based → 0-based)
    const lineCount = view.state.doc.lines;
    const targetLine = Math.min(startLine, lineCount);
    if (targetLine < 1) return;

    const lineObj = view.state.doc.line(targetLine);
    view.dispatch({
      selection: EditorSelection.cursor(lineObj.from),
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  // Forward search: listen to editor cursor changes → scroll preview to matching page
  // Uses polling with change detection to avoid CM6 listener coupling
  useEffect(() => {
    let lastCursorLine = -1;

    const interval = setInterval(() => {
      const mapping = sourceMappingRef.current;
      if (mapping.length === 0) return;

      const view = getEditorView();
      if (!view) return;

      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
      // Skip if cursor hasn't moved to a new line
      if (cursorLine === lastCursorLine) return;
      lastCursorLine = cursorLine;

      // Find which page contains this source line
      const pageIndex = mapping.findIndex(
        ([start, end]) => cursorLine >= start && cursorLine <= end,
      );
      if (pageIndex < 0) return;

      // Scroll the corresponding page element into view
      const container = pagesContainerRef.current;
      if (!container) return;
      const pageEl = container.children[pageIndex] as HTMLElement | undefined;
      pageEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 500);

    return () => clearInterval(interval);
  }, [result]);

  // Zoom controls for SVG pages (button zoom commits immediately)
  const zoomIn = useCallback(() => {
    const next = clampSvgScale(liveScaleRef.current + 0.25);
    liveScaleRef.current = next;
    setCommittedScale(next);
    setDisplayPercent(Math.round(next * 100));
  }, []);
  const zoomOut = useCallback(() => {
    const next = clampSvgScale(liveScaleRef.current - 0.25);
    liveScaleRef.current = next;
    setCommittedScale(next);
    setDisplayPercent(Math.round(next * 100));
  }, []);
  const fitWidth = useCallback(() => {
    const container = scrollContainerRef.current;
    const intrinsicWidth = pageSizes[0]?.width;
    if (!container || intrinsicWidth == null || intrinsicWidth <= 0) return;
    const availableWidth = container.clientWidth - 48;
    const next = clampSvgScale(availableWidth / intrinsicWidth);
    liveScaleRef.current = next;
    setCommittedScale(next);
    setDisplayPercent(Math.round(next * 100));
  }, [pageSizes]);

  // Pinch-to-zoom with CSS zoom for macOS-native feel.
  // During gesture: apply CSS zoom for instant visual feedback (no React re-render).
  // After 200ms idle: commit to React state for correct SVG page sizing.
  useEffect(() => {
    const el = scrollContainerRef.current;
    const pages = pagesContainerRef.current;
    if (!el || !pages) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const oldLive = liveScaleRef.current;
      // Exponential zoom for natural feel (same gesture distance = same visual ratio)
      const factor = Math.exp(-e.deltaY * 0.005);
      const newLive = clampSvgScale(oldLive * factor);
      if (newLive === oldLive) return;

      // Read scroll/rect BEFORE writing CSS zoom to avoid forced synchronous reflow
      const rect = el.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      const scrollLeft = el.scrollLeft;
      const scrollTop = el.scrollTop;

      liveScaleRef.current = newLive;

      // CSS zoom for instant visual feedback without React re-render
      pages.style.zoom = String(newLive / committedScaleRef.current);

      // Scroll anchoring: keep point under cursor stable
      const ratio = newLive / oldLive;
      el.scrollLeft = (scrollLeft + offsetX) * ratio - offsetX;
      el.scrollTop = (scrollTop + offsetY) * ratio - offsetY;

      setDisplayPercent(Math.round(newLive * 100));

      // Debounced commit — re-render SVG pages at final scale for crisp output
      if (gestureCommitTimerRef.current) clearTimeout(gestureCommitTimerRef.current);
      gestureCommitTimerRef.current = setTimeout(() => {
        setCommittedScale(newLive);
      }, ZOOM_COMMIT_DELAY_MS);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
      if (gestureCommitTimerRef.current) clearTimeout(gestureCommitTimerRef.current);
    };
  }, []);

  return (
    <div
      className={`h-full flex flex-col bg-background ${className ?? ''}`}
    >
      {/* Compilation status bar */}
      <div className="sticky top-0 z-10 px-3 py-1.5 text-xs border-b border-theme-border bg-surface flex items-center gap-3">
        {compiling && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock size={12} className="animate-spin" />
            {t('typst.compiling')}
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1 text-red-500">
            <FileWarning size={12} />
            {error}
          </span>
        )}
        {errors.length > 0 && (
          <span className="flex items-center gap-1 text-red-500">
            <FileWarning size={12} />
            {t('typst.errorCount', { count: errors.length })}
          </span>
        )}
        {warnings.length > 0 && (
          <button
            onClick={() => setShowDiagnostics((v) => !v)}
            className="flex items-center gap-1 text-yellow-500 hover:text-yellow-400 transition-colors"
          >
            <AlertTriangle size={12} />
            {t('typst.warningCount', { count: warnings.length })}
            {showDiagnostics ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
        {result && !compiling && !error && errors.length === 0 && (
          <span className="text-muted-foreground">
            {t('typst.compiled', { ms: result.compile_time_ms })}
          </span>
        )}
        <div className="flex-1" />

        {/* Zoom controls */}
        <button onClick={zoomOut} className="p-1 rounded hover:bg-theme-hover text-muted-foreground" title={t('pdf.zoomOut')}>
          <ZoomOut size={13} />
        </button>
        <span className="text-xs text-muted-foreground min-w-[36px] text-center select-none">
          {displayPercent}%
        </span>
        <button onClick={zoomIn} className="p-1 rounded hover:bg-theme-hover text-muted-foreground" title={t('pdf.zoomIn')}>
          <ZoomIn size={13} />
        </button>
        <button onClick={fitWidth} className="p-1 rounded hover:bg-theme-hover text-muted-foreground" title={t('pdf.fitWidth')}>
          <Maximize size={13} />
        </button>

        <div className="w-px h-4 bg-theme-border mx-0.5" />

        <button
          onClick={handleExportPdf}
          disabled={compiling}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title={t('typst.exportPdf')}
        >
          <FileDown size={12} />
          {t('typst.exportPdf')}
        </button>
      </div>

      {/* Diagnostic details (collapsible) */}
      {showDiagnostics && (errors.length > 0 || warnings.length > 0) && (
        <div className="px-3 py-2 text-xs space-y-1 border-b border-theme-border bg-surface/50">
          {[...errors, ...warnings].map((d, i) => (
            <DiagnosticLine key={i} diagnostic={d} />
          ))}
        </div>
      )}

      {/* SVG pages — scaled via CSS width to avoid layout gaps */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        <div ref={pagesContainerRef} className="p-4 flex flex-col items-center gap-4">
          {result?.pages.map((svg, i) => {
            const pageSize = pageSizes[i];
            const pageWidth = pageSize ? pageSize.width * committedScale : undefined;
            const pageHeight = pageSize ? pageSize.height * committedScale : undefined;

            return (
              <div
                key={i}
                className="typst-preview-page bg-white shadow-md rounded cursor-pointer overflow-hidden"
                style={{
                  width: pageWidth ? `${pageWidth}px` : undefined,
                  height: pageHeight ? `${pageHeight}px` : undefined,
                }}
                data-page-index={i}
                onClick={() => handlePageClick(i)}
                dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }}
              />
            );
          })}
          {result?.pages.length === 0 && !compiling && !error && (
            <div className="text-muted-foreground text-sm py-8">
              {t('typst.emptyOutput')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact diagnostic line showing location + message
function DiagnosticLine({ diagnostic }: { diagnostic: TypstDiagnostic }) {
  const isError = diagnostic.severity === 'error';
  return (
    <div className={`flex items-start gap-2 ${isError ? 'text-red-400' : 'text-yellow-400'}`}>
      <span className="font-mono shrink-0">
        {diagnostic.line}:{diagnostic.column}
      </span>
      <span className="break-words">{diagnostic.message}</span>
    </div>
  );
}
