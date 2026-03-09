import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { useChatStore } from '@/store/chatStore';

/** Renders the in-progress streaming message with a blinking cursor */
export function StreamingMessage() {
  const { t } = useTranslation();
  const content = useChatStore((s) => s.streamingContent);
  const reasoning = useChatStore((s) => s.streamingReasoning);

  const renderedHtml = useMemo(() => {
    if (!content) return '';
    const raw = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] rounded-xl px-3 py-2 bg-surface text-sm text-foreground border border-theme-border">
        {/* Streaming reasoning */}
        {reasoning && (
          <div className="mb-2 text-xs text-muted-foreground italic whitespace-pre-wrap border-l-2 border-theme-border pl-4">
            {reasoning}
            <span className="inline-block w-1.5 h-3.5 bg-muted-foreground/60 ml-0.5 animate-pulse" />
          </div>
        )}

        {/* Streaming content */}
        {content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none break-words
            [&_pre]:bg-background [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:text-xs
            [&_code]:text-xs [&_code]:bg-background [&_code]:px-1 [&_code]:rounded">
            <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            <span className="inline-block w-1.5 h-4 bg-theme-accent ml-0.5 animate-pulse" />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block w-1.5 h-4 bg-theme-accent animate-pulse" />
            <span className="text-xs">{t('chat.thinking')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
