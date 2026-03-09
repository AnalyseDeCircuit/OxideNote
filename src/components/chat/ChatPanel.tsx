import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chatStore';
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

  // Initialize event listener on mount
  useEffect(() => {
    init();
    return () => cleanup();
  }, [init, cleanup]);

  return (
    <div className="h-full flex flex-col">
      <ChatHeader />

      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {t('chat.noMessages')}
        </div>
      ) : (
        <MessageList />
      )}

      {contextInfo && <ContextBudgetBar />}
      <TokenCounter />
      <ChatInput />
    </div>
  );
}
