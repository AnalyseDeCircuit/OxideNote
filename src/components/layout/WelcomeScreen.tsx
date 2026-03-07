import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { openVault, listTree } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useSettingsStore } from '@/store/settingsStore';
import { FolderOpen } from 'lucide-react';
import { toast } from '@/hooks/useToast';
import i18n from '@/i18n';

export function WelcomeScreen() {
  const { t } = useTranslation();
  const recentVaults = useSettingsStore((s) => s.recentVaults);

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-8 max-w-md">
        {/* Branding */}
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-2">{t('app.name')}</h1>
          <p className="text-muted-foreground">{t('app.subtitle')}</p>
        </div>

        {/* Description */}
        <p className="text-sm text-muted-foreground text-center leading-relaxed">
          {t('welcome.description')}
        </p>

        {/* Open Vault button */}
        <button
          onClick={handleOpenVault}
          className="flex items-center gap-2 px-6 py-3 rounded-lg bg-theme-accent text-white font-medium hover:opacity-90 transition-opacity"
        >
          <FolderOpen size={18} />
          {t('welcome.openVault')}
        </button>

        {/* Recent Vaults */}
        {recentVaults.length > 0 && (
          <div className="w-full">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              {t('welcome.recentVaults')}
            </h3>
            <div className="flex flex-col gap-1">
              {recentVaults.map((vault) => (
                <button
                  key={vault}
                  onClick={() => handleSelectVault(vault)}
                  className="text-left px-3 py-2 rounded text-sm text-foreground hover:bg-theme-hover transition-colors truncate"
                >
                  {vault}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

async function handleOpenVault() {
  const selected = await open({ directory: true, multiple: false });
  if (selected) {
    await handleSelectVault(selected);
  }
}

async function handleSelectVault(path: string) {
  try {
    await openVault(path);
    const tree = await listTree('', useSettingsStore.getState().sortMode);
    useWorkspaceStore.getState().setVaultPath(path);
    useWorkspaceStore.getState().setTree(tree);
    useSettingsStore.getState().setLastVaultPath(path);
    useSettingsStore.getState().addRecentVault(path);
  } catch (err) {
    toast({ title: i18n.t('actions.openVaultFailed'), description: String(err), variant: 'error' });
  }
}
