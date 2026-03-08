import { useEffect, useRef, useCallback, useState } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { registerPendingSave, unregisterPendingSave } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { readNote, writeNote, reindexNote, searchByFilename, saveAttachment, createNote } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import { useCodeMirrorEditor } from './hooks/useCodeMirrorEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { EditorToolbar } from './EditorToolbar';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { toast } from '@/hooks/useToast';

// ═══════════════════════════════════════════════════════════════
// NoteEditor — 核心编辑组件
//
// 支持三种视图模式：
//   · edit    — 纯 CodeMirror 编辑器
//   · preview — 纯 Markdown 渲染预览
//   · split   — 左右分屏（编辑 + 实时预览）
// ═══════════════════════════════════════════════════════════════

export function NoteEditor() {
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const editorMode = useUIStore((s) => s.editorMode);
  const { t } = useTranslation();
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const fontFamily = useSettingsStore((s) => s.editorFontFamily);
  const lineHeight = useSettingsStore((s) => s.editorLineHeight);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef('');
  const activePathRef = useRef(activeTabPath);
  activePathRef.current = activeTabPath;

  // ── Sync-scroll refs ──────────────────────────────────────
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const scrollSourceRef = useRef<'editor' | 'preview' | null>(null);

  // 预览模式使用 state 驱动，确保内容变化时重新渲染
  const [previewContent, setPreviewContent] = useState('');

  const handleChange = useCallback((content: string) => {
    contentRef.current = content;
    useNoteStore.getState().setActiveContent(content);
    const path = activePathRef.current;
    if (!path) return;

    useNoteStore.getState().markDirty(path);

    // Debounce preview update to avoid re-parsing on every keystroke
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => setPreviewContent(content), 300);

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
    try {
      const results = await searchByFilename(target);
      if (results.length > 0) {
        useNoteStore.getState().openNote(results[0].path, results[0].title || results[0].path);
      } else {
        // WikiLink target doesn't exist — create and open
        const newPath = await createNote('', target);
        useNoteStore.getState().openNote(newPath, target);
        toast({ title: t('wikilink.created', { name: target }), variant: 'success' });
      }
    } catch {
      // WikiLink navigation/creation failed
    }
  }, [t]);

  // ── 图片粘贴/拖拽处理 ────────────────────────────────────
  // 从剪贴板或拖拽事件中捕获图片文件，
  // 保存到 .attachments 目录并插入 Markdown 图片引用
  const handleImageFile = useCallback(async (file: File) => {
    const view = viewRef.current;
    if (!view || !activePathRef.current) return;

    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      const relPath = await saveAttachment(base64, file.name);
      const markdown = `![${file.name}](${relPath})`;
      const { from } = view.state.selection.main;
      view.dispatch({
        changes: { from, to: from, insert: markdown },
        selection: { anchor: from + markdown.length },
      });
    } catch (err) {
      toast({ title: t('editor.imageUploadFailed'), description: String(err), variant: 'error' });
    }
  }, []);

  const { containerRef, viewRef, setContent } = useCodeMirrorEditor({
    onChange: handleChange,
    onSave: handleSave,
    onNavigate: handleNavigate,
    fontSize,
    fontFamily,
    lineHeight,
    tabSize,
    wordWrap,
  });

  // ── 加载笔记内容 ─────────────────────────────────────────
  useEffect(() => {
    // 切换 Tab 时，立即清除旧 Tab 的待保存定时器，
    // 防止将旧内容误写入新 Tab 文件
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }

    if (!activeTabPath) {
      setContent('');
      contentRef.current = '';
      useNoteStore.getState().setActiveContent('');
      return;
    }

    // Register a flush callback so external callers (e.g. close-tab, app exit)
    // can force an immediate save of any pending changes.
    registerPendingSave(activeTabPath, async () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const path = activePathRef.current;
      if (path) await saveNote(path, contentRef.current);
    });

    let cancelled = false;

    readNote(activeTabPath)
      .then((note) => {
        if (!cancelled) {
          setContent(note.content);
          contentRef.current = note.content;
          setPreviewContent(note.content);
          useNoteStore.getState().setActiveContent(note.content);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load note:', err);
          setContent('');
          contentRef.current = '';
          setPreviewContent('');
          useNoteStore.getState().setActiveContent('');
        }
      });

    return () => {
      cancelled = true;
      unregisterPendingSave(activeTabPath);
    };
  }, [activeTabPath, setContent]);

  // ── 组件卸载时立即保存未写入的内容 ────────────────────────
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const path = activePathRef.current;
        if (path) saveNote(path, contentRef.current);
      }
    };
  }, []);

  // ── 判断各面板是否可见 ────────────────────────────────────
  const showEditor = editorMode === 'edit' || editorMode === 'split';
  const showPreview = editorMode === 'preview' || editorMode === 'split';

  // ── Sync scroll: editor → preview ────────────────────────
  useEffect(() => {
    if (editorMode !== 'split') return;
    const view = viewRef.current;
    if (!view) return;
    const scrollDOM = view.scrollDOM;

    const onEditorScroll = () => {
      if (scrollSourceRef.current === 'preview') return;
      scrollSourceRef.current = 'editor';
      const el = previewScrollRef.current;
      if (!el) return;
      const maxEditor = scrollDOM.scrollHeight - scrollDOM.clientHeight;
      if (maxEditor <= 0) return;
      const fraction = scrollDOM.scrollTop / maxEditor;
      const maxPreview = el.scrollHeight - el.clientHeight;
      el.scrollTop = fraction * maxPreview;
      requestAnimationFrame(() => { scrollSourceRef.current = null; });
    };

    scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });
    return () => scrollDOM.removeEventListener('scroll', onEditorScroll);
  }, [editorMode, viewRef]);

  // ── Sync scroll: preview → editor ────────────────────────
  const handlePreviewScroll = useCallback((fraction: number) => {
    if (scrollSourceRef.current === 'editor') return;
    scrollSourceRef.current = 'preview';
    const view = viewRef.current;
    if (!view) return;
    const scrollDOM = view.scrollDOM;
    const maxEditor = scrollDOM.scrollHeight - scrollDOM.clientHeight;
    scrollDOM.scrollTop = fraction * maxEditor;
    requestAnimationFrame(() => { scrollSourceRef.current = null; });
  }, [viewRef]);

  // ── 粘贴事件：检测剪贴板中的图片 ─────────────────────────
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) handleImageFile(file);
          return;
        }
      }
    },
    [handleImageFile]
  );

  // ── 拖拽事件：检测拖入的图片文件 ─────────────────────────
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const files = e.dataTransfer.files;
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          e.preventDefault();
          handleImageFile(file);
          return;
        }
      }
    },
    [handleImageFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div className="h-full w-full flex flex-col relative">
      {/* 编辑器工具栏（仅在编辑/分屏模式下显示） */}
      {activeTabPath && showEditor && <EditorToolbar viewRef={viewRef} />}

      <div className="flex-1 min-h-0 flex" onPaste={handlePaste} onDrop={handleDrop} onDragOver={handleDragOver}>
        {/* ── CodeMirror 编辑区域 ───────────────────────────── */}
        <div
          ref={containerRef}
          className={`overflow-auto [&_.cm-editor]:h-full [&_.cm-editor]:outline-none ${
            !activeTabPath ? 'hidden' : ''
          } ${showEditor ? (showPreview ? 'w-1/2 border-r border-theme-border' : 'w-full') : 'hidden'}`}
          style={{ height: '100%' }}
        />

        {/* ── Markdown 预览区域 ─────────────────────────────── */}
        {activeTabPath && showPreview && (
          <MarkdownPreview
            content={previewContent}
            className={showEditor ? 'w-1/2' : 'w-full'}
            scrollRef={previewScrollRef}
            onScroll={handlePreviewScroll}
          />
        )}

        {/* ── 空状态占位 ───────────────────────────────────── */}
        {!activeTabPath && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            <div className="text-center">
              <p className="text-lg mb-1">{t('editor.noSelection')}</p>
              <p className="text-xs">{t('editor.noSelectionHint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 保存笔记到磁盘并重建索引 ────────────────────────────────
async function saveNote(path: string, content: string) {
  try {
    await writeNote(path, content);
    useNoteStore.getState().markClean(path);
    // 保存后重新索引，保持反向链接和搜索的时效性
    // 索引失败不阻塞保存，仅记录警告
    reindexNote(path).catch((err) => {
      console.warn('[reindex] failed for', path, err);
    });
  } catch (err) {
    toast({ title: i18n.t('editor.saveFailed'), description: String(err), variant: 'error' });
  }
}
