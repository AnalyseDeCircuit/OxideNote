import { useEffect } from 'react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUIStore } from '@/store/uiStore';
import { useNoteStore } from '@/store/noteStore';
import { AppShell } from '@/components/layout/AppShell';
import { WelcomeScreen } from '@/components/layout/WelcomeScreen';
import { QuickOpen } from '@/components/search/QuickOpen';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { Toaster } from '@/components/ui/toaster';
import { openVault, listTree, createNote } from '@/lib/api';

function App() {
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);
  const globalSearchOpen = useUIStore((s) => s.globalSearchOpen);

  // Restore last vault on startup
  useEffect(() => {
    const lastVault = useSettingsStore.getState().lastVaultPath;
    if (lastVault && !vaultPath) {
      openVault(lastVault)
        .then(() => listTree())
        .then((tree) => {
          useWorkspaceStore.getState().setVaultPath(lastVault);
          useWorkspaceStore.getState().setTree(tree);
        })
        .catch(() => {
          // Vault doesn't exist anymore, clear it
          useSettingsStore.getState().setLastVaultPath(null);
        });
    }
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

      // Cmd+W → Close Current Tab
      if (mod && e.key === 'w' && !e.shiftKey) {
        e.preventDefault();
        const active = useNoteStore.getState().activeTabPath;
        if (active) useNoteStore.getState().closeTab(active);
      }

      // Cmd+N → New Note in vault root
      if (mod && e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        if (useWorkspaceStore.getState().vaultPath) {
          const name = `Untitled ${Date.now()}`;
          createNote('', name)
            .then(async (path) => {
              const tree = await listTree();
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
      {vaultPath ? <AppShell /> : <WelcomeScreen />}
      <QuickOpen />
      <GlobalSearch open={globalSearchOpen} onClose={() => useUIStore.getState().setGlobalSearchOpen(false)} />
      <SettingsDialog />
      <Toaster />
    </>
  );
}

export default App;
