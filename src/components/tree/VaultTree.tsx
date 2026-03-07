import { useState, useCallback, useRef, useEffect, memo, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Plus,
  FolderPlus,
  RefreshCw,
  CalendarDays,
  ArrowUpDown,
} from 'lucide-react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useNoteStore } from '@/store/noteStore';
import { validateFilename } from '@/lib/validateFilename';
import { confirm } from '@tauri-apps/plugin-dialog';
import {
  listTree,
  createNote,
  createFolder,
  renameEntry,
  deleteEntry,
  moveEntry,
  searchByFilename,
  type TreeNode,
} from '@/lib/api';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from '@/hooks/useToast';

export function VaultTree() {
  const { t } = useTranslation();
  const tree = useWorkspaceStore((s) => s.tree);
  const treeLoading = useWorkspaceStore((s) => s.treeLoading);
  const sortMode = useSettingsStore((s) => s.sortMode);

  const handleToggleSort = useCallback(() => {
    const next = sortMode === 'name' ? 'modified' : 'name';
    useSettingsStore.getState().setSortMode(next);
    refreshTree();
  }, [sortMode]);

  // ── 内联创建状态 ──────────────────────────────────────────
  // Tauri WebView 不支持 window.prompt()，使用内联输入替代
  const [inlineCreate, setInlineCreate] = useState<{
    type: 'note' | 'folder';
    parentPath: string;
  } | null>(null);

  const handleNewNote = useCallback(() => {
    setInlineCreate({ type: 'note', parentPath: '' });
  }, []);

  const handleNewFolder = useCallback(() => {
    setInlineCreate({ type: 'folder', parentPath: '' });
  }, []);

  const handleInlineSubmit = useCallback(async (name: string) => {
    if (!inlineCreate || !name.trim()) {
      setInlineCreate(null);
      return;
    }
    const err = validateFilename(name.trim());
    if (err) {
      const msg = err === 'empty' ? t('sidebar.emptyFilename') : err === 'reserved' ? t('sidebar.reservedFilename') : t('sidebar.invalidFilename');
      toast({ title: msg, variant: 'error' });
      setInlineCreate(null);
      return;
    }
    const { type, parentPath } = inlineCreate;
    setInlineCreate(null);
    try {
      if (type === 'note') {
        const path = await createNote(parentPath, name.trim());
        await refreshTree();
        const title = name.trim().replace(/\.md$/, '');
        useNoteStore.getState().openNote(path, title);
      } else {
        await createFolder(parentPath, name.trim());
        await refreshTree();
      }
    } catch (err) {
      toast({ title: t('sidebar.createFailed'), description: String(err), variant: 'error' });
    }
  }, [inlineCreate]);

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('sidebar.files')}
        </span>
        <div className="flex items-center gap-0.5">
          <ToolbarButton icon={<CalendarDays size={14} />} title={t('dailyNote.tooltip')} onClick={handleCreateDailyNote} />
          <ToolbarButton icon={<Plus size={14} />} title={t('sidebar.newNote')} onClick={handleNewNote} />
          <ToolbarButton icon={<FolderPlus size={14} />} title={t('sidebar.newFolder')} onClick={handleNewFolder} />
          <ToolbarButton icon={<RefreshCw size={14} />} title={t('sidebar.refresh')} onClick={handleRefresh} />
          <ToolbarButton
            icon={<ArrowUpDown size={14} />}
            title={sortMode === 'name' ? t('sidebar.sortByModified') : t('sidebar.sortByName')}
            onClick={handleToggleSort}
          />
        </div>
      </div>

      {/* 内联创建输入框 */}
      {inlineCreate && (
        <InlineCreateInput
          type={inlineCreate.type}
          onSubmit={handleInlineSubmit}
          onCancel={() => setInlineCreate(null)}
        />
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1" role="tree" aria-label={t('sidebar.files')}>
        {treeLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            {t('sidebar.loading')}
          </div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-8 text-center text-muted-foreground text-xs leading-relaxed">
            {t('sidebar.emptyVault')}
          </div>
        ) : (
          tree.map((node) => (
            <TreeItem key={node.path} node={node} depth={0} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Tree Item ───────────────────────────────────────────────

const TreeItem = memo(function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [dragOver, setDragOver] = useState(false);
  const [inlineCreate, setInlineCreate] = useState<'note' | 'folder' | null>(null);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const isActive = !node.is_dir && node.path === activeTabPath;

  const handleClick = useCallback(() => {
    if (node.is_dir) {
      setExpanded((prev) => !prev);
    } else {
      const title = node.name.replace(/\.md$/, '');
      useNoteStore.getState().openNote(node.path, title);
    }
  }, [node]);

  // ── 拖拽：开始拖动 ──────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData('text/oxide-tree-path', node.path);
      e.dataTransfer.effectAllowed = 'move';
    },
    [node.path]
  );

  // ── 拖拽：进入目标区域 ──────────────────────────────────
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!node.is_dir) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
    },
    [node.is_dir]
  );

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  // ── 拖拽：放下到目标文件夹 ──────────────────────────────
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      if (!node.is_dir) return;
      const sourcePath = e.dataTransfer.getData('text/oxide-tree-path');
      if (!sourcePath || sourcePath === node.path) return;

      // 防止将文件夹拖入自身子目录
      if (sourcePath && node.path.startsWith(sourcePath + '/')) return;

      try {
        const newPath = await moveEntry(sourcePath, node.path);
        // 如果拖动的是当前打开的标签，更新路径
        const fileName = sourcePath.split('/').pop()?.replace(/\.md$/, '') || '';
        useNoteStore.getState().updateTabPath(sourcePath, newPath, fileName);
        await refreshTree();
      } catch (err) {
        toast({ title: t('sidebar.moveFailed'), description: String(err), variant: 'error' });
      }
    },
    [node.path, node.is_dir]
  );

  const handleRenameSubmit = useCallback(async () => {
    if (renameValue && renameValue !== node.name) {
      const err = validateFilename(renameValue.trim());
      if (err) {
        const msg = err === 'empty' ? t('sidebar.emptyFilename') : err === 'reserved' ? t('sidebar.reservedFilename') : t('sidebar.invalidFilename');
        toast({ title: msg, variant: 'error' });
        setRenaming(false);
        setRenameValue(node.name);
        return;
      }
      try {
        const newPath = await renameEntry(node.path, renameValue);
        // If it was an open tab, update its path
        const title = renameValue.replace(/\.md$/, '');
        useNoteStore.getState().updateTabPath(node.path, newPath, title);
        await refreshTree();
      } catch (err) {
        toast({ title: t('sidebar.renameFailed'), description: String(err), variant: 'error' });
      }
    }
    setRenaming(false);
  }, [renameValue, node]);

  const handleRenameKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        setRenaming(false);
        setRenameValue(node.name);
      }
    },
    [handleRenameSubmit, node.name]
  );

  const handleDelete = useCallback(async () => {
    const confirmMsg = node.is_dir
      ? t('sidebar.deleteConfirmFolder', { name: node.name })
      : t('sidebar.deleteConfirmFile', { name: node.name });
    const confirmed = await confirm(confirmMsg, { title: 'OxideNote', kind: 'warning' });
    if (!confirmed) return;
    try {
      await deleteEntry(node.path);
      // Close tab if it was open
      useNoteStore.getState().closeTab(node.path);
      await refreshTree();
    } catch (err) {
      toast({ title: t('sidebar.deleteFailed'), description: String(err), variant: 'error' });
    }
  }, [node.path, node.name, node.is_dir]);

  const parentDir = node.path.includes('/')
    ? node.path.substring(0, node.path.lastIndexOf('/'))
    : '';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          {/* Row */}
          <div
            className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer text-sm select-none hover:bg-theme-hover transition-colors ${
              isActive ? 'bg-theme-hover text-foreground' : 'text-foreground/80'
            } ${dragOver ? 'ring-1 ring-theme-accent bg-theme-hover/50' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={handleClick}
            draggable
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="treeitem"
            aria-selected={isActive}
            aria-expanded={node.is_dir ? expanded : undefined}
          >
            {/* Chevron or spacer */}
            {node.is_dir ? (
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground">
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            ) : (
              <span className="w-4 shrink-0" />
            )}

            {/* Icon */}
            <span className="shrink-0 text-muted-foreground">
              {node.is_dir ? (
                expanded ? <FolderOpen size={14} /> : <Folder size={14} />
              ) : (
                <File size={14} />
              )}
            </span>

            {/* Name */}
            {renaming ? (
              <RenameInput
                value={renameValue}
                onChange={setRenameValue}
                onSubmit={handleRenameSubmit}
                onKeyDown={handleRenameKeyDown}
              />
            ) : (
              <span className="truncate text-[13px]">
                {node.name}
              </span>
            )}
          </div>

          {/* Children */}
          {node.is_dir && expanded && node.children && (
            <div>
              {/* 文件夹内的内联创建输入框 */}
              {inlineCreate && (
                <InlineCreateInput
                  type={inlineCreate}
                  onSubmit={async (name) => {
                    setInlineCreate(null);
                    if (!name.trim()) return;
                    const err = validateFilename(name.trim());
                    if (err) {
                      const msg = err === 'empty' ? t('sidebar.emptyFilename') : err === 'reserved' ? t('sidebar.reservedFilename') : t('sidebar.invalidFilename');
                      toast({ title: msg, variant: 'error' });
                      return;
                    }
                    try {
                      if (inlineCreate === 'note') {
                        const path = await createNote(node.path, name.trim());
                        await refreshTree();
                        const title = name.trim().replace(/\.md$/, '');
                        useNoteStore.getState().openNote(path, title);
                      } else {
                        await createFolder(node.path, name.trim());
                        await refreshTree();
                      }
                    } catch (err) {
                      toast({ title: t('sidebar.createFailed'), description: String(err), variant: 'error' });
                    }
                  }}
                  onCancel={() => setInlineCreate(null)}
                  depth={depth + 1}
                />
              )}
              {node.children.map((child) => (
                <TreeItem key={child.path} node={child} depth={depth + 1} />
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {node.is_dir && (
          <>
            <ContextMenuItem onClick={() => {
              setExpanded(true);
              setInlineCreate('note');
            }}>
              <Plus size={14} className="mr-2" />
              {t('sidebar.newNote')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              setExpanded(true);
              setInlineCreate('folder');
            }}>
              <FolderPlus size={14} className="mr-2" />
              {t('sidebar.newFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          onClick={() => {
            setRenameValue(node.name);
            setRenaming(true);
          }}
        >
          {t('sidebar.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleDelete} className="text-red-400">
          {t('sidebar.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

// ─── Rename Input ────────────────────────────────────────────

function RenameInput({
  value,
  onChange,
  onSubmit,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    // Select filename without extension
    const dot = value.lastIndexOf('.');
    ref.current?.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, []);

  return (
    <input
      ref={ref}
      className="flex-1 min-w-0 bg-background text-foreground text-[13px] px-1 py-0 rounded border border-theme-accent outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onSubmit}
      onKeyDown={onKeyDown}
    />
  );
}

// ─── Inline Create Input ─────────────────────────────────────
// 内联创建笔记/文件夹输入框，替代 Tauri 不支持的 window.prompt()

function InlineCreateInput({
  type,
  onSubmit,
  onCancel,
  depth = 0,
}: {
  type: 'note' | 'folder';
  onSubmit: (name: string) => void;
  onCancel: () => void;
  depth?: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    // 延迟 focus 确保 DOM 更新完成
    requestAnimationFrame(() => ref.current?.focus());
  }, []);

  const handleSubmit = useCallback(() => {
    onSubmit(value);
  }, [value, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel]
  );

  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="shrink-0 text-muted-foreground">
        {type === 'folder' ? <Folder size={14} /> : <File size={14} />}
      </span>
      <input
        ref={ref}
        className="flex-1 min-w-0 bg-background text-foreground text-[13px] px-1 py-0.5 rounded border border-theme-accent outline-none"
        value={value}
        placeholder={type === 'note' ? t('sidebar.newNote') : t('sidebar.newFolder')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSubmit}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}

// ─── Toolbar Button ──────────────────────────────────────────

function ToolbarButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className="p-1 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshTree() {
  // Debounce rapid successive calls (e.g. create → rename → delete)
  if (refreshTimer) clearTimeout(refreshTimer);
  return new Promise<void>((resolve) => {
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      useWorkspaceStore.getState().setTreeLoading(true);
      try {
        const sortMode = useSettingsStore.getState().sortMode;
        const tree = await listTree('', sortMode);
        useWorkspaceStore.getState().setTree(tree);
      } catch (err) {
        console.error('Failed to refresh tree:', err);
      } finally {
        useWorkspaceStore.getState().setTreeLoading(false);
      }
      resolve();
    }, 150);
  });
}

// handleCreateNote / handleCreateFolder 已移入 VaultTree 组件内部，
// 使用内联输入替代 window.prompt()（Tauri WebView 不支持 prompt）

async function handleRefresh() {
  await refreshTree();
}

// ── 每日笔记 ─────────────────────────────────────────────────
// 创建或打开格式为 YYYY-MM-DD.md 的每日笔记，
// 存放在 vault 根目录下的 daily/ 文件夹中

async function handleCreateDailyNote() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const fileName = `${dateStr}.md`;
  const dailyPath = `daily/${fileName}`;

  // 尝试直接打开（如果今日笔记已存在）
  try {
    const results = await searchByFilename(dateStr);
    const existing = results.find((r) => r.path === dailyPath || r.path === fileName);
    if (existing) {
      useNoteStore.getState().openNote(existing.path, dateStr);
      return;
    }
  } catch {
    // 搜索失败，继续创建
  }

  // 确保 daily 文件夹存在，然后创建笔记
  try {
    await createFolder('', 'daily').catch(() => {
      // 文件夹可能已存在，忽略错误
    });
    const path = await createNote('daily', fileName);
    await refreshTree();
    useNoteStore.getState().openNote(path, dateStr);
  } catch (err) {
    toast({ title: i18n.t('dailyNote.failed'), description: String(err), variant: 'error' });
  }
}
