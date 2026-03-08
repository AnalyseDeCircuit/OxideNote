/**
 * CommandPalette — Cmd+K command palette overlay.
 *
 * Reuses the cmdk library (same as QuickOpen) to provide
 * fuzzy-searchable access to all application commands.
 * Commands are registered via commandRegistry.ts.
 */

import { useState, useMemo } from 'react';
import { Command } from 'cmdk';
import { useUIStore } from '@/store/uiStore';
import { useTranslation } from 'react-i18next';
import { buildCommands } from '@/lib/commandRegistry';

export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  // Build command list (re-computed when locale changes)
  const commands = useMemo(() => buildCommands(t), [t]);

  // Group commands by category
  const grouped = useMemo(() => {
    const map = new Map<string, typeof commands>();
    for (const cmd of commands) {
      const list = map.get(cmd.category) || [];
      list.push(cmd);
      map.set(cmd.category, list);
    }
    return map;
  }, [commands]);

  const handleSelect = (cmdId: string) => {
    const cmd = commands.find((c) => c.id === cmdId);
    if (cmd) {
      setOpen(false);
      // Run action after closing to avoid UI race
      requestAnimationFrame(() => cmd.action());
    }
  };

  // Reset query when opening
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[520px] rounded-lg border border-theme-border bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command className="flex flex-col">
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder={t('commandPalette.placeholder')}
            className="w-full px-4 py-3 text-sm bg-transparent text-foreground outline-none border-b border-theme-border placeholder:text-muted-foreground"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <Command.List className="max-h-[300px] overflow-y-auto p-1">
            <Command.Empty className="px-4 py-6 text-sm text-muted-foreground text-center">
              {t('search.noResults')}
            </Command.Empty>
            {[...grouped.entries()].map(([category, cmds]) => (
              <Command.Group key={category} heading={category} className="text-xs text-muted-foreground px-2 py-1.5">
                {cmds.map((cmd) => (
                  <Command.Item
                    key={cmd.id}
                    value={`${cmd.label} ${cmd.id}`}
                    onSelect={() => handleSelect(cmd.id)}
                    className="flex items-center justify-between px-3 py-2 text-sm rounded cursor-pointer text-foreground data-[selected=true]:bg-theme-hover"
                  >
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="text-xs text-muted-foreground bg-theme-bg-hover px-1.5 py-0.5 rounded">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
