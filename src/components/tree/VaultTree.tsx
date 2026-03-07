import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Plus,
  FolderPlus,
  RefreshCw,
} from 'lucide-react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useNoteStore } from '@/store/noteStore';
import {
  listTree,
  createNote,
  createFolder,
  renameEntry,
  deleteEntry,
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

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('sidebar.files')}
        </span>
        <div className="flex items-center gap-0.5">
          <ToolbarButton icon={<Plus size={14} />} title={t('sidebar.newNote')} onClick={() => handleCreateNote('')} />
          <ToolbarButton icon={<FolderPlus size={14} />} title={t('sidebar.newFolder')} onClick={() => handleCreateFolder('')} />
          <ToolbarButton icon={<RefreshCw size={14} />} title={t('sidebar.refresh')} onClick={handleRefresh} />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {treeLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            Loading...
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

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
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

  const handleRenameSubmit = useCallback(async () => {
    if (renameValue && renameValue !== node.name) {
      try {
        const newPath = await renameEntry(node.path, renameValue);
        // If it was an open tab, update its path
        const title = renameValue.replace(/\.md$/, '');
        useNoteStore.getState().updateTabPath(node.path, newPath, title);
        await refreshTree();
      } catch (err) {
        toast({ title: 'Rename failed', description: String(err), variant: 'error' });
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
      ? `Delete folder "${node.name}" and all its contents?`
      : `Delete "${node.name}"?`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await deleteEntry(node.path);
      // Close tab if it was open
      useNoteStore.getState().closeTab(node.path);
      await refreshTree();
    } catch (err) {
      toast({ title: 'Delete failed', description: String(err), variant: 'error' });
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
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={handleClick}
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
                {node.is_dir ? node.name : node.name.replace(/\.md$/, '')}
              </span>
            )}
          </div>

          {/* Children */}
          {node.is_dir && expanded && node.children && (
            <div>
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
            <ContextMenuItem onClick={() => handleCreateNote(node.path)}>
              <Plus size={14} className="mr-2" />
              {t('sidebar.newNote')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleCreateFolder(node.path)}>
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
}

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
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

async function refreshTree() {
  useWorkspaceStore.getState().setTreeLoading(true);
  try {
    const tree = await listTree();
    useWorkspaceStore.getState().setTree(tree);
  } catch (err) {
    console.error('Failed to refresh tree:', err);
  } finally {
    useWorkspaceStore.getState().setTreeLoading(false);
  }
}

async function handleCreateNote(parentPath: string) {
  const name = prompt('Note name:');
  if (!name) return;
  try {
    const path = await createNote(parentPath, name);
    await refreshTree();
    const title = name.replace(/\.md$/, '');
    useNoteStore.getState().openNote(path, title);
  } catch (err) {
    toast({ title: 'Create note failed', description: String(err), variant: 'error' });
  }
}

async function handleCreateFolder(parentPath: string) {
  const name = prompt('Folder name:');
  if (!name) return;
  try {
    await createFolder(parentPath, name);
    await refreshTree();
  } catch (err) {
    toast({ title: 'Create folder failed', description: String(err), variant: 'error' });
  }
}

async function handleRefresh() {
  await refreshTree();
}
