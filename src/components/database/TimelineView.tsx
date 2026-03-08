/**
 * TimelineView — Vertical timeline for database notes
 *
 * Displays rows along a vertical timeline driven by a date column.
 * Each row renders as a card positioned along the timeline axis,
 * with alternating left/right placement and date markers.
 *
 * Rows without a date value are collected in a "No Date" section at the bottom.
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DatabaseSchema, Column, Row } from '@/lib/database';
import { updateCell, deleteRow, filterRows } from '@/lib/database';

interface TimelineViewProps {
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function TimelineView({ schema, onSchemaChange }: TimelineViewProps) {
  const { t } = useTranslation();

  // Resolve the date column for timeline positioning
  const dateCol = useMemo(() => {
    if (schema.timelineColumn) {
      return schema.columns.find((c) => c.id === schema.timelineColumn);
    }
    // Fallback: calendarColumn, then first date column
    if (schema.calendarColumn) {
      return schema.columns.find((c) => c.id === schema.calendarColumn);
    }
    return schema.columns.find((c) => c.type === 'date');
  }, [schema.columns, schema.timelineColumn, schema.calendarColumn]);

  const titleCol = useMemo(
    () => schema.columns.find((c) => c.type === 'text'),
    [schema.columns],
  );

  // Apply filters (no sorting — timeline sorts by date inherently)
  let displayRows = [...schema.rows];
  if (schema.filters && schema.filters.length > 0) {
    displayRows = filterRows(displayRows, schema.filters);
  }

  // Split rows into dated (sorted chronologically) and undated
  const { dated, undated } = useMemo(() => {
    if (!dateCol) return { dated: [] as Row[], undated: displayRows };

    const withDate: Row[] = [];
    const noDate: Row[] = [];
    for (const row of displayRows) {
      const d = String(row[dateCol.id] || '');
      if (d) withDate.push(row);
      else noDate.push(row);
    }

    // Sort chronologically (ascending)
    withDate.sort((a, b) => {
      const da = String(a[dateCol.id] || '');
      const db = String(b[dateCol.id] || '');
      return da.localeCompare(db);
    });

    return { dated: withDate, undated: noDate };
  }, [displayRows, dateCol]);

  const handleCellChange = useCallback((rowId: string, colId: string, value: unknown) => {
    onSchemaChange(updateCell(schema, rowId, colId, value));
  }, [schema, onSchemaChange]);

  const handleDeleteRow = useCallback((rowId: string) => {
    onSchemaChange(deleteRow(schema, rowId));
  }, [schema, onSchemaChange]);

  if (!dateCol) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
        {t('database.timelineNoDate')}
      </div>
    );
  }

  if (dated.length === 0 && undated.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
        {t('database.noData')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="relative max-w-2xl mx-auto">
        {/* Vertical timeline axis */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-theme-border -translate-x-1/2" />

        {dated.map((row, idx) => (
          <TimelineNode
            key={row.id}
            row={row}
            dateCol={dateCol}
            titleCol={titleCol}
            metaCols={schema.columns.filter((c) => c.id !== dateCol.id && c.id !== titleCol?.id)}
            side={idx % 2 === 0 ? 'left' : 'right'}
            onCellChange={handleCellChange}
            onDelete={handleDeleteRow}
          />
        ))}

        {/* Undated items at bottom */}
        {undated.length > 0 && (
          <div className="mt-6 pt-4 border-t border-theme-border/50">
            <div className="text-center text-xs text-muted-foreground mb-3">
              {t('database.timelineNoDate')}
            </div>
            {undated.map((row, idx) => (
              <TimelineNode
                key={row.id}
                row={row}
                dateCol={dateCol}
                titleCol={titleCol}
                metaCols={schema.columns.filter((c) => c.id !== dateCol.id && c.id !== titleCol?.id)}
                side={idx % 2 === 0 ? 'left' : 'right'}
                onCellChange={handleCellChange}
                onDelete={handleDeleteRow}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Timeline Node ──────────────────────────────────────────

interface TimelineNodeProps {
  row: Row;
  dateCol: Column;
  titleCol?: Column;
  metaCols: Column[];
  side: 'left' | 'right';
  onCellChange: (rowId: string, colId: string, value: unknown) => void;
  onDelete: (rowId: string) => void;
}

function TimelineNode({ row, dateCol, titleCol, metaCols, side, onCellChange, onDelete }: TimelineNodeProps) {
  const { t } = useTranslation();
  const [editingTitle, setEditingTitle] = useState(false);
  const rowId = String(row.id);
  const dateStr = String(row[dateCol.id] || '');
  const title = titleCol ? String(row[titleCol.id] || '') : rowId;

  const isLeft = side === 'left';

  return (
    <div className={`relative flex items-start mb-6 ${isLeft ? 'flex-row' : 'flex-row-reverse'}`}>
      {/* Card */}
      <div className={`w-[calc(50%-20px)] ${isLeft ? 'pr-4 text-right' : 'pl-4 text-left'}`}>
        <div className="group relative bg-background rounded-lg border border-theme-border p-3 hover:border-theme-accent/50 transition-colors inline-block w-full">
          {/* Delete button */}
          <button
            onClick={() => onDelete(rowId)}
            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300 text-xs w-5 h-5 flex items-center justify-center"
            title={t('database.deleteRow')}
          >
            ×
          </button>

          {/* Date badge */}
          {dateStr && (
            <div className="text-[10px] text-theme-accent font-medium mb-1">
              {dateStr}
            </div>
          )}

          {/* Title */}
          {editingTitle && titleCol ? (
            <input
              value={title}
              onChange={(e) => onCellChange(rowId, titleCol.id, e.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => { if (e.key === 'Enter') setEditingTitle(false); }}
              className="w-full px-1 py-0.5 text-xs bg-background text-foreground border border-theme-accent rounded outline-none"
              autoFocus
            />
          ) : (
            <div
              className="text-xs font-medium text-foreground truncate cursor-pointer"
              onDoubleClick={() => titleCol && setEditingTitle(true)}
            >
              {title || <span className="text-muted-foreground italic">—</span>}
            </div>
          )}

          {/* Metadata (up to 2 fields) */}
          {metaCols.slice(0, 2).map((col) => {
            const val = row[col.id];
            if (val === undefined || val === null || val === '') return null;
            return (
              <div key={col.id} className="text-[10px] text-muted-foreground truncate mt-0.5">
                <span className="opacity-60">{col.name}:</span> {String(val)}
              </div>
            );
          })}
        </div>
      </div>

      {/* Center dot on timeline axis */}
      <div className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-theme-accent border-2 border-background z-10 mt-3" />
    </div>
  );
}
