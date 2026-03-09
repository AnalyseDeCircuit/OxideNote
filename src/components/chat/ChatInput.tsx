import { useState, useRef, useCallback, type KeyboardEvent, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, Wand2, RefreshCw, FileText, Paperclip, X } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';
import { useAgentStore } from '@/store/agentStore';
import { useNoteStore } from '@/store/noteStore';
import { searchNotes } from '@/lib/api';
import { getEditorView } from '@/lib/editorViewRef';
import { toast } from '@/hooks/useToast';
import type { ImageAttachment, SearchResult } from '@/lib/api';

// Available built-in agent kinds for @agent autocomplete
const AGENT_KINDS = [
  'duplicate_detector',
  'outline_extractor',
  'index_generator',
  'daily_review',
  'graph_maintainer',
] as const;

/** Chat input area with @mention, quick actions, and image attachment */
export function ChatInput() {
  const { t } = useTranslation();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const addReferencedFile = useChatStore((s) => s.addReferencedFile);

  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<SearchResult[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  // @agent autocomplete state
  const [agentSuggestions, setAgentSuggestions] = useState<string[]>([]);
  const [agentSugIndex, setAgentSugIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Image handling ────────────────────────────────────────

  const addImage = useCallback((file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: t('chat.imageLimit'), variant: 'warning' });
      return;
    }
    if (images.length >= 4) {
      toast({ title: t('chat.imageTooMany'), variant: 'warning' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      if (base64) {
        setImages((prev) => [...prev, { data: base64, mediaType: file.type }]);
      }
    };
    reader.readAsDataURL(file);
  }, [images.length, t]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImage(file);
        return;
      }
    }
  }, [addImage]);

  const handleFileSelect = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => {
      if (input.files) {
        Array.from(input.files).forEach(addImage);
      }
    };
    input.click();
  }, [addImage]);

  // ── @mention system ───────────────────────────────────────

  const handleTextChange = useCallback(async (value: string) => {
    setText(value);

    // Detect @agent autocomplete — triggers when text starts with "@agent "
    const agentPrefixMatch = value.match(/^@agent\s+(\S*)$/);
    if (agentPrefixMatch) {
      const partial = agentPrefixMatch[1].toLowerCase();
      // Also include custom agents from store
      const customAgents = useAgentStore.getState().customAgents.map(a => a.name);
      const allKinds = [...AGENT_KINDS, ...customAgents];
      const filtered = partial
        ? allKinds.filter(k => k.toLowerCase().includes(partial))
        : allKinds;
      setAgentSuggestions(filtered);
      setAgentSugIndex(0);
      // Clear note mention state
      setMentionQuery(null);
      setMentionResults([]);
      return;
    }
    setAgentSuggestions([]);

    // Detect @mention for note references
    const cursorPos = textareaRef.current?.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf('@');

    if (atIndex >= 0 && (atIndex === 0 || beforeCursor[atIndex - 1] === ' ' || beforeCursor[atIndex - 1] === '\n')) {
      const query = beforeCursor.slice(atIndex + 1);
      if (query.length > 0 && !query.includes(' ')) {
        setMentionQuery(query);
        setMentionIndex(0);
        try {
          const results = await searchNotes(query);
          setMentionResults(results.slice(0, 8));
        } catch {
          setMentionResults([]);
        }
        return;
      }
    }
    setMentionQuery(null);
    setMentionResults([]);
  }, []);

  const selectMention = useCallback((result: SearchResult) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex < 0) return;

    const afterCursor = text.slice(cursorPos);
    const newText = beforeCursor.slice(0, atIndex) + `@[[${result.path}]]` + afterCursor;
    setText(newText);
    setMentionQuery(null);
    setMentionResults([]);

    addReferencedFile(result.path, result.title);
  }, [text, addReferencedFile]);

  // Select an agent kind from @agent autocomplete
  const selectAgentKind = useCallback((kind: string) => {
    setText(`@agent ${kind} `);
    setAgentSuggestions([]);
    // Focus back on textarea and move cursor to end
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    }, 0);
  }, []);

  // ── Send / keyboard handling ──────────────────────────────

  const handleSend = useCallback(() => {
    if (!text.trim() && images.length === 0) return;
    if (isStreaming) return;

    const notePath = useNoteStore.getState().activeTabPath;
    sendMessage(text.trim(), notePath ?? undefined, images.length > 0 ? images : undefined);
    setText('');
    setImages([]);
  }, [text, images, isStreaming, sendMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // @agent suggestion navigation
    if (agentSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAgentSugIndex((i) => Math.min(i + 1, agentSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAgentSugIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectAgentKind(agentSuggestions[agentSugIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setAgentSuggestions([]);
        return;
      }
    }

    // @mention navigation
    if (mentionQuery !== null && mentionResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mentionResults[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        setMentionResults([]);
        return;
      }
    }

    // Send on Enter (Shift+Enter for newline)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [agentSuggestions, agentSugIndex, selectAgentKind, mentionQuery, mentionResults, mentionIndex, selectMention, handleSend]);

  // ── Quick actions ─────────────────────────────────────────

  const handleContinue = useCallback(() => {
    const view = getEditorView();
    if (!view) return;
    const cursor = view.state.selection.main.head;
    const line = view.state.doc.lineAt(cursor);
    const lineNum = line.number;
    const doc = view.state.doc.toString();
    const lines = doc.split('\n');
    const start = Math.max(0, lineNum - 11);
    const end = Math.min(lines.length, lineNum + 10);
    const surrounding = lines.slice(start, end).join('\n');

    setText(t('chat.continuePrompt', {
      lineNum,
      surrounding,
    }));
  }, [t]);

  const handleRewrite = useCallback(() => {
    const view = getEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const selection = view.state.sliceDoc(from, to);
    setText(t('chat.rewritePrompt', { selection }));
  }, []);

  const handleSummarize = useCallback(() => {
    const view = getEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const content = from === to
      ? view.state.doc.toString()
      : view.state.sliceDoc(from, to);
    setText(t('chat.summarizePrompt', { content }));
  }, []);

  return (
    <div className="border-t border-theme-border shrink-0">
      {/* Image preview strip */}
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-2">
          {images.map((img, i) => (
            <div key={i} className="relative w-12 h-12 rounded-md overflow-hidden border border-theme-border">
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt=""
                className="w-full h-full object-cover"
              />
              <button
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* @mention dropdown */}
      {mentionQuery !== null && mentionResults.length > 0 && (
        <div className="mx-3 mt-1 bg-surface border border-theme-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {mentionResults.map((result, i) => (
            <button
              key={result.path}
              className={`w-full text-left px-3 py-1.5 text-sm truncate ${
                i === mentionIndex ? 'bg-theme-hover text-theme-accent' : 'text-foreground hover:bg-theme-hover'
              }`}
              onClick={() => selectMention(result)}
            >
              {result.title || result.path}
            </button>
          ))}
        </div>
      )}

      {/* @agent kind suggestions */}
      {agentSuggestions.length > 0 && (
        <div className="mx-3 mt-1 bg-surface border border-theme-accent/30 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          <div className="px-3 py-1 text-xs text-muted-foreground border-b border-theme-border">
            {t('chat.agentKindHint')}
          </div>
          {agentSuggestions.map((kind, i) => (
            <button
              key={kind}
              className={`w-full text-left px-3 py-1.5 text-sm ${
                i === agentSugIndex ? 'bg-theme-hover text-theme-accent' : 'text-foreground hover:bg-theme-hover'
              }`}
              onClick={() => selectAgentKind(kind)}
            >
              {kind}
            </button>
          ))}
        </div>
      )}

      {/* Quick action buttons */}
      <div className="flex items-center gap-1 px-3 pt-2">
        <button
          className="p-1.5 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
          onClick={handleContinue}
          title={t('chat.continue')}
        >
          <Wand2 className="w-3.5 h-3.5" />
        </button>
        <button
          className="p-1.5 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
          onClick={handleRewrite}
          title={t('chat.rewrite')}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          className="p-1.5 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
          onClick={handleSummarize}
          title={t('chat.summarize')}
        >
          <FileText className="w-3.5 h-3.5" />
        </button>
        <button
          className="p-1.5 rounded-md hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
          onClick={handleFileSelect}
          title={t('chat.attachImage')}
        >
          <Paperclip className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Input area */}
      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-h-[36px] max-h-[120px] py-2 px-3 rounded-lg border border-theme-border focus:border-theme-accent transition-colors"
          placeholder={t('chat.placeholder')}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          // Auto-resize textarea
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 120) + 'px';
          }}
        />
        <button
          className={`p-2 rounded-lg transition-colors shrink-0 ${
            isStreaming
              ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30'
              : 'bg-theme-accent/20 text-theme-accent hover:bg-theme-accent/30'
          }`}
          onClick={isStreaming ? stopStreaming : handleSend}
          title={isStreaming ? t('chat.stop') : t('chat.send')}
        >
          {isStreaming ? <Square className="w-4 h-4" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
