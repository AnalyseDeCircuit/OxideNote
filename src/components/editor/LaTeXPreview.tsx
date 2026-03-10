// LaTeX compiled preview — compiles .tex files via external LaTeX compiler
// and displays the resulting PDF. Diagnostics (errors/warnings) are shown inline.
//
// If a compiled PDF already exists alongside the .tex file, it is loaded
// immediately to avoid unnecessary recompilation on open.
// On each file save (detected via vault:file-changed), triggers recompilation
// through the Rust backend `compileLatex()`, then renders the PDF output
// in-app with pdf.js (with zoom controls and selectable text layer).

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  compileLatex,
  detectLatexCompilers,
  type LatexCompileResult,
  type LatexDiagnostic,
  type DetectedCompiler,
} from '@/lib/api';
import {
  AlertTriangle,
  FileWarning,
  Clock,
  ChevronDown,
  ChevronRight,
  Terminal,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Maximize,
} from 'lucide-react';
import { toast } from '@/hooks/useToast';
import { getEditorView } from '@/lib/editorViewRef';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorSelection } from '@codemirror/state';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { readBinaryFile } from '@/lib/api';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Configure pdfjs worker with the legacy build so pdf.js polyfills Promise.try
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface LaTeXPreviewProps {
  /** Vault-relative path of the .tex file being previewed */
  path: string;
  className?: string;
}

/** Debounce before committing gesture zoom to React state */
const ZOOM_COMMIT_DELAY_MS = 200;

function clampPdfScale(scale: number): number {
  return Math.min(Math.max(scale, 0.5), 4.0);
}

/** Debounce interval (ms) before triggering recompilation */
const COMPILE_DEBOUNCE_MS = 600;

export function LaTeXPreview({ path, className }: LaTeXPreviewProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<LatexCompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compilers, setCompilers] = useState<DetectedCompiler[]>([]);
  const [selectedCompiler, setSelectedCompiler] = useState<string>('xelatex');
  const [showLog, setShowLog] = useState(false);
  const [showCompilerMenu, setShowCompilerMenu] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const lastPathRef = useRef(path);
  const compilerMenuRef = useRef<HTMLDivElement>(null);
  const compileCountRef = useRef(0);
  const selectedCompilerRef = useRef(selectedCompiler);
  selectedCompilerRef.current = selectedCompiler;

  // Detect available compilers on mount
  useEffect(() => {
    detectLatexCompilers().then((found) => {
      setCompilers(found);
      // Default to xelatex (best CJK support), fallback to first available
      if (found.length > 0) {
        const hasXelatex = found.some((c) => c.name === 'xelatex');
        setSelectedCompiler(hasXelatex ? 'xelatex' : found[0].name);
      }
    }).catch(() => {
      // No compilers found — user will see empty state
    });
  }, []);

  // Close compiler menu on outside click
  useEffect(() => {
    if (!showCompilerMenu) return;
    const handler = (e: MouseEvent) => {
      if (compilerMenuRef.current && !compilerMenuRef.current.contains(e.target as Node)) {
        setShowCompilerMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCompilerMenu]);

  // Compile the .tex file using the selected compiler
  const triggerCompile = useCallback(async (filePath: string, compiler?: string) => {
    setCompiling(true);
    setError(null);
    useUIStore.getState().setCompileStatus('compiling');
    try {
      const res = await compileLatex(filePath, compiler);
      setResult(res);
      compileCountRef.current += 1;

      // Determine compile status from diagnostics
      const hasErrors = res.diagnostics.some((d) => d.severity === 'error');
      useUIStore.getState().setCompileStatus(
        hasErrors ? 'error' : 'success',
        res.compile_time_ms,
      );

      // Store diagnostics in noteStore for chat context injection
      const mappedDiags = res.diagnostics.map((d) => ({
        line: d.line ?? 0,
        column: 0,
        severity: d.severity as 'error' | 'warning',
        message: d.message,
      }));
      useNoteStore.getState().setLastCompileDiagnostics(mappedDiags);

      // Dispatch diagnostics to CM6 lint layer for inline display
      const view = getEditorView();
      if (view && res.diagnostics.length > 0) {
        const doc = view.state.doc;
        const cmDiags = res.diagnostics
          .map((d) => {
            if (d.line == null || d.line < 1 || d.line > doc.lines) return null;
            const lineObj = doc.line(d.line);
            const from = lineObj.from;
            const to = Math.min(from + 1, lineObj.to);
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
        view.dispatch(setDiagnostics(view.state, []));
      }
    } catch (err) {
      setError(String(err));
      useUIStore.getState().setCompileStatus('error');
    } finally {
      setCompiling(false);
    }
  }, []);

  // Initial load: try existing PDF first, compile only if not found.
  // On compiler change, always recompile.
  const prevCompilerRef = useRef(selectedCompiler);
  useEffect(() => {
    let cancelled = false;
    const compilerChanged = prevCompilerRef.current !== selectedCompiler;
    prevCompilerRef.current = selectedCompiler;

    if (compilerChanged) {
      triggerCompile(path, selectedCompiler);
      return;
    }

    // Derive expected PDF path (same name, .pdf extension)
    const expectedPdf = path.replace(/\.tex$/i, '.pdf');

    // Try loading existing PDF without compiling
    readBinaryFile(expectedPdf)
      .then(() => {
        if (cancelled) return;
        setResult({
          pdf_path: expectedPdf,
          diagnostics: [],
          log_output: '',
          compile_time_ms: 0,
        });
      })
      .catch(() => {
        if (cancelled) return;
        triggerCompile(path, selectedCompiler);
      });

    return () => { cancelled = true; };
  }, [path, selectedCompiler, triggerCompile]);

  // Listen for file-changed events to recompile after saves
  // Uses ref for selectedCompiler to avoid tearing down the listener on compiler change
  useEffect(() => {
    lastPathRef.current = path;
    let disposed = false;

    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ path: string }>('vault:file-changed', (event) => {
        if (event.payload.path === path) {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            if (lastPathRef.current === path) {
              triggerCompile(path, selectedCompilerRef.current);
            }
          }, COMPILE_DEBOUNCE_MS);
        }
      }).then((fn) => {
        if (disposed) { fn(); } else { unlisten = fn; }
      });
    });

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      unlisten?.();
    };
  }, [path, triggerCompile]);

  // Listen for toolbar compile-request events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path === path) {
        triggerCompile(path, selectedCompilerRef.current);
      }
    };
    window.addEventListener('compile-request', handler);
    return () => window.removeEventListener('compile-request', handler);
  }, [path, triggerCompile]);

  const errors = result?.diagnostics.filter((d) => d.severity === 'error') ?? [];
  const warnings = result?.diagnostics.filter((d) => d.severity === 'warning') ?? [];

  // Manual recompile trigger
  const handleRecompile = useCallback(() => {
    triggerCompile(path, selectedCompiler);
  }, [path, selectedCompiler, triggerCompile]);

  return (
    <div className={`h-full flex flex-col overflow-hidden bg-background ${className ?? ''}`}>
      {/* Compilation status bar */}
      <div className="sticky top-0 z-10 px-3 py-1.5 text-xs border-b border-theme-border bg-surface flex items-center gap-3">
        {compiling && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock size={12} className="animate-spin" />
            {t('latex.compiling')}
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1 text-red-500 truncate max-w-[300px]">
            <FileWarning size={12} className="shrink-0" />
            <span className="truncate">{error}</span>
          </span>
        )}
        {errors.length > 0 && (
          <span className="flex items-center gap-1 text-red-500">
            <FileWarning size={12} />
            {t('latex.errorCount', { count: errors.length })}
          </span>
        )}
        {warnings.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDiagnostics((v) => !v)}
            className="flex items-center gap-1 text-yellow-500 hover:text-yellow-400 transition-colors"
          >
            <AlertTriangle size={12} />
            {t('latex.warningCount', { count: warnings.length })}
            {showDiagnostics ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
        {result && !compiling && !error && errors.length === 0 && (
          <span className="text-muted-foreground">
            {t('latex.compiled', { ms: result.compile_time_ms })}
          </span>
        )}

        <div className="flex-1" />

        {/* Compiler selector dropdown */}
        {compilers.length > 0 && (
          <div className="relative" ref={compilerMenuRef}>
            <button
              type="button"
              onClick={() => setShowCompilerMenu((v) => !v)}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-xs"
              title={t('latex.selectCompiler')}
            >
              <span className="font-mono">{selectedCompiler}</span>
              <ChevronDown size={10} />
            </button>
            {showCompilerMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[120px] bg-surface border border-theme-border rounded-lg shadow-lg py-1">
                {compilers.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-theme-hover transition-colors ${
                      c.name === selectedCompiler ? 'text-theme-accent' : 'text-foreground'
                    }`}
                    onClick={() => {
                      setSelectedCompiler(c.name);
                      setShowCompilerMenu(false);
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Manual recompile button */}
        <button
          type="button"
          onClick={handleRecompile}
          disabled={compiling}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title={t('latex.recompile')}
        >
          <RefreshCw size={12} className={compiling ? 'animate-spin' : ''} />
        </button>

        {/* Toggle build log */}
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className={`flex items-center gap-1 transition-colors ${
            showLog ? 'text-theme-accent' : 'text-muted-foreground hover:text-foreground'
          }`}
          title={t('latex.toggleLog')}
        >
          <Terminal size={12} />
        </button>
      </div>

      {/* Diagnostic details (collapsible) */}
      {showDiagnostics && (errors.length > 0 || warnings.length > 0) && (
        <div className="px-3 py-2 text-xs space-y-1 border-b border-theme-border bg-surface/50">
          {[...errors, ...warnings].map((d, i) => (
            <LatexDiagnosticLine key={`${d.severity}-${d.line ?? 'x'}-${i}`} diagnostic={d} />
          ))}
        </div>
      )}

      {/* Build log panel (collapsible) */}
      {showLog && result?.log_output && (
        <div className="max-h-[200px] overflow-auto border-b border-theme-border bg-black/80 px-3 py-2">
          <pre className="text-[10px] leading-relaxed text-green-400 font-mono whitespace-pre-wrap break-all">
            {result.log_output}
          </pre>
        </div>
      )}

      {/* PDF preview area */}
      <div className="flex-1 min-h-0 overflow-auto">
        {result && !error && errors.length === 0 && result.pdf_path ? (
          <PdfPreview pdfRelPath={result.pdf_path} key={compileCountRef.current} />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            {compiling ? (
              <span className="flex items-center gap-2">
                <Clock size={16} className="animate-spin" />
                {t('latex.compiling')}
              </span>
            ) : error ? (
              <span className="text-center px-4 max-w-md">
                <FileWarning size={24} className="mx-auto mb-2 text-red-400" />
                <p className="text-red-400">{error}</p>
              </span>
            ) : errors.length > 0 ? (
              <span className="text-center">
                <FileWarning size={24} className="mx-auto mb-2 text-red-400" />
                <p className="text-red-400">{t('latex.fixErrors')}</p>
              </span>
            ) : compilers.length === 0 ? (
              <span className="text-center px-4">
                <p>{t('latex.noCompiler')}</p>
                <p className="text-xs mt-1 text-muted-foreground/60">
                  {t('latex.noCompilerHint')}
                </p>
              </span>
            ) : (
              <span>{t('latex.emptyOutput')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PDF viewer with zoom controls and selectable text layer ─────────────

function PdfPreview({ pdfRelPath }: { pdfRelPath: string }) {
  const { t } = useTranslation();
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Two-phase zoom: renderScale drives canvas rendering,
  // liveScaleRef tracks visual scale during gesture (via CSS zoom).
  const [renderScale, setRenderScale] = useState(1.5);
  const liveScaleRef = useRef(1.5);
  const renderScaleRef = useRef(1.5);
  renderScaleRef.current = renderScale;
  const [displayPercent, setDisplayPercent] = useState(150);
  const gestureCommitTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  // Mirror pdfDoc in a ref so cleanup can access the latest value
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  pdfDocRef.current = pdfDoc;

  // Load PDF binary via Rust backend
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    liveScaleRef.current = 1.5;
    setRenderScale(1.5);
    setDisplayPercent(150);
    if (gestureCommitTimerRef.current) clearTimeout(gestureCommitTimerRef.current);

    readBinaryFile(pdfRelPath)
      .then(async (base64) => {
        if (cancelled) return;
        const binaryData = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const doc = await pdfjsLib.getDocument({ data: binaryData }).promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        setPdfDoc(doc);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      // Destroy previous doc to avoid leaking worker threads
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
  }, [pdfRelPath]);

  // Render all pages (canvas + text layer) when doc or render scale changes.
  // Double-buffered: renders into a new container, then swaps to avoid flash.
  const prevRenderScaleRef = useRef(renderScale);
  useEffect(() => {
    if (!pdfDoc || !pagesRef.current) return;
    let cancelled = false;
    const oldContainer = pagesRef.current;
    const textLayers: pdfjsLib.TextLayer[] = [];
    const scrollHost = containerRef.current;
    // Capture scroll position while CSS zoom is still active.
    // Scale it back to render-space so we can restore it at the new scale.
    const cssZoom = liveScaleRef.current / prevRenderScaleRef.current;
    const savedScrollLeft = (scrollHost?.scrollLeft ?? 0) / cssZoom;
    const savedScrollTop = (scrollHost?.scrollTop ?? 0) / cssZoom;
    prevRenderScaleRef.current = renderScale;

    // Build new pages into a document fragment (off-screen)
    const fragment = document.createDocumentFragment();

    const renderPages = async () => {
      const dpr = window.devicePixelRatio || 1;

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        if (cancelled) break;
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: renderScale });

        // Page wrapper (relative positioning for text layer overlay)
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-preview-page relative mx-auto shadow-lg rounded bg-white mb-4';
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;
        wrapper.dataset.pageIndex = String(i - 1);

        // Canvas — HiDPI rendering
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        wrapper.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          await page.render({
            canvasContext: ctx,
            viewport,
            canvas,
          } as Parameters<typeof page.render>[0]).promise;
        }

        // Text layer uses CSS-pixel viewport (same as canvas CSS dimensions)
        if (!cancelled) {
          const textContent = await page.getTextContent();
          const textDiv = document.createElement('div');
          textDiv.className = 'oxide-pdf-text-layer';
          textDiv.style.width = `${viewport.width}px`;
          textDiv.style.height = `${viewport.height}px`;
          wrapper.appendChild(textDiv);

          const textLayer = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textDiv,
            viewport,
          });
          textLayers.push(textLayer);
          await textLayer.render();
        }

        if (!cancelled) {
          fragment.appendChild(wrapper);
        }
      }

      // Swap: replace old pages with new ones in a single DOM operation
      if (!cancelled) {
        oldContainer.innerHTML = '';
        oldContainer.style.zoom = '';
        oldContainer.appendChild(fragment);
        liveScaleRef.current = renderScale;

        // Restore scroll position scaled to new render dimensions
        if (scrollHost) {
          const scaleFactor = renderScale / (prevRenderScaleRef.current || renderScale);
          scrollHost.scrollLeft = savedScrollLeft * scaleFactor;
          scrollHost.scrollTop = savedScrollTop * scaleFactor;
        }
      }
    };

    renderPages();
    return () => {
      cancelled = true;
      // Cancel any in-progress text layer renders
      for (const tl of textLayers) {
        tl.cancel();
      }
    };
  }, [pdfDoc, renderScale]);

  // Zoom handlers (button zoom commits immediately)
  const zoomIn = useCallback(() => {
    const next = clampPdfScale(liveScaleRef.current + 0.25);
    liveScaleRef.current = next;
    setRenderScale(next);
    setDisplayPercent(Math.round(next * 100));
  }, []);
  const zoomOut = useCallback(() => {
    const next = clampPdfScale(liveScaleRef.current - 0.25);
    liveScaleRef.current = next;
    setRenderScale(next);
    setDisplayPercent(Math.round(next * 100));
  }, []);
  const fitWidth = useCallback(() => {
    if (!containerRef.current || !pdfDoc) return;
    pdfDoc.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1.0 });
      const containerWidth = containerRef.current?.clientWidth || 800;
      const next = clampPdfScale((containerWidth - 40) / vp.width);
      liveScaleRef.current = next;
      setRenderScale(next);
      setDisplayPercent(Math.round(next * 100));
    });
  }, [pdfDoc]);

  // Pinch-to-zoom with CSS zoom for macOS-native feel.
  // During gesture: apply CSS zoom for instant visual feedback (no canvas re-render).
  // After 200ms idle: commit to React state for crisp canvas rendering.
  useEffect(() => {
    const el = containerRef.current;
    const pages = pagesRef.current;
    if (!el || !pages) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const oldLive = liveScaleRef.current;
      // Exponential zoom for natural feel (same gesture distance = same visual ratio)
      const factor = Math.exp(-e.deltaY * 0.005);
      const newLive = clampPdfScale(oldLive * factor);
      if (newLive === oldLive) return;

      // Read scroll/rect BEFORE writing CSS zoom to avoid forced synchronous reflow
      const rect = el.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      const scrollLeft = el.scrollLeft;
      const scrollTop = el.scrollTop;

      liveScaleRef.current = newLive;

      // CSS zoom for instant visual feedback without canvas re-render
      pages.style.zoom = String(newLive / renderScaleRef.current);

      // Scroll anchoring: keep point under cursor stable
      const ratio = newLive / oldLive;
      el.scrollLeft = (scrollLeft + offsetX) * ratio - offsetX;
      el.scrollTop = (scrollTop + offsetY) * ratio - offsetY;

      setDisplayPercent(Math.round(newLive * 100));

      // Debounced commit — re-render canvases at final scale for crisp output
      if (gestureCommitTimerRef.current) clearTimeout(gestureCommitTimerRef.current);
      gestureCommitTimerRef.current = setTimeout(() => {
        setRenderScale(newLive);
      }, ZOOM_COMMIT_DELAY_MS);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
      if (gestureCommitTimerRef.current) clearTimeout(gestureCommitTimerRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        <Clock size={14} className="animate-spin mr-2" />
        {t('latex.loadingPdf')}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 text-sm px-4 text-center">
        <FileWarning size={16} className="mr-2 shrink-0" />
        {loadError}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Zoom toolbar */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-theme-border bg-surface shrink-0">
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
        <span className="text-[10px] text-muted-foreground/50 ml-1">
          {pdfDoc ? `${pdfDoc.numPages}p` : ''}
        </span>
      </div>

      {/* Page rendering area */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <div ref={pagesRef} className="p-4" />
      </div>
    </div>
  );
}

// Compact diagnostic line showing location + message
function LatexDiagnosticLine({ diagnostic }: { diagnostic: LatexDiagnostic }) {
  const isError = diagnostic.severity === 'error';

  const handleClick = useCallback(() => {
    if (diagnostic.line == null) return;
    const view = getEditorView();
    if (!view) return;
    const lineCount = view.state.doc.lines;
    const targetLine = Math.min(diagnostic.line, lineCount);
    if (targetLine < 1) return;
    const lineObj = view.state.doc.line(targetLine);
    view.dispatch({
      selection: EditorSelection.cursor(lineObj.from),
      scrollIntoView: true,
    });
    view.focus();
  }, [diagnostic.line]);

  return (
    <div
      className={`flex items-start gap-2 cursor-pointer hover:opacity-80 ${
        isError ? 'text-red-400' : 'text-yellow-400'
      }`}
      onClick={handleClick}
    >
      {diagnostic.line != null && (
        <span className="font-mono shrink-0">L{diagnostic.line}</span>
      )}
      <span className="break-words">{diagnostic.message}</span>
    </div>
  );
}
