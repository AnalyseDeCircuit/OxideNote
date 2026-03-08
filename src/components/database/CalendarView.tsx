/**
 * CalendarView — Month-grid calendar for database notes
 *
 * Displays rows with a date column on a monthly grid.
 * Clicking a date cell allows adding new entries.
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { generateId, type DatabaseSchema, type Column, type Row } from '@/lib/database';

interface CalendarViewProps {
  schema: DatabaseSchema;
  onSchemaChange: (schema: DatabaseSchema) => void;
}

export function CalendarView({ schema, onSchemaChange }: CalendarViewProps) {
  const { t } = useTranslation();
  const [currentDate, setCurrentDate] = useState(() => new Date());

  // Find the calendar date column
  const dateCol = schema.columns.find((c) => c.id === schema.calendarColumn);
  const titleCol = schema.columns.find((c) => c.type === 'text');

  if (!dateCol) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
        <p>{t('database.noData')}</p>
      </div>
    );
  }

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Build calendar grid data
  const calendarDays = useMemo(() => buildMonthGrid(year, month), [year, month]);

  // Group rows by date string (YYYY-MM-DD)
  const rowsByDate = useMemo(() => {
    const map = new Map<string, typeof schema.rows>();
    for (const row of schema.rows) {
      const dateStr = String(row[dateCol.id] || '');
      if (!dateStr) continue;
      const existing = map.get(dateStr) || [];
      existing.push(row);
      map.set(dateStr, existing);
    }
    return map;
  }, [schema.rows, dateCol.id]);

  // Navigate months
  const prevMonth = useCallback(() => {
    setCurrentDate(new Date(year, month - 1, 1));
  }, [year, month]);

  const nextMonth = useCallback(() => {
    setCurrentDate(new Date(year, month + 1, 1));
  }, [year, month]);

  const goToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  // Add a row on a specific date
  const handleAddOnDate = useCallback((dateStr: string) => {
    const newRow: Row = { id: generateId() };
    for (const col of schema.columns) {
      if (col.id === dateCol.id) {
        newRow[col.id] = dateStr;
      } else if (col.type === 'checkbox') {
        newRow[col.id] = false;
      } else {
        newRow[col.id] = '';
      }
    }
    onSchemaChange({ ...schema, rows: [...schema.rows, newRow] });
  }, [schema, dateCol.id, onSchemaChange]);

  const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date();
  const todayStr = formatDate(today);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Calendar header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-theme-border">
        <button onClick={prevMonth} className="p-1 rounded hover:bg-theme-hover text-muted-foreground" aria-label="Previous month">◀</button>
        <span className="text-sm font-medium text-foreground min-w-[140px] text-center">
          {year}-{String(month + 1).padStart(2, '0')}
        </span>
        <button onClick={nextMonth} className="p-1 rounded hover:bg-theme-hover text-muted-foreground" aria-label="Next month">▶</button>
        <button onClick={goToday} className="px-2 py-0.5 text-xs rounded border border-theme-border hover:bg-theme-hover text-muted-foreground ml-2">
          {t('dailyNote.today')}
        </button>
      </div>

      {/* Week day headers */}
      <div className="grid grid-cols-7 border-b border-theme-border">
        {weekDays.map((d) => (
          <div key={d} className="px-1 py-1 text-center text-[10px] text-muted-foreground font-medium">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="flex-1 grid grid-cols-7 overflow-y-auto">
        {calendarDays.map((day, i) => {
          const dateStr = day ? formatDate(new Date(year, month, day)) : '';
          const rows = dateStr ? (rowsByDate.get(dateStr) || []) : [];
          const isToday = dateStr === todayStr;
          const isCurrentMonth = day > 0;

          return (
            <div
              key={i}
              className={`min-h-[80px] border-b border-r border-theme-border p-1 ${
                isCurrentMonth ? 'bg-background' : 'bg-surface/50'
              } ${isToday ? 'ring-1 ring-inset ring-theme-accent' : ''}`}
              onDoubleClick={() => dateStr && handleAddOnDate(dateStr)}
            >
              {isCurrentMonth && (
                <>
                  <div className={`text-[10px] mb-0.5 ${isToday ? 'text-theme-accent font-bold' : 'text-muted-foreground'}`}>
                    {day}
                  </div>
                  {rows.slice(0, 3).map((row) => (
                    <CalendarEntry
                      key={String(row.id)}
                      title={titleCol ? String(row[titleCol.id] || '') : String(row.id)}
                    />
                  ))}
                  {rows.length > 3 && (
                    <div className="text-[9px] text-muted-foreground">+{rows.length - 3}</div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Calendar Entry Badge ───────────────────────────────────

function CalendarEntry({ title }: { title: string }) {
  return (
    <div className="text-[10px] px-1 py-0.5 mb-0.5 rounded bg-theme-accent/20 text-theme-accent truncate">
      {title || '—'}
    </div>
  );
}

// ─── Utility: Build month grid ──────────────────────────────

function buildMonthGrid(year: number, month: number): number[] {
  const firstDay = new Date(year, month, 1).getDay();
  // Convert Sunday=0 to Monday-start (Mon=0, Sun=6)
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const grid: number[] = [];
  // Padding for days before month starts
  for (let i = 0; i < startOffset; i++) grid.push(0);
  // Actual days
  for (let d = 1; d <= daysInMonth; d++) grid.push(d);
  // Pad to fill last row
  while (grid.length % 7 !== 0) grid.push(0);

  return grid;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
