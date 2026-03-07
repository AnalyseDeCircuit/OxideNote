import { useEffect } from 'react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { AppShell } from '@/components/layout/AppShell';
import { WelcomeScreen } from '@/components/layout/WelcomeScreen';
import { Toaster } from '@/components/ui/toaster';
import { openVault, listTree } from '@/lib/api';

function App() {
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);

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

  return (
    <>
      {vaultPath ? <AppShell /> : <WelcomeScreen />}
      <Toaster />
    </>
  );
}

export default App;
