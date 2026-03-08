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
      <div className="flex flex-col items-center gap-10 max-w-md w-full px-6">
        {/* Branding area with icon */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-theme-accent/15 flex items-center justify-center mb-1">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-theme-accent">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              <path d="M10 13l-2 2 2 2" />
              <path d="M14 13l2 2-2 2" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{t('app.name')}</h1>
          <p className="text-sm text-muted-foreground text-center leading-relaxed max-w-xs">
            {t('welcome.description')}
          </p>
        </div>

        {/* Open Vault CTA */}
        <button
          onClick={handleOpenVault}
          className="flex items-center justify-center gap-2.5 w-full max-w-xs px-6 py-3.5 rounded-xl bg-theme-accent text-white font-medium text-sm shadow-lg shadow-theme-accent/20 hover:shadow-xl hover:shadow-theme-accent/30 hover:brightness-110 transition-all active:scale-[0.98]"
        >
          <FolderOpen size={18} />
          {t('welcome.openVault')}
        </button>

        {/* Recent Vaults */}
        {recentVaults.length > 0 && (
          <div className="w-full max-w-xs">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">
              {t('welcome.recentVaults')}
            </h3>
            <div className="flex flex-col gap-1.5">
              {recentVaults.map((vault) => {
                const name = vault.split('/').filter(Boolean).pop() || vault;
                return (
                  <button
                    key={vault}
                    onClick={() => handleSelectVault(vault)}
                    className="group flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm text-foreground bg-surface border border-theme-border hover:border-theme-accent/40 hover:bg-theme-hover transition-all text-left"
                  >
                    <div className="w-8 h-8 rounded-lg bg-theme-accent/10 flex items-center justify-center shrink-0 group-hover:bg-theme-accent/20 transition-colors">
                      <FolderOpen size={14} className="text-theme-accent" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{name}</div>
                      <div className="text-xs text-muted-foreground truncate">{vault}</div>
                    </div>
                  </button>
                );
              })}
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
