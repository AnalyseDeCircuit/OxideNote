import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chatStore';

/** Visual bar showing how the context budget is distributed across sources */
export function ContextBudgetBar() {
  const { t } = useTranslation();
  const contextInfo = useChatStore((s) => s.contextInfo);

  if (!contextInfo) return null;

  const { contextWindow, ragBudget, isCompact } = contextInfo;

  // Calculate percentage of context used by RAG
  const ragPercent = contextWindow > 0 ? Math.min((ragBudget / contextWindow) * 100, 100) : 0;
  const freePercent = 100 - ragPercent;

  return (
    <div className="px-3 py-1.5 border-t border-theme-border/50">
      {/* Segmented bar */}
      <div className="h-1.5 rounded-full overflow-hidden bg-background flex">
        {ragPercent > 0 && (
          <div
            className="h-full bg-theme-accent/60 transition-all duration-300"
            style={{ width: `${ragPercent}%` }}
          />
        )}
        <div
          className="h-full bg-theme-border/30 transition-all duration-300"
          style={{ width: `${freePercent}%` }}
        />
      </div>

      {/* Label */}
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
        <span>ctx {formatSize(contextWindow)}</span>
        <span>·</span>
        <span>RAG {formatSize(ragBudget)}</span>
        {isCompact && (
          <>
            <span>·</span>
            <span className="text-yellow-500">{t('chat.contextCompact')}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Format token count as human-readable size (8K, 128K, 1M) */
function formatSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
