/**
 * TaskPanel — aggregated task/todo list from vault notes.
 *
 * Scans all .md files for `- [ ]` and `- [x]` checkboxes and
 * displays them grouped by source file. Clicking a task opens
 * the note at the corresponding line.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { listTasks, type TaskItem } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { CheckSquare, Square, RefreshCw } from 'lucide-react';

interface Props {
  onClose: () => void;
}

export function TaskPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = showDone ? tasks : tasks.filter((t) => !t.done);
  const pending = tasks.filter((t) => !t.done).length;
  const done = tasks.filter((t) => t.done).length;

  // Group tasks by file
  const grouped = new Map<string, TaskItem[]>();
  for (const task of filtered) {
    const list = grouped.get(task.path) || [];
    list.push(task);
    grouped.set(task.path, list);
  }

  const handleTaskClick = (task: TaskItem) => {
    const title = task.path.replace(/\.md$/i, '').split('/').pop() || task.path;
    useNoteStore.getState().openNote(task.path, title);
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-theme-border shrink-0">
        <span className="text-sm font-medium text-foreground">{t('tasks.title')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            className="p-1 rounded hover:bg-theme-hover text-muted-foreground"
            title={t('sidebar.refresh')}
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-theme-hover text-muted-foreground"
          >
            ×
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-muted-foreground border-b border-theme-border">
        <span>{t('tasks.pending')}: {pending}</span>
        <span>{t('tasks.done')}: {done}</span>
        <label className="flex items-center gap-1 ml-auto cursor-pointer">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
            className="accent-theme-accent"
          />
          <span>{t('tasks.showCompleted')}</span>
        </label>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="text-center text-sm text-muted-foreground py-4">
            {t('backlinks.loading')}
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-4">
            {t('tasks.empty')}
          </div>
        )}
        {[...grouped.entries()].map(([path, items]) => (
          <div key={path} className="mb-3">
            <div className="text-xs font-medium text-muted-foreground truncate mb-1 px-1">
              {path}
            </div>
            {items.map((task) => (
              <button
                key={`${task.path}:${task.line}`}
                className="flex items-start gap-2 w-full text-left px-2 py-1 rounded text-sm hover:bg-theme-hover transition-colors"
                onClick={() => handleTaskClick(task)}
              >
                {task.done ? (
                  <CheckSquare size={14} className="shrink-0 mt-0.5 text-green-500" />
                ) : (
                  <Square size={14} className="shrink-0 mt-0.5 text-muted-foreground" />
                )}
                <span className={task.done ? 'line-through text-muted-foreground' : 'text-foreground'}>
                  {task.text}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
