import { useEffect, useRef, useCallback, useState, startTransition } from 'react';
import { useNoteStore, type SaveOutcome } from '@/store/noteStore';
import { registerPendingSave, unregisterPendingSave } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { readNote, writeNote, reindexNote, searchByFilename, saveAttachment, createNote } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import { useCodeMirrorEditor } from './hooks/useCodeMirrorEditor';
import { clearBlockRefCache } from './extensions/blockRef';
import { setEditorView, getEditorView } from '@/lib/editorViewRef';
import { EditorView } from '@codemirror/view';
import { MarkdownPreview } from './MarkdownPreview';
import { getPreviewScrollTopForSourceLine } from '@/components/editor/scrollSync';
import { EditorToolbar } from './EditorToolbar';
import { ConflictDialog } from '@/components/editor/ConflictDialog';
import { PDFViewer } from '@/components/pdf/PDFViewer';
import { DatabaseView, isDatabaseNote } from '@/components/database/DatabaseView';
import { CanvasEditor } from '@/components/canvas/CanvasEditor';
import { TypstPreview } from './TypstPreview';
import { TagSuggestion } from './TagSuggestion';
import { SmartLinkSuggestion } from './SmartLinkSuggestion';
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
  // 滚动源锁定：使用时间戳（而非 rAF 单帧）防止反馈循环。
  // 当一侧主动发起同步滚动时，另一侧在 SCROLL_LOCK_MS 内忽略自身 scroll 事件，
  // 避免 scrollTop 取整误差产生无限微调导致"慢慢往上滑"。
  const scrollLockRef = useRef<{ source: 'editor' | 'preview'; until: number } | null>(null);
  const SCROLL_LOCK_MS = 80;

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

    // Debounce preview update to avoid re-parsing on every keystroke.
    // Use a longer delay to reduce layout churn for large documents.
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => startTransition(() => setPreviewContent(content)), 500);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      // 再次确认当前活动路径与发起保存时一致，
      // 防止 debounce 期间切换标签页导致内容写入错误文件
      if (activePathRef.current === path) {
        saveNoteWithConflictCheck(path, contentRef.current);
      }
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

  const { containerRef, viewRef, setContent, refreshBlockRefs } = useCodeMirrorEditor({
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

    // PDF and canvas files are handled by dedicated viewers — skip CodeMirror
    if (activeTabPath.toLowerCase().endsWith('.pdf') || activeTabPath.toLowerCase().endsWith('.canvas')) {
      return () => {};
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

          // Handle pending scroll target (e.g. from canvas block card jump)
          const scrollTarget = useNoteStore.getState().pendingScrollTarget;
          if (scrollTarget) {
            useNoteStore.getState().setPendingScrollTarget(null);
            // Double-rAF: wait for CodeMirror to fully render the new content
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                scrollToBlockId(note.content, scrollTarget.blockId);
              });
            });
          }
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
      clearBlockRefCache(changedPath);
      refreshBlockRefs();
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
  }, [setContent, refreshBlockRefs]);

  // ── Conflict resolution handlers ─────────────────────────
  const handleConflictKeepMine = useCallback(async () => {
    if (!conflictState) return;
    const { path, localContent } = conflictState;
    // Force-write local content, ignoring mtime check
    try {
      const newMtime = await writeNote(path, localContent);
      // 使用 writeNote 返回的 mtime，避免额外的 readNote IPC 调用
      if (newMtime != null) {
        mtimeRef.current.set(path, newMtime);
      }
      // 标记为自己的写入，防止 watcher 误判为外部修改
      recentWritesRef.current.set(path, Date.now());
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
      const lock = scrollLockRef.current;
      if (lock && lock.source === 'preview' && Date.now() < lock.until) return;

      scrollLockRef.current = { source: 'editor', until: Date.now() + SCROLL_LOCK_MS };
      const el = previewScrollRef.current;
      if (!el) return;

      const visibleLine = getTopVisibleEditorLine(view, scrollDOM.scrollTop);
      el.scrollTop = getPreviewScrollTopForSourceLine(el, visibleLine);
    };

    scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });
    return () => scrollDOM.removeEventListener('scroll', onEditorScroll);
  }, [editorMode, viewRef]);

  // ── Sync scroll: preview → editor ────────────────────────
  const handlePreviewScroll = useCallback((sourceLine: number) => {
    const lock = scrollLockRef.current;
    if (lock && lock.source === 'editor' && Date.now() < lock.until) return;

    scrollLockRef.current = { source: 'preview', until: Date.now() + SCROLL_LOCK_MS };
    const view = viewRef.current;
    if (!view) return;

    setEditorScrollTopForLine(view, sourceLine);
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

  // Dedicated viewers for non-Markdown file types
  const isPdf = activeTabPath?.toLowerCase().endsWith('.pdf');
  const isCanvas = activeTabPath?.toLowerCase().endsWith('.canvas');
  const isTypst = activeTabPath?.toLowerCase().endsWith('.typ');
  // Binary/special files bypass CodeMirror entirely; Typst is editable text
  const isSpecialFile = isPdf || isCanvas;

  return (
    <div className="h-full w-full flex flex-col relative">
      {/* PDF viewer — bypass CodeMirror entirely */}
      {isPdf && activeTabPath && (
        <PDFViewer path={activeTabPath} />
      )}

      {/* Canvas editor — persistent whiteboard for .canvas files */}
      {isCanvas && activeTabPath && (
        <CanvasEditor canvasPath={activeTabPath} />
      )}

      {/* Markdown editor + toolbar (only for plain text files) */}
      {!isSpecialFile && activeTabPath && showEditor && <EditorToolbar viewRef={viewRef} />}

      {!isSpecialFile && (
      <div className="flex-1 min-h-0 flex" onPaste={handlePaste} onDrop={handleDrop} onDragOver={handleDragOver}>
        {/* ── CodeMirror 编辑区域 ───────────────────────────── */}
        <div
          ref={containerRef}
          className={`overflow-auto [&_.cm-editor]:h-full [&_.cm-editor]:outline-none ${
            !activeTabPath ? 'hidden' : ''
          } ${showEditor ? (showPreview ? 'w-1/2 border-r border-theme-border' : 'w-full') : 'hidden'}`}
          style={{ height: '100%' }}
        />

        {/* ── 预览区域：数据库视图 / Typst 预览 / Markdown 预览 ── */}
        {activeTabPath && showPreview && (
          isTypst ? (
            <TypstPreview
              path={activeTabPath}
              className={showEditor ? 'w-1/2' : 'w-full'}
            />
          ) : isDatabaseNote(previewContent) ? (
            <div className={showEditor ? 'w-1/2' : 'w-full'}>
              <DatabaseView content={previewContent} filePath={activeTabPath} />
            </div>
          ) : (
            <MarkdownPreview
              content={previewContent}
              className={showEditor ? 'w-1/2' : 'w-full'}
              scrollRef={previewScrollRef}
              onScroll={handlePreviewScroll}
            />
          )
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
      )}

      {/* ── Tag suggestion pills (AI-powered) ─────────────── */}
      {activeTabPath && !isSpecialFile && !isTypst && activeTabPath.endsWith('.md') && (
        <div className="shrink-0 px-3 py-1 border-t border-theme-border flex items-center gap-3">
          <TagSuggestion
            path={activeTabPath}
            title={activeTabPath.replace(/\.md$/, '').split('/').pop() ?? ''}
          />
          <SmartLinkSuggestion
            path={activeTabPath}
            title={activeTabPath.replace(/\.md$/, '').split('/').pop() ?? ''}
          />
        </div>
      )}

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

function getTopVisibleEditorLine(view: NonNullable<ReturnType<typeof useCodeMirrorEditor>['viewRef']['current']>, scrollTop: number): number {
  const block = view.lineBlockAtHeight(scrollTop);
  const sourceLine = view.state.doc.lineAt(block.from).number - 1;
  const nextLineNumber = Math.min(sourceLine + 2, view.state.doc.lines);
  const nextBlock = view.lineBlockAt(view.state.doc.line(nextLineNumber).from);
  const blockHeight = Math.max(nextBlock.top - block.top, 1);
  const progress = Math.min(1, Math.max(0, (scrollTop - block.top) / blockHeight));
  return sourceLine + progress;
}

function setEditorScrollTopForLine(view: NonNullable<ReturnType<typeof useCodeMirrorEditor>['viewRef']['current']>, sourceLine: number) {
  const clampedLine = Math.max(0, Math.min(sourceLine, view.state.doc.lines - 1));
  const baseLineNumber = Math.floor(clampedLine) + 1;
  const fraction = clampedLine - Math.floor(clampedLine);
  const baseBlock = view.lineBlockAt(view.state.doc.line(baseLineNumber).from);
  const nextLineNumber = Math.min(baseLineNumber + 1, view.state.doc.lines);
  const nextBlock = view.lineBlockAt(view.state.doc.line(nextLineNumber).from);
  const blockHeight = Math.max(nextBlock.top - baseBlock.top, 1);
  view.scrollDOM.scrollTop = baseBlock.top + fraction * blockHeight;
}

/**
 * Scroll CodeMirror editor to the line containing a ^blockId marker.
 * Searches content for the block ID pattern and scrolls if found.
 */
function scrollToBlockId(content: string, blockId: string) {
  const view = getEditorView();
  if (!view) return;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`^${blockId}`)) {
      // CodeMirror lines are 1-based
      const lineNumber = i + 1;
      if (lineNumber > view.state.doc.lines) return;

      const docLine = view.state.doc.line(lineNumber);
      view.dispatch({
        effects: EditorView.scrollIntoView(docLine.from, { y: 'center' }),
        selection: { anchor: docLine.from },
      });
      view.focus();
      return;
    }
  }
}
