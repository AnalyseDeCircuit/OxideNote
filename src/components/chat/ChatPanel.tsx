import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Sparkles, PenLine, FileText, Lightbulb, Wand2 } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';
import { useUIStore } from '@/store/uiStore';
import { useNoteStore } from '@/store/noteStore';
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
          <ChatWelcome />
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

// ── Quick action card definitions ───────────────────────────

interface QuickAction {
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    icon: <Wand2 className="w-5 h-5" />,
    titleKey: 'chat.quickAction.polish',
    descKey: 'chat.quickAction.polishDesc',
  },
  {
    icon: <FileText className="w-5 h-5" />,
    titleKey: 'chat.quickAction.summarize',
    descKey: 'chat.quickAction.summarizeDesc',
  },
  {
    icon: <PenLine className="w-5 h-5" />,
    titleKey: 'chat.quickAction.expand',
    descKey: 'chat.quickAction.expandDesc',
  },
  {
    icon: <Lightbulb className="w-5 h-5" />,
    titleKey: 'chat.quickAction.qa',
    descKey: 'chat.quickAction.qaDesc',
  },
];

// ── Welcome screen for empty chat ───────────────────────────

function ChatWelcome() {
  const { t } = useTranslation();
  const sendMessage = useChatStore((s) => s.sendMessage);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const activeContent = useNoteStore((s) => s.activeContent);

  const handleAction = (index: number) => {
    const noteContext = activeTabPath && activeContent
      ? `\n\n[${t('chat.quickAction.currentNote')}: ${activeTabPath}]\n${activeContent.slice(0, 2000)}`
      : '';

    switch (index) {
      case 0: // Polish
        sendMessage(t('chat.quickAction.polishPrompt') + noteContext, activeTabPath || undefined);
        break;
      case 1: // Summarize
        sendMessage(t('chat.quickAction.summarizePrompt') + noteContext, activeTabPath || undefined);
        break;
      case 2: // Expand ideas — brainstorm based on current note
        sendMessage(t('chat.quickAction.expandPrompt') + noteContext, activeTabPath || undefined);
        break;
      case 3: // Q&A — ask questions about current note
        sendMessage(t('chat.quickAction.qaPrompt') + noteContext, activeTabPath || undefined);
        break;
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 gap-6 overflow-y-auto">
      {/* Greeting */}
      <div className="text-center space-y-2">
        <Sparkles className="w-8 h-8 text-theme-accent mx-auto opacity-70" />
        <h2 className="text-base font-semibold text-foreground">
          {t('chat.welcome.title')}
        </h2>
        <p className="text-xs text-muted-foreground max-w-[220px]">
          {t('chat.welcome.description')}
        </p>
      </div>

      {/* Quick action cards */}
      <div className="w-full max-w-[280px] grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map((action, idx) => (
          <button
            key={idx}
            type="button"
            className="flex flex-col items-start gap-1.5 p-3 rounded-lg border border-theme-border
              hover:border-theme-accent/40 hover:bg-theme-accent/5 transition-all text-left group"
            onClick={() => handleAction(idx)}
          >
            <span className="text-theme-accent/70 group-hover:text-theme-accent transition-colors">
              {action.icon}
            </span>
            <span className="text-xs font-medium text-foreground">
              {t(action.titleKey)}
            </span>
            <span className="text-[10px] text-muted-foreground leading-tight">
              {t(action.descKey)}
            </span>
          </button>
        ))}
      </div>

      {/* Hint */}
      <p className="text-[10px] text-muted-foreground/60">
        {t('chat.welcome.hint')}
      </p>
    </div>
  );
}
