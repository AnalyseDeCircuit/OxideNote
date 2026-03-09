import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ChevronDown, Trash2 } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';

/** Chat panel header with session management */
export function ChatHeader() {
  const { t } = useTranslation();
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const createSession = useChatStore((s) => s.createSession);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const title = currentSession?.title || t('chat.sessionDefault');

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-theme-border shrink-0">
      <h3 className="text-sm font-medium text-foreground truncate flex-1" title={title}>
        {title}
      </h3>

      {/* Session list dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          className="p-1 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowDropdown(!showDropdown)}
          title={t('chat.newSession')}
        >
          <ChevronDown className="w-4 h-4" />
        </button>

        {showDropdown && (
          <>
            {/* Backdrop to close dropdown */}
            <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
            <div className="absolute right-0 top-full mt-1 w-56 bg-surface border border-theme-border rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-theme-hover ${
                    session.id === currentSessionId ? 'text-theme-accent' : 'text-foreground'
                  }`}
                >
                  <span
                    className="truncate flex-1"
                    onClick={() => {
                      switchSession(session.id);
                      setShowDropdown(false);
                    }}
                  >
                    {session.title || t('chat.sessionDefault')}
                  </span>
                  <button
                    className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSession(session.id);
                    }}
                    title={t('chat.deleteSession')}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {sessions.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">{t('chat.noMessages')}</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* New session button */}
      <button
        className="p-1 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => createSession()}
        title={t('chat.newSession')}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
