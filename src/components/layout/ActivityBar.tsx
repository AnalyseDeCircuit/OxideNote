/**
 * ActivityBar — VS Code-style vertical icon strip on the far left.
 *
 * Renders a fixed-width column (48px) with section icons on top and
 * utility actions (settings) at the bottom. Clicking an icon either
 * expands the sidebar to that section or collapses it if already active.
 *
 * Pattern adapted from OxideTerm's SidebarButtonDef approach —
 * data-driven button arrays for easy extension.
 */

import { useTranslation } from 'react-i18next';
import {
  FolderOpen, Search, Link2, Sparkles, Bot,
  LayoutDashboard, Settings,
} from 'lucide-react';
import { useUIStore, type SidebarSection } from '@/store/uiStore';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// ── Button definition type ──────────────────────────────────

interface ActivityBarButton {
  /** Sidebar section this button activates (null for standalone actions) */
  section: SidebarSection | null;
  icon: React.ReactNode;
  labelKey: string;
  /** Keyboard shortcut hint shown in tooltip */
  shortcut?: string;
  /** Standalone action (used when section is null) */
  action?: () => void;
}

// ── Top buttons — primary sidebar sections ──────────────────

const TOP_BUTTONS: ActivityBarButton[] = [
  { section: 'explorer',   icon: <FolderOpen size={20} />,       labelKey: 'sidebar.explorer' },
  { section: 'search',     icon: <Search size={20} />,           labelKey: 'sidebar.search',     shortcut: '⌘⇧F' },
  { section: 'backlinks',  icon: <Link2 size={20} />,            labelKey: 'sidebar.backlinks' },
  { section: 'chat',       icon: <Sparkles size={20} />,         labelKey: 'sidebar.chat',       shortcut: '⌘L' },
  { section: 'agent',      icon: <Bot size={20} />,              labelKey: 'sidebar.agent' },
  { section: 'dashboard',  icon: <LayoutDashboard size={20} />,  labelKey: 'sidebar.dashboard' },
];

// ── Bottom buttons — utility actions ────────────────────────

const BOTTOM_BUTTONS: ActivityBarButton[] = [
  {
    section: null,
    icon: <Settings size={20} />,
    labelKey: 'actions.settings',
    shortcut: '⌘,',
    action: () => useUIStore.getState().setSettingsOpen(true),
  },
];

export function ActivityBar() {
  const { t } = useTranslation();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const activeSidebarSection = useUIStore((s) => s.activeSidebarSection);
  const setSidebarSection = useUIStore((s) => s.setSidebarSection);

  const handleClick = (btn: ActivityBarButton) => {
    if (btn.section) {
      setSidebarSection(btn.section);
    } else if (btn.action) {
      btn.action();
    }
  };

  const isActive = (btn: ActivityBarButton) =>
    btn.section !== null && !sidebarCollapsed && activeSidebarSection === btn.section;

  return (
    <div className="w-12 h-full flex flex-col items-center bg-surface border-r border-theme-border shrink-0 select-none">
      {/* Top section icons */}
      <div className="flex flex-col items-center gap-0.5 pt-2 flex-1">
        {TOP_BUTTONS.map((btn) => (
          <Tooltip key={btn.labelKey}>
            <TooltipTrigger asChild>
              <button
                className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
                  isActive(btn)
                    ? 'text-theme-accent bg-theme-accent/15'
                    : 'text-muted-foreground hover:text-foreground hover:bg-theme-hover'
                }`}
                onClick={() => handleClick(btn)}
                aria-label={t(btn.labelKey)}
              >
                {btn.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" shortcut={btn.shortcut}>
              {t(btn.labelKey)}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Bottom utility icons */}
      <div className="flex flex-col items-center gap-0.5 pb-2">
        {BOTTOM_BUTTONS.map((btn) => (
          <Tooltip key={btn.labelKey}>
            <TooltipTrigger asChild>
              <button
                className="w-10 h-10 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-theme-hover transition-colors"
                onClick={() => handleClick(btn)}
                aria-label={t(btn.labelKey)}
              >
                {btn.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" shortcut={btn.shortcut}>
              {t(btn.labelKey)}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
