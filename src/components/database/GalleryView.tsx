/**
 * GalleryView — Card grid view for database notes
 *
 * Displays rows as visual cards with:
 *   · Cover image (from a URL column or first image URL in row data)
 *   · Title (from a designated text column or first text column)
 *   · Summary metadata fields (up to 3 additional columns)
 *
 * Cards are laid out in a responsive CSS Grid. Double-click a card
 * to edit its title inline; click the delete button on hover to remove.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DatabaseSchema, Column, Row } from '@/lib/database';
import { updateCell, deleteRow, sortRows, filterRows } from '@/lib/database';
import { FileText } from 'lucide-react';

interface GalleryViewProps {
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function GalleryView({ schema, onSchemaChange }: GalleryViewProps) {
  const { t } = useTranslation();

  // Resolve the title column: explicit setting > first text column
  const titleCol = useMemo(() => {
    if (schema.galleryTitleColumn) {
      return schema.columns.find((c) => c.id === schema.galleryTitleColumn);
    }
    return schema.columns.find((c) => c.type === 'text');
  }, [schema.columns, schema.galleryTitleColumn]);

  // Resolve the cover image column: explicit setting > first url column
  const coverCol = useMemo(() => {
    if (schema.galleryCoverColumn) {
      return schema.columns.find((c) => c.id === schema.galleryCoverColumn);
    }
    return schema.columns.find((c) => c.type === 'url');
  }, [schema.columns, schema.galleryCoverColumn]);

  // Metadata columns: everything except title and cover
  const metaCols = useMemo(() => {
    const excludeIds = new Set([titleCol?.id, coverCol?.id].filter(Boolean));
    return schema.columns.filter((c) => !excludeIds.has(c.id));
  }, [schema.columns, titleCol, coverCol]);

  // Apply sorting and filtering
  let displayRows = [...schema.rows];
  if (schema.filters && schema.filters.length > 0) {
    displayRows = filterRows(displayRows, schema.filters);
  }
  if (schema.sortBy) {
    displayRows = sortRows(displayRows, schema.sortBy.column, schema.sortBy.direction);
  }

  const handleDeleteRow = useCallback((rowId: string) => {
    onSchemaChange(deleteRow(schema, rowId));
  }, [schema, onSchemaChange]);

  const handleCellChange = useCallback((rowId: string, colId: string, value: unknown) => {
    onSchemaChange(updateCell(schema, rowId, colId, value));
  }, [schema, onSchemaChange]);

  if (displayRows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
        {t('database.noData')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {displayRows.map((row) => (
          <GalleryCard
            key={row.id}
            row={row}
            titleCol={titleCol}
            coverCol={coverCol}
            metaCols={metaCols}
            onCellChange={handleCellChange}
            onDelete={handleDeleteRow}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Gallery Card ───────────────────────────────────────────

interface GalleryCardProps {
  row: Row;
  titleCol?: Column;
  coverCol?: Column;
  metaCols: Column[];
  onCellChange: (rowId: string, colId: string, value: unknown) => void;
  onDelete: (rowId: string) => void;
}

function GalleryCard({ row, titleCol, coverCol, metaCols, onCellChange, onDelete }: GalleryCardProps) {
  const { t } = useTranslation();
  const [editingTitle, setEditingTitle] = useState(false);

  const rowId = String(row.id);
  const title = titleCol ? String(row[titleCol.id] || '') : '';
  const coverUrl = coverCol ? String(row[coverCol.id] || '') : '';
  const hasCover = coverUrl && /^https?:\/\//i.test(coverUrl);

  return (
    <div className="group relative bg-background rounded-lg border border-theme-border overflow-hidden hover:border-theme-accent/50 transition-colors">
      {/* Cover image area */}
      {hasCover ? (
        <div className="h-32 bg-surface overflow-hidden">
          <img
            src={coverUrl}
            alt={title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              // Hide broken image, show placeholder
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      ) : (
        <div className="h-20 bg-surface flex items-center justify-center">
          <FileText size={24} className="text-muted-foreground/30" />
        </div>
      )}

      {/* Delete button */}
      <button
        onClick={() => onDelete(rowId)}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 rounded-full w-5 h-5 flex items-center justify-center text-red-400 hover:text-red-300 text-xs backdrop-blur-sm"
        title={t('database.deleteRow')}
      >
        ×
      </button>

      {/* Card body */}
      <div className="p-2.5">
        {/* Title */}
        {editingTitle && titleCol ? (
          <input
            value={title}
            onChange={(e) => onCellChange(rowId, titleCol.id, e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => { if (e.key === 'Enter') setEditingTitle(false); }}
            className="w-full px-1 py-0.5 text-sm bg-background text-foreground border border-theme-accent rounded outline-none font-medium"
            autoFocus
          />
        ) : (
          <div
            className="text-sm font-medium text-foreground truncate cursor-pointer"
            onDoubleClick={() => titleCol && setEditingTitle(true)}
          >
            {title || <span className="text-muted-foreground italic">—</span>}
          </div>
        )}

        {/* Metadata fields (up to 3) */}
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
                      onChange={(e) => onCellChange(rowId, col.id, e.target.checked)}
                      className="accent-theme-accent w-3 h-3"
                    />
                    <span className="text-[10px] text-muted-foreground">{col.name}</span>
                  </div>
                );
              }

              if (col.type === 'select') {
                return (
                  <div key={col.id} className="text-[10px]">
                    <span className="inline-block px-1.5 py-0.5 rounded bg-theme-accent/20 text-theme-accent">
                      {String(val)}
                    </span>
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
    </div>
  );
}
