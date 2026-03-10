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

  // Compile on path change (debounced to avoid rapid fire during saves)
  const triggerCompile = useCallback(async (filePath: string) => {
    setCompiling(true);
    setError(null);
    try {
      const res = await compileTypstToSvg(filePath);
      setResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setCompiling(false);
    }
  }, []);

  // Recompile when path changes or content is saved (via vault:file-changed)
  useEffect(() => {
    lastPathRef.current = path;

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
      }).then((fn) => { unlisten = fn; });
    });

    return () => {
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
      <div className="p-4 flex flex-col items-center gap-4">
        {result?.pages.map((svg, i) => (
          <div
            key={i}
            className="w-full max-w-[800px] bg-white shadow-md rounded"
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
