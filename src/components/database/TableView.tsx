/**
 * TableView — CSS Grid-based table view for database notes
 *
 * Features:
 *   · Editable cells (double-click to edit)
 *   · Column header sorting
 *   · Row deletion
 *   · Type-aware cell rendering (text, number, select, date, checkbox, url)
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DatabaseSchema, Column, Row } from '@/lib/database';
import { updateCell, deleteRow, deleteColumn, sortRows, filterRows } from '@/lib/database';

interface TableViewProps {
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function TableView({ schema, onSchemaChange }: TableViewProps) {
  const { t } = useTranslation();
  const [editingCell, setEditingCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; colId: string } | null>(null);

  // Apply sort and filter to rows
  let displayRows = [...schema.rows];
  if (schema.filters && schema.filters.length > 0) {
    displayRows = filterRows(displayRows, schema.filters);
  }
  if (schema.sortBy) {
    displayRows = sortRows(displayRows, schema.sortBy.column, schema.sortBy.direction);
  }

  // Handle cell value change
  const handleCellChange = useCallback((rowId: string, colId: string, value: unknown) => {
    onSchemaChange(updateCell(schema, rowId, colId, value));
  }, [schema, onSchemaChange]);

  // Handle row delete
  const handleDeleteRow = useCallback((rowId: string) => {
    onSchemaChange(deleteRow(schema, rowId));
  }, [schema, onSchemaChange]);

  // Handle column sort
  const handleSort = useCallback((colId: string) => {
    if (schema.sortBy?.column === colId) {
      const newDir = schema.sortBy.direction === 'asc' ? 'desc' : 'asc';
      onSchemaChange({ ...schema, sortBy: { column: colId, direction: newDir } });
    } else {
      onSchemaChange({ ...schema, sortBy: { column: colId, direction: 'asc' } });
    }
  }, [schema, onSchemaChange]);

  // Handle column delete via context menu
  const handleDeleteColumn = useCallback((colId: string) => {
    onSchemaChange(deleteColumn(schema, colId));
    setContextMenu(null);
  }, [schema, onSchemaChange]);

  const handleHeaderContextMenu = useCallback((e: React.MouseEvent, colId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, colId });
  }, []);

  // Grid template: action column + data columns
  const gridCols = `40px ${schema.columns.map((c) => `${c.width || 150}px`).join(' ')}`;

  return (
    <div className="overflow-auto flex-1" onClick={() => setContextMenu(null)}>
      <div className="min-w-fit">
        {/* Header row */}
        <div className="grid border-b border-theme-border bg-surface sticky top-0 z-10" style={{ gridTemplateColumns: gridCols }}>
          {/* Row number / action column header */}
          <div className="px-1 py-1.5 text-xs text-muted-foreground text-center">#</div>
          {schema.columns.map((col) => (
            <div
              key={col.id}
              className="px-2 py-1.5 text-xs font-medium text-foreground cursor-pointer hover:bg-theme-hover select-none flex items-center gap-1 border-l border-theme-border"
              onClick={() => handleSort(col.id)}
              onContextMenu={(e) => handleHeaderContextMenu(e, col.id)}
            >
              <span className="truncate">{col.name}</span>
              {schema.sortBy?.column === col.id && (
                <span className="text-theme-accent text-[10px]">
                  {schema.sortBy.direction === 'asc' ? '▲' : '▼'}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Data rows */}
        {displayRows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('database.noData')}
          </div>
        ) : (
          displayRows.map((row, idx) => (
            <div
              key={row.id}
              className="grid border-b border-theme-border hover:bg-theme-hover/50 group"
              style={{ gridTemplateColumns: gridCols }}
            >
              {/* Row number + delete button */}
              <div className="px-1 py-1 text-xs text-muted-foreground text-center relative">
                <span className="group-hover:hidden">{idx + 1}</span>
                <button
                  onClick={() => handleDeleteRow(row.id)}
                  className="hidden group-hover:inline text-red-400 hover:text-red-300 text-xs"
                  title={t('database.deleteRow')}
                >
                  ×
                </button>
              </div>
              {schema.columns.map((col) => (
                <CellRenderer
                  key={col.id}
                  column={col}
                  value={row[col.id]}
                  editing={editingCell?.rowId === row.id && editingCell?.colId === col.id}
                  onStartEdit={() => setEditingCell({ rowId: row.id, colId: col.id })}
                  onEndEdit={() => setEditingCell(null)}
                  onChange={(val) => handleCellChange(row.id, col.id, val)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* Column context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-surface border border-theme-border rounded shadow-lg py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleSort(contextMenu.colId)}
            className="w-full px-3 py-1.5 text-xs text-left hover:bg-theme-hover text-foreground"
          >
            {t('database.sort')}
          </button>
          <button
            onClick={() => handleDeleteColumn(contextMenu.colId)}
            className="w-full px-3 py-1.5 text-xs text-left hover:bg-theme-hover text-red-400"
          >
            {t('database.deleteColumn')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Cell Renderer ──────────────────────────────────────────

interface CellRendererProps {
  column: Column;
  value: unknown;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onChange: (value: unknown) => void;
}

function CellRenderer({ column, value, editing, onStartEdit, onEndEdit, onChange }: CellRendererProps) {
  // Checkbox: always interactive
  if (column.type === 'checkbox') {
    return (
      <div className="px-2 py-1 border-l border-theme-border flex items-center">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-theme-accent"
        />
      </div>
    );
  }

  // Select: always show dropdown in edit mode
  if (column.type === 'select' && editing) {
    return (
      <div className="px-2 py-1 border-l border-theme-border">
        <select
          value={String(value || '')}
          onChange={(e) => { onChange(e.target.value); onEndEdit(); }}
          onBlur={onEndEdit}
          className="w-full px-1 py-0.5 text-xs bg-background text-foreground border border-theme-accent rounded outline-none"
          autoFocus
        >
          <option value="">—</option>
          {column.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  // Date: show date picker in edit mode
  if (column.type === 'date' && editing) {
    return (
      <div className="px-2 py-1 border-l border-theme-border">
        <input
          type="date"
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onEndEdit}
          className="w-full px-1 py-0.5 text-xs bg-background text-foreground border border-theme-accent rounded outline-none"
          autoFocus
        />
      </div>
    );
  }

  // URL: render as clickable link in view mode (only http/https allowed)
  if (column.type === 'url' && !editing) {
    const urlStr = String(value || '');
    const isSafeUrl = /^https?:\/\//i.test(urlStr);
    return (
      <div
        className="px-2 py-1 border-l border-theme-border text-xs truncate cursor-pointer"
        onDoubleClick={onStartEdit}
      >
        {urlStr ? (
          isSafeUrl ? (
            <a
              href={urlStr}
              target="_blank"
              rel="noopener noreferrer"
              className="text-theme-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {urlStr}
            </a>
          ) : (
            <span className="text-foreground">{urlStr}</span>
          )
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    );
  }

  // Generic editing mode (text, number, url, multi-select)
  if (editing) {
    const inputType = column.type === 'number' ? 'number' : 'text';
    return (
      <div className="px-2 py-1 border-l border-theme-border">
        <input
          type={inputType}
          value={String(value ?? '')}
          onChange={(e) => onChange(column.type === 'number' ? Number(e.target.value) : e.target.value)}
          onBlur={onEndEdit}
          onKeyDown={(e) => { if (e.key === 'Enter') onEndEdit(); }}
          className="w-full px-1 py-0.5 text-xs bg-background text-foreground border border-theme-accent rounded outline-none"
          autoFocus
        />
      </div>
    );
  }

  // View mode — display value
  const displayValue = value === undefined || value === null || value === '' ? '—' : String(value);
  const isPlaceholder = displayValue === '—';

  // Select and multi-select badges
  if (column.type === 'select' && !isPlaceholder) {
    return (
      <div
        className="px-2 py-1 border-l border-theme-border text-xs cursor-pointer"
        onDoubleClick={onStartEdit}
      >
        <span className="inline-block px-1.5 py-0.5 rounded bg-theme-accent/20 text-theme-accent text-[10px]">
          {displayValue}
        </span>
      </div>
    );
  }

  if (column.type === 'multi-select' && !isPlaceholder) {
    const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    return (
      <div
        className="px-2 py-1 border-l border-theme-border text-xs cursor-pointer flex flex-wrap gap-0.5"
        onDoubleClick={onStartEdit}
      >
        {items.map((item) => (
          <span key={item} className="inline-block px-1.5 py-0.5 rounded bg-theme-accent/20 text-theme-accent text-[10px]">
            {item}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      className={`px-2 py-1 border-l border-theme-border text-xs truncate cursor-pointer ${
        isPlaceholder ? 'text-muted-foreground' : 'text-foreground'
      }`}
      onDoubleClick={onStartEdit}
    >
      {displayValue}
    </div>
  );
}
