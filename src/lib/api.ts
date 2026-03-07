import { invoke } from '@tauri-apps/api/core';

// ─── Types ───────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: TreeNode[];
}

// ─── Vault commands ──────────────────────────────────────────

export async function openVault(path: string): Promise<string> {
  return invoke<string>('open_vault', { path });
}

export async function listTree(path: string = ''): Promise<TreeNode[]> {
  return invoke<TreeNode[]>('list_tree', { path });
}
