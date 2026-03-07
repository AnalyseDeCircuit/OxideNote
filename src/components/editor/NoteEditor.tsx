import { useEffect, useRef, useCallback } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { readNote, writeNote, reindexNote, searchByFilename } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import { useCodeMirrorEditor } from './hooks/useCodeMirrorEditor';
import { useTranslation } from 'react-i18next';
import { toast } from '@/hooks/useToast';

export function NoteEditor() {
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const { t } = useTranslation();
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const fontFamily = useSettingsStore((s) => s.editorFontFamily);
  const lineHeight = useSettingsStore((s) => s.editorLineHeight);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef('');
  const activePathRef = useRef(activeTabPath);
  activePathRef.current = activeTabPath;

  const handleChange = useCallback((content: string) => {
    contentRef.current = content;
    const path = activePathRef.current;
    if (!path) return;

    useNoteStore.getState().markDirty(path);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      saveNote(path, contentRef.current);
    }, autoSaveDelay);
  }, [autoSaveDelay]);

  const handleSave = useCallback(() => {
    const path = activePathRef.current;
    if (!path) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveNote(path, contentRef.current);
  }, []);

  const handleNavigate = useCallback(async (target: string) => {
    // Try to find the target note by filename search
    try {
      const results = await searchByFilename(target);
      if (results.length > 0) {
        useNoteStore.getState().openNote(results[0].path, results[0].title || results[0].path);
      }
    } catch {
      // Note doesn't exist or search failed — ignore silently
    }
  }, []);

  const { containerRef, setContent } = useCodeMirrorEditor({
    onChange: handleChange,
    onSave: handleSave,
    onNavigate: handleNavigate,
    fontSize,
    fontFamily,
    lineHeight,
    tabSize,
    wordWrap,
  });

  // Load note content when active tab changes
  useEffect(() => {
    if (!activeTabPath) {
      setContent('');
      contentRef.current = '';
      return;
    }

    let cancelled = false;

    readNote(activeTabPath)
      .then((note) => {
        if (!cancelled) {
          setContent(note.content);
          contentRef.current = note.content;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load note:', err);
          setContent('');
          contentRef.current = '';
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTabPath, setContent]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="h-full w-full relative">
      {/* Always render so CodeMirror initializes on mount */}
      <div
        ref={containerRef}
        className={`h-full w-full overflow-auto [&_.cm-editor]:h-full [&_.cm-editor]:outline-none ${!activeTabPath ? 'hidden' : ''}`}
      />
      {!activeTabPath && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
          <div className="text-center">
            <p className="text-lg mb-1">{t('editor.noSelection')}</p>
            <p className="text-xs">{t('editor.noSelectionHint')}</p>
          </div>
        </div>
      )}
    </div>
  );
}

async function saveNote(path: string, content: string) {
  try {
    await writeNote(path, content);
    useNoteStore.getState().markClean(path);
    // Re-index after save so backlinks/search stay current
    reindexNote(path).catch(() => {});
  } catch (err) {
    toast({ title: 'Save failed', description: String(err), variant: 'error' });
  }
}
