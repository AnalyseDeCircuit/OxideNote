import { useEffect, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot, Play, Square, Check, X, ChevronDown, ChevronRight,
  FileText, FolderOpen, Globe, Clock, Settings, Pause,
} from 'lucide-react';

import { useAgentStore } from '@/store/agentStore';
import { useNoteStore } from '@/store/noteStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useChatStore } from '@/store/chatStore';
import { useUIStore } from '@/store/uiStore';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import type { AgentKind, AgentStatus, AgentTask, PlanStep, ProposedChange } from '@/lib/api';

// ── Status → i18n key mapping ───────────────────────────────
// AgentStatus values don't map 1:1 to locale keys, so we use an explicit map

const STATUS_I18N: Record<AgentStatus, string> = {
  planning: 'agent.progress.planning',
  executing: 'agent.progress.executing',
  paused: 'agent.progress.paused',
  waiting_approval: 'agent.progress.complete',
  completed: 'agent.progress.complete',
  failed: 'agent.progress.error',
  aborted: 'agent.progress.aborted',
};

// ── Built-in agent definitions ──────────────────────────────

const BUILTIN_AGENTS: { kind: AgentKind; labelKey: string }[] = [
  { kind: 'daily_review',       labelKey: 'agent.dailyReview' },
  { kind: 'outline_extractor',  labelKey: 'agent.outlineExtractor' },
  { kind: 'duplicate_detector', labelKey: 'agent.duplicateDetector' },
  { kind: 'index_generator',    labelKey: 'agent.indexGenerator' },
  { kind: 'graph_maintainer',   labelKey: 'agent.graphMaintainer' },
  { kind: 'typst_reviewer',     labelKey: 'agent.typstReviewer' },
];

// ── Scope options ───────────────────────────────────────────

type ScopeOption = 'current_note' | 'current_folder' | 'vault';

const SCOPE_OPTIONS: { value: ScopeOption; labelKey: string; icon: React.ReactNode }[] = [
  { value: 'current_note',   labelKey: 'agent.scope.currentNote',   icon: <FileText size={14} /> },
  { value: 'current_folder', labelKey: 'agent.scope.currentFolder', icon: <FolderOpen size={14} /> },
  { value: 'vault',          labelKey: 'agent.scope.entireVault',   icon: <Globe size={14} /> },
];

// ── Main panel component ────────────────────────────────────

export function AgentPanel() {
  const { t } = useTranslation();

  // Agent store state
  const isRunning = useAgentStore((s) => s.isRunning);
  const pauseRequested = useAgentStore((s) => s.pauseRequested);
  const status = useAgentStore((s) => s.status);
  const planSteps = useAgentStore((s) => s.planSteps);
  const progress = useAgentStore((s) => s.progress);
  const proposedChanges = useAgentStore((s) => s.proposedChanges);
  const summary = useAgentStore((s) => s.summary);
  const history = useAgentStore((s) => s.history);
  const queueCount = useAgentStore((s) => s.queueCount);
  const customAgents = useAgentStore((s) => s.customAgents);
  const runAgent = useAgentStore((s) => s.runAgent);
  const abortAgent = useAgentStore((s) => s.abortAgent);
  const pauseAgent = useAgentStore((s) => s.pauseAgent);
  const resumeAgent = useAgentStore((s) => s.resumeAgent);
  const applyChanges = useAgentStore((s) => s.applyChanges);
  const dismissChanges = useAgentStore((s) => s.dismissChanges);
  const initListeners = useAgentStore((s) => s.initListeners);

  // External state
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);
  const apiKey = useChatStore((s) => s.config.api_key);
  const provider = useChatStore((s) => s.config.provider);

  // Local UI state
  const [selectedAgent, setSelectedAgent] = useState<string>('daily_review');
  const [scope, setScope] = useState<ScopeOption>('current_note');

  // Initialize event listeners + load custom agents on mount
  useEffect(() => {
    initListeners();
    useAgentStore.getState().loadHistory();
    useAgentStore.getState().loadCustomAgents();
    useAgentStore.getState().fetchStatus();
  }, [initListeners]);

  // Resolve AgentKind from selected string
  const resolveKind = useCallback((): AgentKind => {
    const builtin = BUILTIN_AGENTS.find((a) => a.kind === selectedAgent);
    if (builtin) return builtin.kind;
    return { custom: selectedAgent };
  }, [selectedAgent]);

  // Resolve scope path from the scope option
  const resolveScope = useCallback((): string | undefined => {
    if (scope === 'current_note' && activeTabPath) return activeTabPath;
    if (scope === 'current_folder' && activeTabPath) {
      const lastSlash = activeTabPath.lastIndexOf('/');
      return lastSlash > 0 ? activeTabPath.substring(0, lastSlash) : '';
    }
    return undefined; // vault-wide
  }, [scope, activeTabPath]);

  // Start agent run
  const handleRun = useCallback(() => {
    const config = useChatStore.getState().config;
    const task: AgentTask = {
      kind: resolveKind(),
      scope: resolveScope(),
    };
    runAgent(task, config);
  }, [resolveKind, resolveScope, runAgent]);

  // No vault opened
  if (!vaultPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('agent.noVault')}
      </div>
    );
  }

  // API key required check (Ollama doesn't need it)
  const needsApiKey = !apiKey && provider !== 'ollama';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Bot size={14} className="text-theme-accent" />
          <span className="text-sm font-medium">{t('agent.title')}</span>
        </div>
        {isRunning && status && (
          <span className="text-xs text-muted-foreground animate-pulse">
            {t(STATUS_I18N[status])}
          </span>
        )}
        {queueCount > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-theme-accent/15 text-theme-accent">
            {t('agent.queueCount', { count: queueCount })}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Setup guard */}
        {needsApiKey ? (
          <SetupGuide />
        ) : (
          <div className="p-3 space-y-4">
            {/* Agent selector */}
            <AgentSelector
              selectedAgent={selectedAgent}
              setSelectedAgent={setSelectedAgent}
              customAgents={customAgents}
              disabled={isRunning}
            />

            {/* Scope selector */}
            <ScopeSelector
              scope={scope}
              setScope={setScope}
              activeTabPath={activeTabPath}
              disabled={isRunning}
            />

            {/* Run / Pause / Resume / Abort buttons */}
            <div className="flex gap-2">
              {isRunning ? (
                <>
                  {status === 'paused' ? (
                    <button
                      onClick={resumeAgent}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm
                        bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors"
                    >
                      <Play size={14} />
                      {t('agent.resume')}
                    </button>
                  ) : (
                    <button
                      onClick={pauseAgent}
                      disabled={status === 'planning' || pauseRequested}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm
                        bg-yellow-500/15 text-yellow-500 hover:bg-yellow-500/25
                        disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Pause size={14} />
                      {pauseRequested ? t('agent.pausing') : t('agent.pause')}
                    </button>
                  )}
                  <button
                    onClick={abortAgent}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm
                      bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors"
                  >
                    <Square size={14} />
                    {t('agent.abort')}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleRun}
                  disabled={scope === 'current_note' && !activeTabPath}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm
                    bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25
                    disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Play size={14} />
                  {t('agent.run')}
                </button>
              )}
            </div>

            {/* Progress section */}
            {(isRunning || status) && (
              <ProgressSection
                isRunning={isRunning}
                progress={progress}
                planSteps={planSteps}
                status={status}
              />
            )}

            {/* Proposed changes */}
            {proposedChanges.length > 0 && status === 'waiting_approval' && (
              <ChangesSection
                changes={proposedChanges}
                summary={summary}
                onApplyAll={() => applyChanges(proposedChanges.map((_, i) => i))}
                onApply={(i) => applyChanges([i])}
                onDismiss={dismissChanges}
              />
            )}

            {/* Summary (after completion, no changes) */}
            {summary && status === 'completed' && proposedChanges.length === 0 && (
              <div className="rounded-md bg-theme-bg-panel border border-theme-border p-3">
                <p className="text-xs text-foreground">{summary}</p>
              </div>
            )}

            {/* History section */}
            {!isRunning && history.length > 0 && (
              <HistorySection history={history} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────

/** Setup guide when no API key is configured */
function SetupGuide() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-8">
      <div className="text-center space-y-4 max-w-xs">
        <Bot className="w-10 h-10 text-theme-accent mx-auto opacity-60" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('agent.setupRequired')}</p>
          <p className="text-xs text-muted-foreground">{t('agent.setupDescription')}</p>
        </div>
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs
            bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors"
          onClick={() => useUIStore.getState().setSettingsOpen(true)}
        >
          <Settings className="w-3.5 h-3.5" />
          {t('agent.setupButton')}
        </button>
      </div>
    </div>
  );
}

/** Agent type selector with built-in + custom agents */
function AgentSelector({
  selectedAgent, setSelectedAgent, customAgents, disabled,
}: {
  selectedAgent: string;
  setSelectedAgent: (v: string) => void;
  customAgents: { name: string; title: string }[];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{t('agent.selectAgent')}</label>
      <Select value={selectedAgent} onValueChange={setSelectedAgent} disabled={disabled}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BUILTIN_AGENTS.map(({ kind, labelKey }) => (
            <SelectItem key={kind as string} value={kind as string}>
              {t(labelKey)}
            </SelectItem>
          ))}
          {customAgents.length > 0 && (
            <>
              <div className="px-2 py-1 text-xs text-muted-foreground border-t border-theme-border mt-1 pt-1">
                {t('agent.custom')}
              </div>
              {customAgents.map((a) => (
                <SelectItem key={a.name} value={a.name}>{a.title}</SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Scope selector (current note / folder / vault) */
function ScopeSelector({
  scope, setScope, activeTabPath, disabled,
}: {
  scope: ScopeOption;
  setScope: (v: ScopeOption) => void;
  activeTabPath: string | null;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{t('agent.scopeLabel')}</label>
      <div className="flex gap-1">
        {SCOPE_OPTIONS.map(({ value, labelKey, icon }) => {
          const isDisabled = disabled || (value === 'current_note' && !activeTabPath) ||
            (value === 'current_folder' && !activeTabPath);
          return (
            <button
              key={value}
              onClick={() => setScope(value)}
              disabled={isDisabled}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs
                transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                ${scope === value
                  ? 'bg-theme-accent/15 text-theme-accent border border-theme-accent/30'
                  : 'bg-theme-bg-panel text-muted-foreground border border-theme-border hover:text-foreground hover:bg-theme-hover'
                }`}
            >
              {icon}
              <span className="hidden xl:inline">{t(labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Progress display with plan steps */
function ProgressSection({
  isRunning, progress, planSteps, status,
}: {
  isRunning: boolean;
  progress: string;
  planSteps: PlanStep[];
  status: string | null;
}) {
  const { t } = useTranslation();
  const completedCount = planSteps.filter((s) => s.status === 'completed').length;
  const progressPct = planSteps.length > 0 ? (completedCount / planSteps.length) * 100 : 0;

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      {planSteps.length > 0 && (
        <Progress value={progressPct} className="h-1.5" />
      )}

      {/* Status message */}
      <p className={`text-xs ${isRunning ? 'text-theme-accent' : 'text-muted-foreground'}`}>
        {progress}
      </p>

      {/* Plan steps list */}
      {planSteps.length > 0 && (
        <div className="space-y-1">
          {planSteps.map((step) => (
            <StepItem key={step.index} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Individual plan step display */
function StepItem({ step }: { step: PlanStep }) {
  return (
    <div className="flex items-start gap-1.5 text-xs">
      <StepStatusIcon status={step.status} />
      <span className={step.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'}>
        {step.description}
      </span>
    </div>
  );
}

/** Status icon for a plan step */
function StepStatusIcon({ status }: { status: PlanStep['status'] }) {
  switch (status) {
    case 'completed':
      return <Check size={12} className="text-green-500 mt-0.5 shrink-0" />;
    case 'in_progress':
      return <div className="w-3 h-3 mt-0.5 shrink-0 rounded-full border-2 border-theme-accent border-t-transparent animate-spin" />;
    case 'failed':
      return <X size={12} className="text-red-500 mt-0.5 shrink-0" />;
    default:
      return <div className="w-3 h-3 mt-0.5 shrink-0 rounded-full border border-theme-border" />;
  }
}

/** Proposed changes section with accept/reject controls */
function ChangesSection({
  changes, summary, onApplyAll, onApply, onDismiss,
}: {
  changes: ProposedChange[];
  summary: string | null;
  onApplyAll: () => void;
  onApply: (index: number) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      {/* Summary */}
      {summary && (
        <p className="text-xs text-foreground">{summary}</p>
      )}

      {/* Changes header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">
          {t('agent.changes.title')} ({changes.length})
        </span>
        <div className="flex gap-1">
          <button
            onClick={onApplyAll}
            className="px-2 py-1 rounded text-xs bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors"
          >
            {t('agent.changes.acceptAll')}
          </button>
          <button
            onClick={onDismiss}
            className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-theme-hover transition-colors"
          >
            {t('agent.changes.dismiss')}
          </button>
        </div>
      </div>

      {/* Change items */}
      <div className="space-y-1">
        {changes.map((change, idx) => (
          <ChangeItem
            key={idx}
            change={change}
            isExpanded={expanded === idx}
            onToggle={() => setExpanded(expanded === idx ? null : idx)}
            onApply={() => onApply(idx)}
          />
        ))}
      </div>
    </div>
  );
}

/** Individual proposed change item */
function ChangeItem({
  change, isExpanded, onToggle, onApply,
}: {
  change: ProposedChange;
  isExpanded: boolean;
  onToggle: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const actionColors: Record<string, string> = {
    create: 'text-green-500',
    modify: 'text-yellow-500',
    merge: 'text-blue-500',
    add_link: 'text-purple-500',
  };

  return (
    <div className="rounded-md border border-theme-border bg-theme-bg-panel">
      {/* Change header — div with role=button to avoid nesting <button> inside <button> */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left hover:bg-theme-hover transition-colors cursor-pointer"
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={actionColors[change.action] ?? 'text-foreground'}>
          {t(`agent.action.${change.action}`)}
        </span>
        <span className="text-foreground truncate flex-1">{change.path}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onApply(); }}
          className="px-1.5 py-0.5 rounded text-[10px] bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors shrink-0"
        >
          {t('agent.changes.accept')}
        </button>
      </div>

      {/* Expanded diff/content */}
      {isExpanded && (
        <div className="px-2 pb-2 border-t border-theme-border">
          <p className="text-xs text-muted-foreground mt-1.5 mb-1">{change.description}</p>
          {change.diff && (
            <pre className="text-[10px] leading-tight font-mono overflow-x-auto bg-background rounded p-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
              {change.diff}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Map backend kind strings to i18n keys */
const KIND_I18N: Record<string, string> = {
  daily_review: 'agent.dailyReview',
  outline_extractor: 'agent.outlineExtractor',
  duplicate_detector: 'agent.duplicateDetector',
  index_generator: 'agent.indexGenerator',
  graph_maintainer: 'agent.graphMaintainer',
};

/** Map backend status strings to i18n keys */
const HISTORY_STATUS_I18N: Record<string, string> = {
  planning: 'agent.progress.planning',
  executing: 'agent.progress.executing',
  completed: 'agent.progress.complete',
  waiting_approval: 'agent.progress.complete',
  failed: 'agent.progress.error',
  aborted: 'agent.progress.aborted',
};

/** Agent run history section */
function HistorySection({ history }: { history: { id: string; kind: string; summary: string; started_at: string; status: string }[] }) {
  const { t } = useTranslation();
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div>
      <button
        onClick={() => setShowHistory(!showHistory)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Clock size={12} />
        {t('agent.history.title')} ({history.length})
      </button>

      {showHistory && (
        <div className="mt-1.5 space-y-1">
          {history.map((run) => (
            <div
              key={run.id}
              className="rounded-md border border-theme-border bg-theme-bg-panel px-2 py-1.5 text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground">
                  {t(KIND_I18N[run.kind] ?? 'agent.custom')}
                </span>
                <span className={`text-[10px] ${run.status === 'completed' ? 'text-green-500' : 'text-muted-foreground'}`}>
                  {t(HISTORY_STATUS_I18N[run.status] ?? 'agent.status')}
                </span>
              </div>
              {run.summary && (
                <p className="text-muted-foreground mt-0.5 line-clamp-2">{run.summary}</p>
              )}
              <p className="text-muted-foreground/60 mt-0.5">{new Date(run.started_at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
