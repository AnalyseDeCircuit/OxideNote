/**
 * KanbanView — Drag-and-drop kanban board for database notes
 *
 * Groups rows by a select-type column, rendered as swimlane columns.
 * Uses native HTML Drag and Drop API to move cards between columns.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DatabaseSchema, Column } from '@/lib/database';
import { moveRow, updateCell } from '@/lib/database';

interface KanbanViewProps {
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function KanbanView({ schema, onSchemaChange }: KanbanViewProps) {
  const { t } = useTranslation();
  const [dragOverLane, setDragOverLane] = useState<string | null>(null);

  // Find the kanban grouping column (must be select type)
  const kanbanCol = schema.columns.find((c) => c.id === schema.kanbanColumn);
  if (!kanbanCol || kanbanCol.type !== 'select') {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
        <p>{t('database.noData')}</p>
      </div>
    );
  }

  // Build lanes: one per option + one for ungrouped
  const lanes = [...(kanbanCol.options || []), ''];

  // Group rows by the kanban column value
  const groupedRows = new Map<string, typeof schema.rows>();
  for (const lane of lanes) {
    groupedRows.set(lane, []);
  }
  for (const row of schema.rows) {
    const val = String(row[kanbanCol.id] || '');
    const bucket = groupedRows.get(val) || groupedRows.get('')!;
    bucket.push(row);
  }

  // Drag event handlers
  const handleDragStart = useCallback((e: React.DragEvent, rowId: string) => {
    e.dataTransfer.setData('text/plain', rowId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, lane: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverLane(lane);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverLane(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetLane: string) => {
    e.preventDefault();
    setDragOverLane(null);
    const rowId = e.dataTransfer.getData('text/plain');
    if (!rowId) return;
    onSchemaChange(moveRow(schema, rowId, targetLane, kanbanCol.id));
  }, [schema, onSchemaChange, kanbanCol.id]);

  // Find the first text column for card title display
  const titleCol = schema.columns.find((c) => c.type === 'text');

  return (
    <div className="flex-1 overflow-x-auto p-3">
      <div className="flex gap-3 min-h-full">
        {lanes.map((lane) => {
          const rows = groupedRows.get(lane) || [];
          const laneLabel = lane || t('database.kanbanUngrouped');
          const isOver = dragOverLane === lane;

          return (
            <div
              key={lane}
              className={`flex flex-col min-w-[220px] max-w-[280px] rounded-lg border transition-colors ${
                isOver ? 'border-theme-accent bg-theme-accent/5' : 'border-theme-border bg-surface'
              }`}
              onDragOver={(e) => handleDragOver(e, lane)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, lane)}
            >
              {/* Lane header */}
              <div className="px-3 py-2 border-b border-theme-border flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">{laneLabel}</span>
                <span className="text-[10px] text-muted-foreground">{rows.length}</span>
              </div>

              {/* Cards */}
              <div className="flex-1 p-2 space-y-2 overflow-y-auto">
                {rows.map((row) => (
                  <KanbanCard
                    key={row.id}
                    row={row}
                    columns={schema.columns}
                    kanbanColId={kanbanCol.id}
                    titleCol={titleCol}
                    onDragStart={handleDragStart}
                    onCellChange={(colId, val) =>
                      onSchemaChange(updateCell(schema, row.id, colId, val))
                    }
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Kanban Card ────────────────────────────────────────────

interface KanbanCardProps {
  row: Record<string, unknown>;
  columns: Column[];
  kanbanColId: string;
  titleCol?: Column;
  onDragStart: (e: React.DragEvent, rowId: string) => void;
  onCellChange: (colId: string, value: unknown) => void;
}

function KanbanCard({ row, columns, kanbanColId, titleCol, onDragStart, onCellChange }: KanbanCardProps) {
  const [editing, setEditing] = useState(false);
  const rowId = String(row.id);
  const title = titleCol ? String(row[titleCol.id] || '') : rowId;

  // Display other columns as metadata
  const metaCols = columns.filter((c) => c.id !== kanbanColId && c.id !== titleCol?.id);

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, rowId)}
      className="bg-background rounded border border-theme-border p-2 cursor-grab active:cursor-grabbing hover:border-theme-accent/50 transition-colors"
    >
      {/* Title */}
      {editing ? (
        <input
          value={title}
          onChange={(e) => titleCol && onCellChange(titleCol.id, e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Enter') setEditing(false); }}
          className="w-full px-1 py-0.5 text-xs bg-background text-foreground border border-theme-accent rounded outline-none"
          autoFocus
        />
      ) : (
        <div
          className="text-xs font-medium text-foreground truncate"
          onDoubleClick={() => setEditing(true)}
        >
          {title || <span className="text-muted-foreground italic">—</span>}
        </div>
      )}

      {/* Metadata fields */}
      {metaCols.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {metaCols.slice(0, 3).map((col) => {
            const val = row[col.id];
            if (val === undefined || val === null || val === '') return null;

            if (col.type === 'checkbox') {
              return (
                <div key={col.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={Boolean(val)}
                    onChange={(e) => onCellChange(col.id, e.target.checked)}
                    className="accent-theme-accent w-3 h-3"
                  />
                  <span className="text-[10px] text-muted-foreground">{col.name}</span>
                </div>
              );
            }

            return (
              <div key={col.id} className="text-[10px] text-muted-foreground truncate">
                <span className="opacity-60">{col.name}:</span> {String(val)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
