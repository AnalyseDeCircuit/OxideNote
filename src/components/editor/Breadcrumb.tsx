import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder } from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';

// ── Breadcrumb path navigation ──────────────────────────────
// Displays the current note's path as clickable segments.
// Clicking a folder segment opens the tree to that folder.

interface BreadcrumbProps {
  path: string;
}

export function Breadcrumb({ path }: BreadcrumbProps) {
  const { t } = useTranslation();
  const openNote = useNoteStore((s) => s.openNote);

  if (!path) return null;

  const segments = path.split('/');
  // Last segment is the file name, rest are folders
  const folders = segments.slice(0, -1);
  const fileName = segments[segments.length - 1]?.replace(/\.(md|typ|tex)$/, '') ?? '';

  return (
    <nav className="flex items-center gap-0.5 text-xs text-muted-foreground overflow-x-auto whitespace-nowrap scrollbar-hide">
      {/* Root */}
      <button
        className="hover:text-foreground transition-colors shrink-0 flex items-center gap-0.5"
        title={t('breadcrumb.root')}
        onClick={() => {
          // Focus on root in file tree — no specific action needed
        }}
      >
        <Folder className="w-3 h-3" />
      </button>

      {/* Folder segments */}
      {folders.map((folder, i) => (
        <span key={i} className="flex items-center gap-0.5 shrink-0">
          <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
          <span className="hover:text-foreground transition-colors">
            {folder}
          </span>
        </span>
      ))}

      {/* File name segment */}
      <span className="flex items-center gap-0.5 shrink-0">
        <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
        <span className="text-foreground font-medium">{fileName}</span>
      </span>
    </nav>
  );
}
