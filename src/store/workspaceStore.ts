import { create } from 'zustand';
import type { TreeNode } from '@/lib/api';

interface WorkspaceState {
  vaultPath: string | null;
  tree: TreeNode[];
  treeLoading: boolean;

  setVaultPath: (path: string | null) => void;
  setTree: (tree: TreeNode[]) => void;
  setTreeLoading: (loading: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  vaultPath: null,
  tree: [],
  treeLoading: false,

  setVaultPath: (path) => set({ vaultPath: path }),
  setTree: (tree) => set({ tree }),
  setTreeLoading: (loading) => set({ treeLoading: loading }),
}));
