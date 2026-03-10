// Typst compiled preview — renders SVG output of .typ files.
//
// On each content change (debounced), sends the source to the Rust backend
// for compilation via `compileTypstToSvg()`, then renders the resulting
// SVG pages. Diagnostics (errors/warnings) are shown inline.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { compileTypstToSvg, compileTypstToPdf, type TypstCompileResult, type TypstDiagnostic } from '@/lib/api';
import { AlertTriangle, FileWarning, Clock, FileDown } from 'lucide-react';
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

/** Debounce interval (ms) before triggering recompilation */
const COMPILE_DEBOUNCE_MS = 400;

/** Sanitize SVG output from the Typst compiler, stripping scripts and event handlers */
function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
  });
}

export function TypstPreview({ path, className }: TypstPreviewProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<TypstCompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const lastPathRef = useRef(path);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const sourceMappingRef = useRef<[number, number][]>([]);

  // Compile on path change (debounced to avoid rapid fire during saves)
  const triggerCompile = useCallback(async (filePath: string) => {
    setCompiling(true);
    setError(null);
    // Update status bar compile indicator
    useUIStore.getState().setCompileStatus('compiling');
    try {
      const res = await compileTypstToSvg(filePath);
      setResult(res);
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

    // Initial compile
    triggerCompile(path);

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

  return (
    <div
      className={`h-full overflow-auto bg-background ${className ?? ''}`}
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
          <span className="flex items-center gap-1 text-yellow-500">
            <AlertTriangle size={12} />
            {t('typst.warningCount', { count: warnings.length })}
          </span>
        )}
        {result && !compiling && !error && errors.length === 0 && (
          <span className="text-muted-foreground">
            {t('typst.compiled', { ms: result.compile_time_ms })}
          </span>
        )}
        <div className="flex-1" />
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

      {/* Diagnostic details */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="px-3 py-2 text-xs space-y-1 border-b border-theme-border bg-surface/50">
          {[...errors, ...warnings].map((d, i) => (
            <DiagnosticLine key={i} diagnostic={d} />
          ))}
        </div>
      )}

      {/* SVG pages */}
      <div ref={pagesContainerRef} className="p-4 flex flex-col items-center gap-4">
        {result?.pages.map((svg, i) => (
          <div
            key={i}
            className="w-full max-w-[800px] bg-white shadow-md rounded cursor-pointer"
            data-page-index={i}
            onClick={() => handlePageClick(i)}
            dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }}
          />
        ))}
        {result?.pages.length === 0 && !compiling && !error && (
          <div className="text-muted-foreground text-sm py-8">
            {t('typst.emptyOutput')}
          </div>
        )}
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
