import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Sparkles } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';
import { useUIStore } from '@/store/uiStore';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput } from '@/components/chat/ChatInput';
import { TokenCounter } from '@/components/chat/TokenCounter';
import { ContextBudgetBar } from '@/components/chat/ContextBudgetBar';

/** Main chat panel — fits inside the SidePanel tab area */
export function ChatPanel() {
  const { t } = useTranslation();
  const init = useChatStore((s) => s.init);
  const cleanup = useChatStore((s) => s.cleanup);
  const messages = useChatStore((s) => s.messages);
  const contextInfo = useChatStore((s) => s.contextInfo);
  const apiKey = useChatStore((s) => s.config.api_key);
  const provider = useChatStore((s) => s.config.provider);

  // Initialize event listener on mount
  useEffect(() => {
    init();
    return () => cleanup();
  }, [init, cleanup]);

  // Ollama does not need an API key
  const needsApiKey = !apiKey && provider !== 'ollama';

  return (
    <div className="h-full flex flex-col">
      <ChatHeader />

      {messages.length === 0 ? (
        needsApiKey ? (
          <SetupGuide />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            {t('chat.noMessages')}
          </div>
        )
      ) : (
        <MessageList />
      )}

      {contextInfo && <ContextBudgetBar />}
      <TokenCounter />
      <ChatInput />
    </div>
  );
}

// ── Setup guide for unconfigured API key ────────────────────

function SetupGuide() {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="text-center space-y-4 max-w-xs">
        <Sparkles className="w-10 h-10 text-theme-accent mx-auto opacity-60" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('chat.setupRequired')}</p>
          <p className="text-xs text-muted-foreground">{t('chat.setupDescription')}</p>
        </div>
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs
            bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors"
          onClick={() => useUIStore.getState().setSettingsOpen(true)}
        >
          <Settings className="w-3.5 h-3.5" />
          {t('chat.setupButton')}
        </button>
      </div>
    </div>
  );
}
