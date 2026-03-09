import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, FileInput, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { getEditorView } from '@/lib/editorViewRef';
import { useNoteStore } from '@/store/noteStore';
import { toast } from '@/hooks/useToast';

interface Props {
  result: string;
  title: string;
  notePath: string;
  onClose: () => void;
}

/** Dialog to display AI operation results with copy/insert actions */
export function AiResultDialog({ result, title, notePath, onClose }: Props) {
  const { t } = useTranslation();

  const renderedHtml = useMemo(() => {
    const raw = marked.parse(result, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [result]);

  const handleCopy = () => {
    navigator.clipboard.writeText(result);
    toast({ title: t('noteAi.copied') });
  };

  // Insert result at cursor or open the note and append
  const handleInsert = () => {
    const activeTab = useNoteStore.getState().activeTabPath;
    if (activeTab === notePath) {
      // Note is already open — insert at cursor
      const view = getEditorView();
      if (view) {
        const cursor = view.state.selection.main.head;
        view.dispatch({ changes: { from: cursor, insert: `\n${result}\n` } });
        toast({ title: t('noteAi.inserted') });
        onClose();
        return;
      }
    }
    // Otherwise open the note and let user paste manually
    useNoteStore.getState().openNote(notePath, title);
    navigator.clipboard.writeText(result);
    toast({ title: t('noteAi.copiedAndOpened') });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-theme-border rounded-xl shadow-2xl w-[520px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <button
            className="p-1 rounded hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div
            className="prose prose-sm dark:prose-invert max-w-none break-words
              [&_pre]:bg-background [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:text-xs
              [&_code]:text-xs [&_code]:bg-background [&_code]:px-1 [&_code]:rounded"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-theme-border">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors"
            onClick={handleCopy}
          >
            <Copy className="w-3.5 h-3.5" />
            {t('noteAi.copy')}
          </button>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25 transition-colors"
            onClick={handleInsert}
          >
            <FileInput className="w-3.5 h-3.5" />
            {t('noteAi.insertToNote')}
          </button>
          <button
            className="ml-auto px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-theme-hover transition-colors"
            onClick={onClose}
          >
            {t('noteAi.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
