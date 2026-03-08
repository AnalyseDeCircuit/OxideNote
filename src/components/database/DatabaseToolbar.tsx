/**
 * DatabaseToolbar — View switching and control bar for database notes
 *
 * Provides:
 *   · View mode switch (table / kanban / calendar)
 *   · Add row / column buttons
 *   · Sort / filter controls
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewType, Column, ColumnType, DatabaseSchema } from '@/lib/database';
import { generateId, addColumn } from '@/lib/database';

interface DatabaseToolbarProps {
  view: ViewType;
  onViewChange: (view: ViewType) => void;
  onAddRow: () => void;
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function DatabaseToolbar({ view, onViewChange, onAddRow, schema, onSchemaChange }: DatabaseToolbarProps) {
  const { t } = useTranslation();
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState<ColumnType>('text');

  const views: { key: ViewType; label: string }[] = [
    { key: 'table', label: t('database.tableView') },
    { key: 'kanban', label: t('database.kanbanView') },
    { key: 'calendar', label: t('database.calendarView') },
  ];

  // Handle adding a new column
  const handleAddColumn = () => {
    if (!newColName.trim()) return;
    const col: Column = {
      id: generateId(),
      name: newColName.trim(),
      type: newColType,
      ...(newColType === 'select' || newColType === 'multi-select' ? { options: [] } : {}),
    };
    onSchemaChange(addColumn(schema, col));
    setNewColName('');
    setNewColType('text');
    setShowAddColumn(false);
  };

  const columnTypes: { value: ColumnType; label: string }[] = [
    { value: 'text', label: t('database.text') },
    { value: 'number', label: t('database.number') },
    { value: 'select', label: t('database.select') },
    { value: 'multi-select', label: t('database.multiSelect') },
    { value: 'date', label: t('database.date') },
    { value: 'checkbox', label: t('database.checkbox') },
    { value: 'url', label: t('database.url') },
  ];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-theme-border bg-surface text-sm">
      {/* View mode switch */}
      <div className="flex items-center bg-background rounded border border-theme-border overflow-hidden">
        {views.map(({ key, label }) => (
          <button
            key={key}
            className={`px-2.5 py-0.5 text-xs font-medium transition-colors ${
              view === key
                ? 'bg-theme-accent text-white'
                : 'text-muted-foreground hover:text-foreground hover:bg-theme-hover'
            }`}
            onClick={() => onViewChange(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* Add row */}
      <button
        onClick={onAddRow}
        className="px-2 py-0.5 text-xs rounded hover:bg-theme-hover transition-colors text-muted-foreground border border-theme-border"
      >
        + {t('database.addRow')}
      </button>

      {/* Add column */}
      <div className="relative">
        <button
          onClick={() => setShowAddColumn(!showAddColumn)}
          className="px-2 py-0.5 text-xs rounded hover:bg-theme-hover transition-colors text-muted-foreground border border-theme-border"
        >
          + {t('database.addColumn')}
        </button>

        {showAddColumn && (
          <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-theme-border rounded-lg shadow-lg p-3 min-w-[200px]">
            <div className="space-y-2">
              <input
                type="text"
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                placeholder={t('database.columnName')}
                className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddColumn();
                  if (e.key === 'Escape') setShowAddColumn(false);
                }}
              />
              <select
                value={newColType}
                onChange={(e) => setNewColType(e.target.value as ColumnType)}
                className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
              >
                {columnTypes.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <div className="flex gap-1 justify-end">
                <button
                  onClick={() => setShowAddColumn(false)}
                  className="px-2 py-1 text-xs rounded hover:bg-theme-hover text-muted-foreground"
                >
                  {t('actions.cancel')}
                </button>
                <button
                  onClick={handleAddColumn}
                  className="px-2 py-1 text-xs rounded bg-theme-accent text-white hover:opacity-90"
                >
                  {t('actions.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sort toggle */}
      <button
        onClick={() => {
          if (schema.sortBy) {
            // Toggle direction or clear sort
            const newDir = schema.sortBy.direction === 'asc' ? 'desc' : undefined;
            if (newDir) {
              onSchemaChange({ ...schema, sortBy: { ...schema.sortBy, direction: newDir } });
            } else {
              const { sortBy: _, ...rest } = schema;
              onSchemaChange(rest as DatabaseSchema);
            }
          }
        }}
        className={`px-2 py-0.5 text-xs rounded hover:bg-theme-hover transition-colors border border-theme-border ${
          schema.sortBy ? 'text-theme-accent' : 'text-muted-foreground'
        }`}
        title={schema.sortBy
          ? `${t('database.sort')}: ${schema.sortBy.direction === 'asc' ? t('database.ascending') : t('database.descending')}`
          : t('database.sort')}
      >
        {t('database.sort')}
      </button>
    </div>
  );
}
