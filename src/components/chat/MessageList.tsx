import { useEffect, useRef, useCallback } from 'react';

import { useChatStore } from '@/store/chatStore';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { StreamingMessage } from '@/components/chat/StreamingMessage';

/** Scrollable message list with auto-scroll */
export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // Track whether user is near the bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 100;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll when new content arrives (if user is near bottom)
  // Subscribe to streamingContent length so we scroll during streaming too
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isStreaming, streamingContent.length, streamingReasoning.length]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3"
      onScroll={handleScroll}
    >
      {messages.map((msg, i) => (
        <ChatMessage key={i} message={msg} index={i} isLatest={i === messages.length - 1} />
      ))}
      {isStreaming && <StreamingMessage />}
      <div ref={bottomRef} />
    </div>
  );
}
