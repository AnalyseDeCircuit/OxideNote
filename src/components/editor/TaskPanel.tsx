/**
 * TaskPanel — aggregated task/todo list from vault notes.
 *
 * Scans all .md files for `- [ ]` and `- [x]` checkboxes and
 * displays them in list or kanban view. Supports inline metadata:
 *   · `@YYYY-MM-DD` for due dates
 *   · `!high`, `!medium`, `!low` for priority
 *
 * Clicking a task opens the note at the corresponding line.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { listTasks, type TaskItem } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import {
  CheckSquare,
  Square,
  RefreshCw,
  List,
  LayoutGrid,
  AlertCircle,
  Calendar,
  Circle,
  CheckCircle,
} from 'lucide-react';

interface Props {
  onClose: () => void;
}

type TaskView = 'list' | 'kanban';
type SortMode = 'file' | 'priority' | 'dueDate';

// Priority sort weight (lower = higher priority)
const PRIORITY_WEIGHT: Record<string, number> = { high: 0, medium: 1, low: 2 };

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dueDate < today;
}

export function TaskPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [view, setView] = useState<TaskView>('list');
  const [sortMode, setSortMode] = useState<SortMode>('file');

  const refresh = useCallback(() => {
    setLoading(true);
    listTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    let result = showDone ? tasks : tasks.filter((t) => !t.done);

    // Apply sorting
    if (sortMode === 'priority') {
      result = [...result].sort((a, b) => {
        const wa = PRIORITY_WEIGHT[a.priority || ''] ?? 3;
        const wb = PRIORITY_WEIGHT[b.priority || ''] ?? 3;
        return wa - wb;
      });
    } else if (sortMode === 'dueDate') {
      result = [...result].sort((a, b) => {
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      });
    }

    return result;
  }, [tasks, showDone, sortMode]);

  const pending = tasks.filter((t) => !t.done).length;
  const done = tasks.filter((t) => t.done).length;

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
          {/* View toggle */}
          <button
            onClick={() => setView('list')}
            className={`p-1 rounded ${view === 'list' ? 'bg-theme-accent/15 text-theme-accent' : 'text-muted-foreground hover:text-foreground'}`}
            title={t('tasks.listView')}
          >
            <List size={12} />
          </button>
          <button
            onClick={() => setView('kanban')}
            className={`p-1 rounded ${view === 'kanban' ? 'bg-theme-accent/15 text-theme-accent' : 'text-muted-foreground hover:text-foreground'}`}
            title={t('tasks.kanbanView')}
          >
            <LayoutGrid size={12} />
          </button>
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

      {/* Stats + controls bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-muted-foreground border-b border-theme-border flex-wrap">
        <span>{t('tasks.pending')}: {pending}</span>
        <span>{t('tasks.done')}: {done}</span>
        {/* Sort dropdown */}
        <select
          className="text-xs bg-transparent border border-theme-border rounded px-1 py-0.5 text-foreground ml-auto"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
        >
          <option value="file">{t('tasks.sortByFile')}</option>
          <option value="priority">{t('tasks.sortByPriority')}</option>
          <option value="dueDate">{t('tasks.sortByDueDate')}</option>
        </select>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
            className="accent-theme-accent"
          />
          <span>{t('tasks.showCompleted')}</span>
        </label>
      </div>

      {/* Task list or kanban */}
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

        {!loading && filtered.length > 0 && view === 'list' && (
          <TaskListView tasks={filtered} sortMode={sortMode} onTaskClick={handleTaskClick} />
        )}
        {!loading && filtered.length > 0 && view === 'kanban' && (
          <TaskKanbanView tasks={filtered} onTaskClick={handleTaskClick} />
        )}
      </div>
    </div>
  );
}

// ─── List View ──────────────────────────────────────────────

function TaskListView({
  tasks,
  sortMode,
  onTaskClick,
}: {
  tasks: TaskItem[];
  sortMode: SortMode;
  onTaskClick: (task: TaskItem) => void;
}) {
  // Group tasks by file for file-sort mode
  if (sortMode === 'file') {
    const grouped = new Map<string, TaskItem[]>();
    for (const task of tasks) {
      const list = grouped.get(task.path) || [];
      list.push(task);
      grouped.set(task.path, list);
    }

    return (
      <>
        {[...grouped.entries()].map(([path, items]) => (
          <div key={path} className="mb-3">
            <div className="text-xs font-medium text-muted-foreground truncate mb-1 px-1">
              {path}
            </div>
            {items.map((task) => (
              <TaskRow key={`${task.path}:${task.line}`} task={task} onClick={onTaskClick} />
            ))}
          </div>
        ))}
      </>
    );
  }

  // Flat list for priority/dueDate sort
  return (
    <>
      {tasks.map((task) => (
        <TaskRow key={`${task.path}:${task.line}`} task={task} onClick={onTaskClick} showPath />
      ))}
    </>
  );
}

// ─── Kanban View ────────────────────────────────────────────

function TaskKanbanView({
  tasks,
  onTaskClick,
}: {
  tasks: TaskItem[];
  onTaskClick: (task: TaskItem) => void;
}) {
  const { t } = useTranslation();

  // Group by status (todo/done) and priority
  const highTasks = tasks.filter((task) => task.priority === 'high' && !task.done);
  const mediumTasks = tasks.filter((task) => task.priority === 'medium' && !task.done);
  const lowTasks = tasks.filter((task) => task.priority === 'low' && !task.done);
  const noPriorityTasks = tasks.filter((task) => !task.priority && !task.done);
  const doneTasks = tasks.filter((task) => task.done);

  const lanes: { icon: React.ReactNode; label: string; tasks: TaskItem[]; color: string }[] = [
    { icon: <Circle size={10} className="fill-red-500 text-red-500" />, label: t('tasks.priorityHigh'), tasks: highTasks, color: 'border-red-500/30' },
    { icon: <Circle size={10} className="fill-yellow-500 text-yellow-500" />, label: t('tasks.priorityMedium'), tasks: mediumTasks, color: 'border-yellow-500/30' },
    { icon: <Circle size={10} className="fill-green-500 text-green-500" />, label: t('tasks.priorityLow'), tasks: lowTasks, color: 'border-green-500/30' },
    { icon: null, label: t('tasks.noPriority'), tasks: noPriorityTasks, color: 'border-theme-border' },
    { icon: <CheckCircle size={10} className="text-green-500" />, label: t('tasks.done'), tasks: doneTasks, color: 'border-theme-border' },
  ].filter((l) => l.tasks.length > 0);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2 min-h-[200px]">
      {lanes.map((lane) => (
        <div
          key={lane.label}
          className={`flex flex-col min-w-[200px] max-w-[260px] rounded-lg border ${lane.color} bg-surface`}
        >
          <div className="px-3 py-2 border-b border-theme-border flex items-center justify-between">
            <span className="text-xs font-medium text-foreground flex items-center gap-1.5">{lane.icon}{lane.label}</span>
            <span className="text-[10px] text-muted-foreground">{lane.tasks.length}</span>
          </div>
          <div className="flex-1 p-2 space-y-1.5 overflow-y-auto">
            {lane.tasks.map((task) => (
              <button
                key={`${task.path}:${task.line}`}
                className="w-full text-left p-2 rounded-md border border-theme-border bg-background hover:border-theme-accent/50 transition-colors"
                onClick={() => onTaskClick(task)}
              >
                <div className="flex items-start gap-1.5">
                  {task.done ? (
                    <CheckSquare size={12} className="shrink-0 mt-0.5 text-green-500" />
                  ) : (
                    <Square size={12} className="shrink-0 mt-0.5 text-muted-foreground" />
                  )}
                  <span className={`text-xs ${task.done ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                    {task.text}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  {task.due_date && (
                    <span className={`flex items-center gap-0.5 text-[10px] ${
                      isOverdue(task.due_date) ? 'text-red-400' : 'text-muted-foreground'
                    }`}>
                      <Calendar size={9} />
                      {task.due_date}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground truncate">
                    {task.path.split('/').pop()}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Shared Task Row ────────────────────────────────────────

function TaskRow({
  task,
  onClick,
  showPath,
}: {
  task: TaskItem;
  onClick: (task: TaskItem) => void;
  showPath?: boolean;
}) {
  return (
    <button
      className="flex items-start gap-2 w-full text-left px-2 py-1 rounded text-sm hover:bg-theme-hover transition-colors"
      onClick={() => onClick(task)}
    >
      {task.done ? (
        <CheckSquare size={14} className="shrink-0 mt-0.5 text-green-500" />
      ) : (
        <Square size={14} className="shrink-0 mt-0.5 text-muted-foreground" />
      )}
      <div className="flex-1 min-w-0">
        <span className={task.done ? 'line-through text-muted-foreground' : 'text-foreground'}>
          {task.text}
        </span>
        <div className="flex items-center gap-2 mt-0.5">
          {task.priority && (
            <PriorityBadge priority={task.priority} />
          )}
          {task.due_date && (
            <span className={`flex items-center gap-0.5 text-[10px] ${
              isOverdue(task.due_date) ? 'text-red-400' : 'text-muted-foreground'
            }`}>
              <Calendar size={9} />
              {task.due_date}
              {isOverdue(task.due_date) && <AlertCircle size={9} />}
            </span>
          )}
          {showPath && (
            <span className="text-[10px] text-muted-foreground truncate">
              {task.path}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Priority Badge ─────────────────────────────────────────

function PriorityBadge({ priority }: { priority: string }) {
  const colorClass =
    priority === 'high' ? 'bg-red-500/20 text-red-400' :
    priority === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
    'bg-green-500/20 text-green-400';

  return (
    <span className={`text-[10px] px-1.5 py-0 rounded-full ${colorClass}`}>
      !{priority}
    </span>
  );
}
