import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ChevronDown, Trash2, Pencil, Search } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';
import { updateChatSessionTitle, searchChatMessages, type ChatSearchResult } from '@/lib/api';

/** Chat panel header with session management */
export function ChatHeader() {
  const { t } = useTranslation();
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const createSession = useChatStore((s) => s.createSession);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const [showDropdown, setShowDropdown] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChatSearchResult[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Clear pending search timer on unmount
  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const title = currentSession?.title || t('chat.sessionDefault');

  // ── Inline rename handlers ────────────────────────────────

  const startRenaming = useCallback((sessionId: string, currentTitle: string) => {
    setEditingId(sessionId);
    setEditingTitle(currentTitle || '');
    // Focus input after React re-render
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, []);

  const commitRename = useCallback(() => {
    if (!editingId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      // Update the store optimistically
      useChatStore.setState((s) => ({
        sessions: s.sessions.map((ss) =>
          ss.id === editingId ? { ...ss, title: trimmed } : ss,
        ),
      }));
      // Persist to DB
      updateChatSessionTitle(editingId, trimmed).catch((err) =>
        console.warn('Failed to rename session:', err),
      );
    }
    setEditingId(null);
  }, [editingId, editingTitle]);

  const handleRenameKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  }, [commitRename]);

  // ── Search handlers ───────────────────────────────────────

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!value.trim()) {
      setSearchResults([]);
      return;
    }

    // Debounce search by 300ms
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchChatMessages(value.trim(), 20);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
    }, 300);
  }, []);

  const toggleSearch = useCallback(() => {
    setShowSearch((v) => {
      if (!v) {
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else {
        setSearchQuery('');
        setSearchResults([]);
      }
      return !v;
    });
  }, []);

  return (
    <div className="relative flex items-center gap-1 px-3 py-2 border-b border-theme-border shrink-0">
      <h3
        className="text-sm font-medium text-foreground truncate flex-1 cursor-default"
        title={title}
        onDoubleClick={() => currentSessionId && startRenaming(currentSessionId, currentSession?.title ?? '')}
      >
        {editingId === currentSessionId ? (
          <input
            ref={renameInputRef}
            className="w-full bg-transparent border-b border-theme-accent outline-none text-sm"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleRenameKeyDown}
          />
        ) : (
          title
        )}
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
                  {editingId === session.id ? (
                    <input
                      ref={renameInputRef}
                      className="flex-1 bg-transparent border-b border-theme-accent outline-none text-sm min-w-0"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="truncate flex-1"
                      onClick={() => {
                        switchSession(session.id);
                        setShowDropdown(false);
                      }}
                    >
                      {session.title || t('chat.sessionDefault')}
                    </span>
                  )}
                  <button
                    className="p-0.5 rounded hover:bg-theme-accent/20 text-muted-foreground hover:text-theme-accent shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRenaming(session.id, session.title);
                    }}
                    title={t('chat.renameSession')}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
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

      {/* Search button */}
      <button
        className={`p-1 rounded-md transition-colors ${
          showSearch
            ? 'bg-theme-accent/15 text-theme-accent'
            : 'hover:bg-theme-hover text-muted-foreground hover:text-foreground'
        }`}
        onClick={toggleSearch}
        title={t('chat.searchMessages')}
      >
        <Search className="w-4 h-4" />
      </button>

      {/* New session button */}
      <button
        className="p-1 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => createSession()}
        title={t('chat.newSession')}
      >
        <Plus className="w-4 h-4" />
      </button>

      {/* Search panel — collapsible inline search below header */}
      {showSearch && (
        <div className="absolute left-0 right-0 top-full z-30 bg-surface border-b border-theme-border shadow-sm">
          <div className="px-3 py-2">
            <input
              ref={searchInputRef}
              className="w-full px-2 py-1 text-sm bg-background border border-theme-border rounded-md
                text-foreground placeholder:text-muted-foreground outline-none focus:border-theme-accent"
              placeholder={t('chat.searchMessages')}
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') toggleSearch(); }}
            />
          </div>
          {searchResults.length > 0 && (
            <div className="max-h-48 overflow-y-auto border-t border-theme-border">
              {searchResults.map((result) => (
                <button
                  key={result.message_id}
                  className="w-full text-left px-3 py-2 hover:bg-theme-hover text-sm border-b border-theme-border/30 last:border-0"
                  onClick={() => {
                    switchSession(result.session_id);
                    setShowSearch(false);
                    setSearchQuery('');
                    setSearchResults([]);
                  }}
                >
                  <div className="text-xs text-muted-foreground mb-0.5">{result.session_title}</div>
                  <SearchSnippet text={result.content_snippet} />
                </button>
              ))}
            </div>
          )}
          {searchQuery.trim() && searchResults.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t border-theme-border">
              {t('chat.noSearchResults')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Search snippet with highlight ───────────────────────────

/** Render FTS5 snippet with **bold** markers as highlighted spans */
function SearchSnippet({ text }: { text: string }) {
  // Split on **..** markers (FTS5 uses ** as highlight delimiters)
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return (
    <div className="text-foreground truncate text-xs">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="text-theme-accent font-medium">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
}
