import { useMemo } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';

export function StatusBar() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const activeContent = useNoteStore((s) => s.activeContent);
  const cursorLine = useNoteStore((s) => s.cursorLine);
  const cursorCol = useNoteStore((s) => s.cursorCol);
  const openTabs = useNoteStore((s) => s.openTabs);

  const activeTab = openTabs.find((tab) => tab.path === activeTabPath);
  const isDirty = activeTab?.isDirty ?? false;

  const wordCount = useMemo(() => {
    if (!activeContent) return 0;
    // Count CJK characters individually and split Latin words by whitespace
    const cjk = activeContent.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
    const latin = activeContent
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return (cjk?.length ?? 0) + latin.length;
  }, [activeContent]);

  if (!activeTabPath) return null;

  return (
    <div className="h-7 flex items-center px-4 gap-4 border-t border-theme-border bg-surface text-[11px] text-muted-foreground select-none shrink-0">
      <span>
        Ln {cursorLine}, Col {cursorCol}
      </span>
      <span>
        {wordCount} {t('statusBar.words')}
      </span>
      <div className="flex-1" />
      <span>{isDirty ? t('statusBar.unsaved') : t('statusBar.saved')}</span>
    </div>
  );
}
