/**
 * RowDetailDialog — Expanded row editor for database notes
 *
 * Opens as a modal dialog showing all column values for a single row
 * in a vertical form layout, making it easy to view and edit records
 * without horizontal scrolling in large tables.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DatabaseSchema, Column, Row } from '@/lib/database';
import { updateCell } from '@/lib/database';

interface RowDetailDialogProps {
  open: boolean;
  onClose: () => void;
  row: Row;
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function RowDetailDialog({ open, onClose, row, schema, onSchemaChange }: RowDetailDialogProps) {
  const { t } = useTranslation();

  // Find the first text column to use as a row title
  const titleCol = schema.columns.find((c) => c.type === 'text');
  const rowTitle = titleCol ? String(row[titleCol.id] || '') : '';

  const handleChange = useCallback((colId: string, value: unknown) => {
    onSchemaChange(updateCell(schema, row.id, colId, value));
  }, [schema, row.id, onSchemaChange]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{rowTitle || t('database.rowDetail')}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {schema.columns.map((col) => (
            <FieldEditor
              key={col.id}
              column={col}
              value={row[col.id]}
              onChange={(val) => handleChange(col.id, val)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Individual field editor by column type ──────────────────

function FieldEditor({
  column,
  value,
  onChange,
}: {
  column: Column;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';
  const inputClass = 'w-full px-2 py-1.5 text-sm bg-background text-foreground border border-theme-border rounded focus:border-theme-accent outline-none';

  switch (column.type) {
    case 'checkbox':
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-theme-accent"
            id={`field-${column.id}`}
          />
          <label htmlFor={`field-${column.id}`} className="text-sm text-foreground">
            {column.name}
          </label>
        </div>
      );

    case 'select':
      return (
        <div>
          <label className={labelClass}>{column.name}</label>
          <select
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {column.options?.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      );

    case 'multi-select':
      return (
        <div>
          <label className={labelClass}>{column.name}</label>
          <MultiSelectField
            value={String(value || '')}
            options={column.options || []}
            onChange={(v) => onChange(v)}
          />
        </div>
      );

    case 'date':
      return (
        <div>
          <label className={labelClass}>{column.name}</label>
          <input
            type="date"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          />
        </div>
      );

    case 'number':
      return (
        <div>
          <label className={labelClass}>{column.name}</label>
          <input
            type="number"
            value={String(value ?? '')}
            onChange={(e) => onChange(Number(e.target.value))}
            className={inputClass}
          />
        </div>
      );

    case 'url':
      return (
        <div>
          <label className={labelClass}>{column.name}</label>
          <input
            type="url"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://..."
            className={inputClass}
          />
        </div>
      );

    default:
      return (
        <div>
          <label className={labelClass}>{column.name}</label>
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          />
        </div>
      );
  }
}

// ── Multi-select toggle field ───────────────────────────────

function MultiSelectField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const selected = value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const toggle = (opt: string) => {
    const next = selected.includes(opt)
      ? selected.filter((s) => s !== opt)
      : [...selected, opt];
    onChange(next.join(', '));
  };

  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => toggle(opt)}
          className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
            selected.includes(opt)
              ? 'bg-theme-accent/20 border-theme-accent text-theme-accent'
              : 'bg-background border-theme-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
