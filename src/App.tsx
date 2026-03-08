import { useEffect } from 'react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore, initTabSync, type ActionId } from '@/store/settingsStore';
import { useUIStore } from '@/store/uiStore';
import { useNoteStore, flushAllPendingSaves, flushPendingSave } from '@/store/noteStore';
import { AppShell } from '@/components/layout/AppShell';
import { WelcomeScreen } from '@/components/layout/WelcomeScreen';
import { QuickOpen } from '@/components/search/QuickOpen';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { CommandPalette } from '@/components/search/CommandPalette';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { VaultHealthDialog } from '@/components/settings/VaultHealthDialog';
import { Toaster } from '@/components/ui/toaster';
import { PasswordDialog } from '@/components/ui/PasswordDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { openVault, listTree, createNote, readNote } from '@/lib/api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { toast } from '@/hooks/useToast';
import i18n from '@/i18n';

// ── Keybinding matching engine ──────────────────────────────

/**
 * Parse a keybinding string like "Mod+Shift+F" and compare with an event.
 * "Mod" = Cmd on Mac, Ctrl on other platforms.
 */
function matchKeybinding(
  e: KeyboardEvent,
  bindings: Record<ActionId, string>,
): ActionId | null {
  for (const [action, combo] of Object.entries(bindings)) {
    if (keybindingMatches(e, combo)) {
      return action as ActionId;
    }
  }
  return null;
}

function keybindingMatches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+');
  let needMod = false;
  let needShift = false;
  let needAlt = false;
  let targetKey = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') needMod = true;
    else if (lower === 'shift') needShift = true;
    else if (lower === 'alt') needAlt = true;
    else targetKey = part;
  }

  const hasMod = e.metaKey || e.ctrlKey;
  if (needMod !== hasMod) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;

  // Compare key case-insensitively (for letter keys)
  return e.key.toLowerCase() === targetKey.toLowerCase()
    || e.key === targetKey; // For special keys like ArrowLeft, \\, etc.
}

function executeAction(action: ActionId) {
  switch (action) {
    case 'quickOpen':
      useUIStore.getState().setQuickOpenOpen(true);
      break;
    case 'commandPalette':
      useUIStore.getState().setCommandPaletteOpen(true);
      break;
    case 'globalSearch':
      useUIStore.getState().setGlobalSearchOpen(true);
      break;
    case 'settings':
      useUIStore.getState().setSettingsOpen(true);
      break;
    case 'toggleSidebar':
      useUIStore.getState().toggleSidebar();
      break;
    case 'toggleSidePanel':
      useUIStore.getState().toggleSidePanel();
      break;
    case 'closeTab': {
      const active = useNoteStore.getState().activeTabPath;
      if (active) {
        flushPendingSave(active).then((outcome) => {
          if (outcome === 'saved' || outcome === 'noop') {
            useNoteStore.getState().closeTab(active);
          }
        });
      }
      break;
    }
    case 'prevTab': {
      const { openTabs, activeTabPath } = useNoteStore.getState();
      if (openTabs.length > 1 && activeTabPath) {
        const idx = openTabs.findIndex((t) => t.path === activeTabPath);
        const prev = idx > 0 ? idx - 1 : openTabs.length - 1;
        useNoteStore.getState().setActiveTab(openTabs[prev].path);
      }
      break;
    }
    case 'nextTab': {
      const { openTabs, activeTabPath } = useNoteStore.getState();
      if (openTabs.length > 1 && activeTabPath) {
        const idx = openTabs.findIndex((t) => t.path === activeTabPath);
        const next = idx < openTabs.length - 1 ? idx + 1 : 0;
        useNoteStore.getState().setActiveTab(openTabs[next].path);
      }
      break;
    }
    case 'newNote': {
      if (useWorkspaceStore.getState().vaultPath) {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const name = `Untitled ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
        createNote('', name)
          .then(async (path) => {
            const tree = await listTree('', useSettingsStore.getState().sortMode);
            useWorkspaceStore.getState().setTree(tree);
            useNoteStore.getState().openNote(path, name);
          })
          .catch(() => {});
      }
      break;
    }
    case 'toggleFocusMode':
      useUIStore.getState().toggleFocusMode();
      break;
  }
}

function App() {
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);
  const globalSearchOpen = useUIStore((s) => s.globalSearchOpen);

  // Restore last vault on startup
  useEffect(() => {
    initTabSync();
    const lastVault = useSettingsStore.getState().lastVaultPath;
    if (lastVault && !vaultPath) {
      openVault(lastVault)
        .then(() => listTree('', useSettingsStore.getState().sortMode))
        .then((tree) => {
          useWorkspaceStore.getState().setVaultPath(lastVault);
          useWorkspaceStore.getState().setTree(tree);
          // Restore previously open tabs
          const { lastOpenTabs, lastActiveTabPath } = useSettingsStore.getState();
          if (lastOpenTabs.length > 0) {
            for (const tab of lastOpenTabs) {
              useNoteStore.getState().openNote(tab.path, tab.title);
            }
            if (lastActiveTabPath) {
              useNoteStore.getState().setActiveTab(lastActiveTabPath);
            }
            // 验证恢复的标签页对应的文件是否仍存在
            // 对读取失败的标签自动关闭并提示
            for (const tab of lastOpenTabs) {
              readNote(tab.path).catch(() => {
                useNoteStore.getState().closeTab(tab.path);
                toast({
                  title: i18n.t('tabs.fileNotFound', { name: tab.title }),
                  variant: 'warning',
                });
              });
            }
          }
        })
        .catch(() => {
          // Vault doesn't exist anymore, clear it
          useSettingsStore.getState().setLastVaultPath(null);
        });
    }
  }, []);

  // ── Exit confirmation: flush saves before closing ─────────
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      const noteState = useNoteStore.getState();
      const hasDirty = noteState.openTabs.some((t) => t.isDirty);
      if (hasDirty) {
        const ok = await confirm(i18n.t('actions.unsavedExit'), {
          title: 'OxideNote',
          kind: 'warning',
        });
        if (!ok) {
          event.preventDefault();
          return;
        }
      }
      const outcomes = await flushAllPendingSaves();
      const conflictPaths = Object.entries(outcomes)
        .filter(([, outcome]) => outcome === 'conflict')
        .map(([path]) => path);

      if (conflictPaths.length > 0 || Object.keys(useNoteStore.getState().conflicts).length > 0) {
        event.preventDefault();
        const firstConflictPath = conflictPaths[0] ?? Object.keys(useNoteStore.getState().conflicts)[0];
        if (firstConflictPath) {
          useNoteStore.getState().setActiveTab(firstConflictPath);
        }
        toast({
          title: i18n.t('conflict.resolveBeforeExitTitle'),
          description: i18n.t('conflict.resolveBeforeExitMessage'),
          variant: 'warning',
        });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Global keyboard shortcuts — driven by user-configurable keybindings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const bindings = useSettingsStore.getState().keybindings;
      const matched = matchKeybinding(e, bindings);
      if (!matched) return;

      e.preventDefault();
      executeAction(matched);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <>
      {vaultPath ? (
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
      ) : (
        <WelcomeScreen />
      )}
      <QuickOpen />
      <CommandPalette />
      <GlobalSearch open={globalSearchOpen} onClose={() => useUIStore.getState().setGlobalSearchOpen(false)} />
      <SettingsDialog />
      <VaultHealthDialog />
      <PasswordDialog />
      <Toaster />
    </>
  );
}

export default App;
