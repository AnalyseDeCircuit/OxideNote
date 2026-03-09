import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, FileInput, ChevronRight, ChevronDown, RotateCcw, Trash2 } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { ChatMessage as ChatMessageType } from '@/lib/api';
import { EditCard } from '@/components/chat/EditCard';
import { useChatStore, type EditSuggestion } from '@/store/chatStore';
import { getEditorView } from '@/lib/editorViewRef';

interface Props {
  message: ChatMessageType;
  index: number;
  isLatest: boolean;
}

/** Render a single chat message (user or assistant) */
export function ChatMessage({ message, index, isLatest }: Props) {
  const { t } = useTranslation();
  const pendingEdits = useChatStore((s) => s.pendingEdits);

  if (message.role === 'user') {
    return <UserMessage message={message} index={index} />;
  }

  if (message.role === 'assistant') {
    const edits = isLatest ? pendingEdits : [];
    return <AssistantMessage message={message} edits={edits} index={index} />;
  }

  return null;
}

// ── User message ────────────────────────────────────────────

function UserMessage({ message, index }: { message: ChatMessageType; index: number }) {
  const { t } = useTranslation();
  const deleteMessage = useChatStore((s) => s.deleteMessage);

  return (
    <div className="flex justify-end group">
      <div className="max-w-[85%] rounded-xl px-3 py-2 bg-theme-accent/15 text-sm text-foreground relative">
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
        {message.images && message.images.length > 0 && (
          <div className="flex gap-1.5 mt-2">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt=""
                className="w-16 h-16 rounded-md object-cover border border-theme-border"
              />
            ))}
          </div>
        )}
        {/* Delete button — visible on hover */}
        <button
          className="absolute -left-7 top-1 p-0.5 rounded opacity-0 group-hover:opacity-100
            hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-all"
          onClick={() => deleteMessage(index)}
          title={t('chat.deleteMessage')}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ── Assistant message ───────────────────────────────────────

function AssistantMessage({ message, edits, index }: { message: ChatMessageType; edits: EditSuggestion[]; index: number }) {
  const { t } = useTranslation();
  const retryLastMessage = useChatStore((s) => s.retryLastMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const messageCount = useChatStore((s) => s.messages.length);
  const isStreaming = useChatStore((s) => s.isStreaming);

  // Check if this is the last assistant message for retry button
  const isLastAssistant = index === messageCount - 1 && message.role === 'assistant';

  // Strip <edit> XML before rendering Markdown
  const cleanContent = useMemo(() => {
    return message.content.replace(/<edit file="[^"]*">[\s\S]*?<\/edit>/g, '').trim();
  }, [message.content]);

  // Render Markdown → sanitised HTML
  const renderedHtml = useMemo(() => {
    const raw = marked.parse(cleanContent, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [cleanContent]);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
  };

  const handleInsert = () => {
    const view = getEditorView();
    if (!view) return;
    const cursor = view.state.selection.main.head;
    view.dispatch({
      changes: { from: cursor, insert: cleanContent },
    });
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] rounded-xl px-3 py-2 bg-surface text-sm text-foreground border border-theme-border">
        {/* Thinking block */}
        {message.reasoning && <ThinkingBlock reasoning={message.reasoning} />}

        {/* Markdown content */}
        <div
          className="prose prose-sm dark:prose-invert max-w-none break-words
            [&_pre]:bg-background [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:text-xs
            [&_code]:text-xs [&_code]:bg-background [&_code]:px-1 [&_code]:rounded"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />

        {/* Edit cards */}
        {edits.length > 0 && (
          <div className="mt-2 space-y-2">
            {edits.map((edit, i) => (
              <EditCard key={i} edit={edit} index={i} />
            ))}
          </div>
        )}

        {/* Action bar */}
        <div className="flex items-center gap-1 mt-2 pt-1 border-t border-theme-border/50">
          <button
            className="p-1 rounded hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleCopy}
            title={t('chat.copyMessage')}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1 rounded hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleInsert}
            title={t('chat.insertToEditor')}
          >
            <FileInput className="w-3.5 h-3.5" />
          </button>
          {isLastAssistant && !isStreaming && (
            <button
              className="p-1 rounded hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
              onClick={retryLastMessage}
              title={t('chat.retry')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-colors ml-auto"
            onClick={() => deleteMessage(index)}
            title={t('chat.deleteMessage')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Thinking block (collapsible) ────────────────────────────

function ThinkingBlock({ reasoning }: { reasoning: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-2">
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {expanded ? t('chat.reasoningCollapse') : t('chat.reasoningExpand')}
      </button>
      {expanded && (
        <div className="mt-1 pl-4 text-xs text-muted-foreground italic whitespace-pre-wrap border-l-2 border-theme-border">
          {reasoning}
        </div>
      )}
    </div>
  );
}
