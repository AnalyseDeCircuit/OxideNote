import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';

/** Compact token usage bar displayed above chat input */
export function TokenCounter() {
  const { t } = useTranslation();
  const lastUsage = useChatStore((s) => s.lastUsage);
  const tokenStats = useChatStore((s) => s.tokenStats);

  // Only show when there's usage data
  if (!lastUsage && tokenStats.sessionPrompt === 0) return null;

  const handleReset = () => {
    useChatStore.getState().resetLifetimeTokens();
  };

  return (
    <div className="group relative px-3 py-1 text-[11px] text-muted-foreground border-t border-theme-border/50 flex items-center gap-3">
      {/* Last request */}
      {lastUsage && (
        <span className="flex items-center gap-1.5">
          <ArrowUp className="w-3 h-3" />
          <span>{formatTokens(lastUsage.prompt_tokens)}</span>
          <ArrowDown className="w-3 h-3" />
          <span>{formatTokens(lastUsage.completion_tokens)}</span>
        </span>
      )}

      {/* Session total */}
      {tokenStats.sessionPrompt > 0 && (
        <span className="text-muted-foreground/70">
          {t('chat.tokenSession')}: {formatTokens(tokenStats.sessionPrompt + tokenStats.sessionCompletion)}
        </span>
      )}

      {/* Tooltip on hover */}
      <div className="invisible group-hover:visible absolute bottom-full left-0 mb-1 w-56
        bg-background border border-theme-border rounded-lg shadow-lg p-2.5 z-50 text-xs">
        {lastUsage && (
          <>
            <div className="font-medium text-foreground mb-1">{t('chat.tokenPrompt')}</div>
            <div className="flex justify-between">
              <span>Prompt:</span>
              <span>{lastUsage.prompt_tokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span>Completion:</span>
              <span>{lastUsage.completion_tokens.toLocaleString()}</span>
            </div>
            <div className="border-t border-theme-border my-1.5" />
          </>
        )}

        <div className="font-medium text-foreground mb-1">{t('chat.tokenSession')}</div>
        <div className="flex justify-between">
          <span>Total:</span>
          <span>{(tokenStats.sessionPrompt + tokenStats.sessionCompletion).toLocaleString()}</span>
        </div>
        <div className="border-t border-theme-border my-1.5" />

        <div className="font-medium text-foreground mb-1">{t('chat.tokenLifetime')}</div>
        <div className="flex justify-between">
          <span>Total:</span>
          <span>{(tokenStats.lifetimePrompt + tokenStats.lifetimeCompletion).toLocaleString()}</span>
        </div>

        <button
          className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1 rounded
            text-xs bg-surface hover:bg-theme-hover transition-colors text-muted-foreground"
          onClick={handleReset}
        >
          <RotateCcw className="w-3 h-3" />
          {t('chat.tokenReset')}
        </button>
      </div>
    </div>
  );
}

/** Format token count for compact display (1.2K, 128K, etc.) */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}K`;
  return `${Math.round(count / 1000)}K`;
}
