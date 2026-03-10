import { useMemo } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { useAgentStore } from '@/store/agentStore';
import { useTranslation } from 'react-i18next';
import { Breadcrumb } from '@/components/editor/Breadcrumb';
import { Loader2, CheckCircle2, XCircle, Sparkles, Bot } from 'lucide-react';

export function StatusBar() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const activeContent = useNoteStore((s) => s.activeContent);
  const cursorLine = useNoteStore((s) => s.cursorLine);
  const cursorCol = useNoteStore((s) => s.cursorCol);
  const openTabs = useNoteStore((s) => s.openTabs);
  const compileStatus = useUIStore((s) => s.compileStatus);
  const compileTimeMs = useUIStore((s) => s.compileTimeMs);
  const aiGenerating = useUIStore((s) => s.aiGenerating);
  const agentRunning = useAgentStore((s) => s.isRunning);

  const activeTab = openTabs.find((tab) => tab.path === activeTabPath);
  const isDirty = activeTab?.isDirty ?? false;

  const wordCount = useMemo(() => {
    if (!activeContent) return 0;
    // Count CJK characters individually and split Latin words by whitespace
    const cjk = activeContent.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
    const latin = activeContent
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return (cjk?.length ?? 0) + latin.length;
  }, [activeContent]);

  if (!activeTabPath) return null;

  // Detect if current file is a compilable document
  const isCompilable = activeTabPath.endsWith('.typ') || activeTabPath.endsWith('.tex');

  return (
    <div className="h-7 flex items-center px-4 gap-4 border-t border-theme-border bg-surface text-[11px] text-muted-foreground select-none shrink-0">
      <Breadcrumb path={activeTabPath} />
      <span className="mx-1 text-muted-foreground/30">|</span>
      <span>
        Ln {cursorLine}, Col {cursorCol}
      </span>
      <span>
        {wordCount} {t('statusBar.words')}
      </span>

      {/* Compilation status indicator (for .typ/.tex files) */}
      {isCompilable && compileStatus && (
        <span className="flex items-center gap-1">
          {compileStatus === 'compiling' && (
            <>
              <Loader2 size={12} className="animate-spin text-theme-accent" />
              <span className="text-theme-accent">{t('statusBar.compiling')}</span>
            </>
          )}
          {compileStatus === 'success' && (
            <>
              <CheckCircle2 size={12} className="text-green-500" />
              <span className="text-green-500">
                {t('statusBar.compiled')}
                {compileTimeMs != null && ` (${compileTimeMs}ms)`}
              </span>
            </>
          )}
          {compileStatus === 'error' && (
            <>
              <XCircle size={12} className="text-red-500" />
              <span className="text-red-500">{t('statusBar.compileError')}</span>
            </>
          )}
        </span>
      )}

      {/* AI generating indicator */}
      {aiGenerating && (
        <span className="flex items-center gap-1 text-theme-accent">
          <Sparkles size={12} className="animate-pulse" />
          <span>{t('statusBar.aiGenerating')}</span>
        </span>
      )}

      {/* Agent running indicator */}
      {agentRunning && (
        <span className="flex items-center gap-1 text-theme-accent">
          <Bot size={12} className="animate-pulse" />
          <span>{t('statusBar.agentRunning')}</span>
        </span>
      )}

      <div className="flex-1" />
      <span>{isDirty ? t('statusBar.unsaved') : t('statusBar.saved')}</span>
    </div>
  );
}
