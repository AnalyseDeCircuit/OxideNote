/**
 * CommandRegistry — centralized command definitions for the command palette.
 *
 * Each command has an id, localized label, optional keyboard shortcut hint,
 * a category for grouping, and an action callback.
 */

import { useUIStore } from '@/store/uiStore';
import { useNoteStore, flushPendingSave, flushAllPendingSaves } from '@/store/noteStore';
import { getRandomNote, exportNoteBundle, bulkImportNotes, encryptNote, decryptNoteToDisk } from '@/lib/api';
import { publishSite } from '@/lib/publishSite';
import { save, open } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { toast } from '@/hooks/useToast';
import { promptPassword, promptPasswordWithConfirm } from '@/components/ui/PasswordDialog';
import i18n from '@/i18n';
import { getEditorView } from '@/lib/editorViewRef';
import { triggerAiTransform, triggerAiContinue } from '@/components/editor/extensions/aiInline';
import { useChatStore } from '@/store/chatStore';

export interface AppCommand {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

/**
 * Build the full list of palette commands.
 * @param t — i18n translate function
 */
export function buildCommands(t: (key: string) => string): AppCommand[] {
  const layout = t('commandPalette.layout');
  const nav = t('commandPalette.navigation');
  const edit = t('commandPalette.editing');
  const panel = t('commandPalette.panels');
  const ai = 'AI';

  return [
    // ── Layout ──────────────────────────────────────────────
    {
      id: 'toggle-sidebar',
      label: t('actions.toggleSidebar'),
      shortcut: '⌘B',
      category: layout,
      action: () => useUIStore.getState().toggleSidebar(),
    },
    {
      id: 'toggle-side-panel',
      label: t('actions.toggleSidePanel'),
      shortcut: '⌘\\',
      category: layout,
      action: () => useUIStore.getState().toggleSidePanel(),
    },

    // ── Navigation ──────────────────────────────────────────
    {
      id: 'quick-open',
      label: t('search.quickOpen'),
      shortcut: '⌘P',
      category: nav,
      action: () => useUIStore.getState().setQuickOpenOpen(true),
    },
    {
      id: 'global-search',
      label: t('search.globalSearch'),
      shortcut: '⌘⇧F',
      category: nav,
      action: () => useUIStore.getState().setGlobalSearchOpen(true),
    },
    {
      id: 'settings',
      label: t('settings.title'),
      shortcut: '⌘,',
      category: nav,
      action: () => useUIStore.getState().setSettingsOpen(true),
    },
    {
      id: 'vault-health',
      label: t('settings.vaultHealth'),
      category: nav,
      action: () => useUIStore.getState().setHealthOpen(true),
    },
    {
      id: 'daily-note',
      label: t('dailyNote.tooltip'),
      category: nav,
      action: () => {
        // Dispatch the daily note shortcut action via a synthetic keyboard event
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, shiftKey: true }));
      },
    },
    {
      id: 'random-note',
      label: t('commandPalette.randomNote'),
      category: nav,
      action: () => {
        getRandomNote().then((result) => {
          if (result) {
            useNoteStore.getState().openNote(result.path, result.title);
          }
        });
      },
    },

    // ── Editing ─────────────────────────────────────────────
    {
      id: 'close-tab',
      label: t('actions.closeTab'),
      shortcut: '⌘W',
      category: edit,
      action: () => {
        const active = useNoteStore.getState().activeTabPath;
        if (active) {
          flushPendingSave(active).then((outcome) => {
            if (outcome === 'saved' || outcome === 'noop') {
              useNoteStore.getState().closeTab(active);
            }
          });
        }
      },
    },
    {
      id: 'mode-edit',
      label: t('editor.edit'),
      category: edit,
      action: () => useUIStore.getState().setEditorMode('edit'),
    },
    {
      id: 'mode-preview',
      label: t('editor.preview'),
      category: edit,
      action: () => useUIStore.getState().setEditorMode('preview'),
    },
    {
      id: 'mode-split',
      label: t('editor.split'),
      category: edit,
      action: () => useUIStore.getState().setEditorMode('split'),
    },

    // ── Panels ──────────────────────────────────────────────
    {
      id: 'toggle-chat',
      label: t('actions.toggleChat'),
      shortcut: '⌘L',
      category: panel,
      action: () => {
        const { sidePanelVisible, sidePanelTab, toggleSidePanel, setSidePanelTab } = useUIStore.getState();
        if (sidePanelVisible && sidePanelTab === 'chat') {
          toggleSidePanel();
        } else {
          if (!sidePanelVisible) toggleSidePanel();
          setSidePanelTab('chat');
        }
      },
    },
    {
      id: 'knowledge-graph',
      label: t('actions.knowledgeGraph'),
      category: panel,
      action: () => useUIStore.getState().setGraphViewOpen(true),
    },
    {
      id: 'flashcard',
      label: t('flashcard.title'),
      category: panel,
      action: () => useUIStore.getState().setFlashcardOpen(true),
    },
    {
      id: 'video-panel',
      label: t('video.title'),
      category: panel,
      action: () => useUIStore.getState().setVideoPanelOpen(true),
    },
    {
      id: 'browser-panel',
      label: t('browser.title'),
      category: panel,
      action: () => useUIStore.getState().setBrowserPanelOpen(true),
    },
    {
      id: 'focus-mode',
      label: t('commandPalette.focusMode'),
      category: layout,
      action: () => useUIStore.getState().toggleFocusMode(),
    },
    {
      id: 'export-bundle',
      label: t('export.bundleExport'),
      category: edit,
      action: () => {
        const activeTab = useNoteStore.getState().activeTabPath;
        if (!activeTab) return;
        const title = activeTab.replace(/\.md$/, '').split('/').pop() || 'export';
        save({
          title: t('export.bundleExport'),
          defaultPath: `${title}.zip`,
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        }).then((savePath) => {
          if (savePath) {
            exportNoteBundle(activeTab, savePath).catch((e) =>
              toast({ title: String(e), variant: 'error' })
            );
          }
        });
      },
    },
    {
      id: 'bulk-import',
      label: t('import.bulkImport'),
      category: nav,
      action: () => {
        open({
          title: t('import.bulkImport'),
          multiple: true,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        }).then((selected) => {
          if (selected && selected.length > 0) {
            bulkImportNotes(selected as string[], '').catch((e) =>
              toast({ title: String(e), variant: 'error' })
            );
          }
        });
      },
    },
    {
      id: 'switch-vault',
      label: t('commandPalette.switchVault'),
      category: nav,
      action: () => {
        // Flush all pending saves, then return to WelcomeScreen
        flushAllPendingSaves().then(() => {
          useNoteStore.getState().closeAllTabs();
          useWorkspaceStore.getState().setVaultPath(null);
          useWorkspaceStore.getState().setTree([]);
        });
      },
    },
    {
      id: 'encrypt-note',
      label: t('crypto.encrypt'),
      category: edit,
      action: async () => {
        const activeTab = useNoteStore.getState().activeTabPath;
        if (!activeTab) return;
        const password = await promptPasswordWithConfirm(t('crypto.encrypt'));
        if (!password) return;
        await flushPendingSave(activeTab);
        encryptNote(activeTab, password).catch((e) =>
          toast({ title: String(e), variant: 'error' })
        );
      },
    },
    {
      id: 'decrypt-note',
      label: t('crypto.decrypt'),
      category: edit,
      action: async () => {
        const activeTab = useNoteStore.getState().activeTabPath;
        if (!activeTab) return;
        const password = await promptPassword(t('crypto.decrypt'));
        if (!password) return;
        decryptNoteToDisk(activeTab, password).catch((e) =>
          toast({ title: String(e), variant: 'error' })
        );
      },
    },
    {
      id: 'publish-site',
      label: t('publish.title'),
      category: edit,
      action: async () => {
        const tree = useWorkspaceStore.getState().tree;
        if (tree.length === 0) return;
        try {
          const count = await publishSite(tree);
          if (count > 0) {
            toast({ title: i18n.t('publish.success', { count }) });
          }
        } catch (e) {
          toast({ title: t('publish.failed'), description: String(e), variant: 'error' });
        }
      },
    },

    // ── AI ──────────────────────────────────────────────────
    {
      id: 'ai-rewrite',
      label: t('inlineAi.rewrite'),
      shortcut: '⌘I',
      category: ai,
      action: () => {
        const view = getEditorView();
        if (!view) return;
        const config = useChatStore.getState().config;
        const title = useNoteStore.getState().activeTabPath?.replace(/\.md$/, '').split('/').pop() || '';
        triggerAiTransform(view, 'Rewrite this text to be clearer and more concise', config, title)
          .catch((err) => toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' }));
      },
    },
    {
      id: 'ai-continue',
      label: t('inlineAi.continue'),
      category: ai,
      action: () => {
        const view = getEditorView();
        if (!view) return;
        const config = useChatStore.getState().config;
        const title = useNoteStore.getState().activeTabPath?.replace(/\.md$/, '').split('/').pop() || '';
        triggerAiContinue(view, config, title)
          .catch((err) => toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' }));
      },
    },
    {
      id: 'ai-summarize',
      label: t('inlineAi.summarize'),
      category: ai,
      action: () => {
        const view = getEditorView();
        if (!view) return;
        const config = useChatStore.getState().config;
        const title = useNoteStore.getState().activeTabPath?.replace(/\.md$/, '').split('/').pop() || '';
        triggerAiTransform(view, 'Summarize this text into bullet points', config, title)
          .catch((err) => toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' }));
      },
    },
    {
      id: 'ai-translate',
      label: t('inlineAi.translate'),
      category: ai,
      action: () => {
        const view = getEditorView();
        if (!view) return;
        const config = useChatStore.getState().config;
        const title = useNoteStore.getState().activeTabPath?.replace(/\.md$/, '').split('/').pop() || '';
        triggerAiTransform(view, 'Translate this text to the other language (Chinese↔English)', config, title)
          .catch((err) => toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' }));
      },
    },
  ];
}
