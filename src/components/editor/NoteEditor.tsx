import { useEffect, useRef, useCallback, useState } from 'react';
import { useNoteStore, type SaveOutcome } from '@/store/noteStore';
import { registerPendingSave, unregisterPendingSave } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { readNote, writeNote, reindexNote, searchByFilename, saveAttachment, createNote } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import { useCodeMirrorEditor } from './hooks/useCodeMirrorEditor';
import { setEditorView } from '@/lib/editorViewRef';
import { MarkdownPreview } from './MarkdownPreview';
import { EditorToolbar } from './EditorToolbar';
import { ConflictDialog } from '@/components/editor/ConflictDialog';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { toast } from '@/hooks/useToast';
import { listen } from '@tauri-apps/api/event';

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
  const conflictState = useNoteStore((s) =>
    activeTabPath ? s.conflicts[activeTabPath] ?? null : null
  );
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
  const contentUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef('');
  const activePathRef = useRef(activeTabPath);
  activePathRef.current = activeTabPath;

  // ── Conflict detection refs ────────────────────────────────
  // Tracks the file mtime (epoch ms) at last read/save, per path
  const mtimeRef = useRef<Map<string, number | null>>(new Map());

  // ── Watcher source marking ────────────────────────────────
  // 记录我们自己触发的写入路径及时间戳，
  // 当 watcher 事件到来时识别为"自己写的"而非外部修改，避免伪冲突
  const recentWritesRef = useRef<Map<string, number>>(new Map());

  // ── Sync-scroll refs ──────────────────────────────────────
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const scrollSourceRef = useRef<'editor' | 'preview' | null>(null);

  // 预览模式使用 state 驱动，确保内容变化时重新渲染
  const [previewContent, setPreviewContent] = useState('');

  const handleChange = useCallback((content: string) => {
    contentRef.current = content;
    const path = activePathRef.current;
    if (!path) return;

    useNoteStore.getState().markDirty(path);

    // Debounce setActiveContent to reduce Zustand rerenders (OutlinePanel etc.)
    if (contentUpdateTimerRef.current) clearTimeout(contentUpdateTimerRef.current);
    contentUpdateTimerRef.current = setTimeout(() => {
      useNoteStore.getState().setActiveContent(contentRef.current);
    }, 150);

    // Debounce preview update to avoid re-parsing on every keystroke
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => setPreviewContent(content), 300);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      saveNoteWithConflictCheck(path, contentRef.current);
    }, autoSaveDelay);
  }, [autoSaveDelay]);

  const handleSave = useCallback(() => {
    const path = activePathRef.current;
    if (!path) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // 优先从 EditorView 取最新内容，避免 debounce 间隙的过期数据
    const content = viewRef.current?.state.doc.toString() ?? contentRef.current;
    contentRef.current = content;
    saveNoteWithConflictCheck(path, content);
  }, []);

  const handleNavigate = useCallback(async (target: string) => {
    try {
      const results = await searchByFilename(target);
      if (results.length > 0) {
        // 精确匹配优先：先查找 stem 完全一致的结果，避免模糊匹配打开错误笔记
        const targetLower = target.toLowerCase();
        const exact = results.find((r) => {
          const stem = r.path.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
          return stem === targetLower || r.path.toLowerCase() === targetLower;
        });
        const best = exact ?? results[0];
        useNoteStore.getState().openNote(best.path, best.title || best.path);
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

  // Expose EditorView to global ref for OutlinePanel etc.
  useEffect(() => {
    setEditorView(viewRef.current);
    return () => setEditorView(null);
  }, [viewRef]);

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
      if (!path) return 'noop';
      // 取 EditorView 最新内容，避免 debounce 间隙导致的数据过期
      const content = viewRef.current?.state.doc.toString() ?? contentRef.current;
      contentRef.current = content;
      return saveNoteWithConflictCheck(path, content);
    });

    let cancelled = false;

    readNote(activeTabPath)
      .then((note) => {
        if (!cancelled) {
          setContent(note.content);
          contentRef.current = note.content;
          setPreviewContent(note.content);
          useNoteStore.getState().setActiveContent(note.content);
          // Store the mtime so we can detect conflicts on save
          mtimeRef.current.set(activeTabPath, note.modified_at_ms);
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
        if (path) saveNoteWithConflictCheck(path, contentRef.current);
      }
    };
  }, []);

  // ── 监听外部文件变更，检测冲突 ─────────────────────────────
  useEffect(() => {
    const unlisten = listen<{ kind: string; path: string }>('vault:file-changed', (event) => {
      const { kind, path: changedPath } = event.payload;
      if (kind !== 'modify') return;
      const currentPath = activePathRef.current;
      if (!currentPath || changedPath !== currentPath) return;

      // 检查是否为我们自己的写入触发的 watcher 事件
      const writeTime = recentWritesRef.current.get(currentPath);
      if (writeTime && Date.now() - writeTime < 2000) {
        // 自己写的，不是外部修改，忽略并清除标记
        recentWritesRef.current.delete(currentPath);
        return;
      }

      // The file we're editing was modified externally.
      // If the editor has dirty (unsaved) content, surface a conflict.
      const tab = useNoteStore.getState().openTabs.find((t) => t.path === currentPath);
      if (tab?.isDirty) {
        // Cancel any pending auto-save to prevent overwriting
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        useNoteStore.getState().setConflict(currentPath, contentRef.current);
      } else {
        // No local changes — silently reload
        readNote(currentPath)
          .then((note) => {
            if (activePathRef.current === currentPath) {
              setContent(note.content);
              contentRef.current = note.content;
              setPreviewContent(note.content);
              useNoteStore.getState().setActiveContent(note.content);
              mtimeRef.current.set(currentPath, note.modified_at_ms);
            }
          })
          .catch(() => {});
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [setContent]);

  // ── Conflict resolution handlers ─────────────────────────
  const handleConflictKeepMine = useCallback(async () => {
    if (!conflictState) return;
    const { path, localContent } = conflictState;
    // Force-write local content, ignoring mtime check
    try {
      await writeNote(path, localContent);
      // Re-read to get new mtime
      const note = await readNote(path);
      mtimeRef.current.set(path, note.modified_at_ms);
      useNoteStore.getState().markClean(path);
      useNoteStore.getState().clearConflict(path);
      reindexNote(path).catch(() => {});
    } catch (err) {
      toast({ title: i18n.t('editor.saveFailed'), description: String(err), variant: 'error' });
    }
  }, [conflictState]);

  const handleConflictLoadRemote = useCallback(async () => {
    if (!conflictState) return;
    const { path } = conflictState;
    try {
      const note = await readNote(path);
      setContent(note.content);
      contentRef.current = note.content;
      setPreviewContent(note.content);
      useNoteStore.getState().setActiveContent(note.content);
      useNoteStore.getState().markClean(path);
      mtimeRef.current.set(path, note.modified_at_ms);
      useNoteStore.getState().clearConflict(path);
    } catch (err) {
      toast({ title: i18n.t('editor.saveFailed'), description: String(err), variant: 'error' });
    }
  }, [conflictState, setContent]);

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

      {/* ── 文件冲突对话框 ─────────────────────────────────── */}
      {conflictState && (
        <ConflictDialog
          path={conflictState.path}
          onKeepMine={handleConflictKeepMine}
          onLoadRemote={handleConflictLoadRemote}
        />
      )}
    </div>
  );

  // ── Inner: save with mtime-based conflict check ───────────
  async function saveNoteWithConflictCheck(path: string, content: string): Promise<SaveOutcome> {
    const expectedMtime = mtimeRef.current.get(path) ?? undefined;
    try {
      const newMtime = await writeNote(path, content, expectedMtime);
      // 标记为自己的写入，避免 watcher 事件误判为外部修改
      recentWritesRef.current.set(path, Date.now());
      useNoteStore.getState().markClean(path);
      useNoteStore.getState().clearConflict(path);
      // 直接使用返回的 mtime，无需额外 readNote 调用
      mtimeRef.current.set(path, newMtime);
      reindexNote(path).catch((err) => {
        console.warn('[reindex] failed for', path, err);
      });
      return 'saved';
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('CONFLICT')) {
        // Cancel further auto-saves
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        useNoteStore.getState().setConflict(path, content);
        return 'conflict';
      } else {
        toast({ title: i18n.t('editor.saveFailed'), description: errStr, variant: 'error' });
        return 'failed';
      }
    }
  }
}
