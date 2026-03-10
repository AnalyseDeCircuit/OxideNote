import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { useAgentStore } from '@/store/agentStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { Breadcrumb } from '@/components/editor/Breadcrumb';
import { Loader2, CheckCircle2, XCircle, Sparkles, Bot, Play, Clock, Database, RefreshCw } from 'lucide-react';
import { compileTypstToSvg, getVaultStats, repairVault, type VaultStats } from '@/lib/api';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { toast } from '@/hooks/useToast';

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
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);

  // Vault stats — loaded once and refreshed on file changes (debounced)
  const [vaultStats, setVaultStats] = useState<VaultStats | null>(null);
  const [repairing, setRepairing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStats = useCallback(() => {
    getVaultStats().then(setVaultStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (!vaultPath) return;
    refreshStats();

    // Debounced refresh on vault file changes via Tauri event
    const unlistenPromise = listen('vault:file-changed', () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(refreshStats, 3000);
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [vaultPath, refreshStats]);

  const handleRepairIndex = async () => {
    setRepairing(true);
    try {
      await repairVault();
      const stats = await getVaultStats();
      setVaultStats(stats);
      toast({ title: t('statusBar.indexRepaired') });
    } catch (err) {
      toast({ title: t('statusBar.indexRepairFailed'), description: String(err), variant: 'error' });
    } finally {
      setRepairing(false);
    }
  };

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

  // Trigger Typst compilation from status bar
  const handleCompile = async () => {
    if (!activeTabPath || !activeTabPath.endsWith('.typ')) return;
    useUIStore.getState().setCompileStatus('compiling');
    try {
      const result = await compileTypstToSvg(activeTabPath);
      useUIStore.getState().setCompileStatus('success', result.compile_time_ms);
    } catch {
      useUIStore.getState().setCompileStatus('error');
    }
  };

  // Open history via dashboard section
  const openHistory = () => {
    useUIStore.getState().setSidebarSection('dashboard');
  };

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

      {/* Compile trigger button (for .typ/.tex files) */}
      {isCompilable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCompile}
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              disabled={compileStatus === 'compiling'}
            >
              <Play size={11} />
              <span>{t('statusBar.compile')}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('statusBar.compile')}</TooltipContent>
        </Tooltip>
      )}

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

      {/* Quick access to note history */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={openHistory}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Clock size={11} />
            <span>{t('history.title')}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('history.title')}</TooltipContent>
      </Tooltip>

      {/* Vault index stats + repair */}
      {vaultStats && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleRepairIndex}
              disabled={repairing}
              className="flex items-center gap-1 hover:text-foreground transition-colors"
            >
              {repairing ? (
                <Loader2 size={11} className="animate-spin text-theme-accent" />
              ) : (
                <Database size={11} />
              )}
              <span>
                {t('statusBar.indexNotes', { count: vaultStats.total_notes })}
              </span>
              {vaultStats.orphan_notes > 0 && (
                <span className="text-yellow-500 flex items-center gap-0.5">
                  <RefreshCw size={10} />
                  {t('statusBar.indexOrphans', { count: vaultStats.orphan_notes })}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {repairing ? t('statusBar.indexRepairing') : t('statusBar.indexRepairHint')}
          </TooltipContent>
        </Tooltip>
      )}

      <span>{isDirty ? t('statusBar.unsaved') : t('statusBar.saved')}</span>
    </div>
  );
}
