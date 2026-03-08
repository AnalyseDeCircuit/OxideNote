import { useEffect } from 'react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore, initTabSync } from '@/store/settingsStore';
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

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+P → Quick Open
      if (mod && e.key === 'p' && !e.shiftKey) {
        e.preventDefault();
        useUIStore.getState().setQuickOpenOpen(true);
      }

      // Cmd+K → Command Palette
      if (mod && e.key === 'k' && !e.shiftKey) {
        e.preventDefault();
        useUIStore.getState().setCommandPaletteOpen(true);
      }

      // Cmd+Shift+F → Global Search
      if (mod && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        useUIStore.getState().setGlobalSearchOpen(true);
      }

      // Cmd+, → Settings
      if (mod && e.key === ',') {
        e.preventDefault();
        useUIStore.getState().setSettingsOpen(true);
      }

      // Cmd+B → Toggle Sidebar
      if (mod && e.key === 'b' && !e.shiftKey) {
        e.preventDefault();
        useUIStore.getState().toggleSidebar();
      }

      // Cmd+\ → Toggle Side Panel
      if (mod && e.key === '\\') {
        e.preventDefault();
        useUIStore.getState().toggleSidePanel();
      }

      // Cmd+W → Close Current Tab (flush first)
      if (mod && e.key === 'w' && !e.shiftKey) {
        e.preventDefault();
        const active = useNoteStore.getState().activeTabPath;
        if (active) {
          flushPendingSave(active).then((outcome) => {
            if (outcome === 'saved' || outcome === 'noop') {
              useNoteStore.getState().closeTab(active);
            }
          });
        }
      }

      // Cmd+Option+Left → Previous Tab
      if (mod && e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        const { openTabs, activeTabPath } = useNoteStore.getState();
        if (openTabs.length > 1 && activeTabPath) {
          const idx = openTabs.findIndex((t) => t.path === activeTabPath);
          const prev = idx > 0 ? idx - 1 : openTabs.length - 1;
          useNoteStore.getState().setActiveTab(openTabs[prev].path);
        }
      }

      // Cmd+Option+Right → Next Tab
      if (mod && e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        const { openTabs, activeTabPath } = useNoteStore.getState();
        if (openTabs.length > 1 && activeTabPath) {
          const idx = openTabs.findIndex((t) => t.path === activeTabPath);
          const next = idx < openTabs.length - 1 ? idx + 1 : 0;
          useNoteStore.getState().setActiveTab(openTabs[next].path);
        }
      }

      // Cmd+N → New Note in vault root
      if (mod && e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
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
      }
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
