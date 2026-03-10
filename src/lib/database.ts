/**
 * Database Data Model & Utilities
 *
 * Manages structured data stored in Markdown frontmatter under the
 * `oxide-db` YAML key. Supports table, kanban, calendar, gallery,
 * and timeline views. Column types include relation for cross-note linking.
 *
 * Data schema is embedded directly in the note's frontmatter:
 *   ---
 *   oxide-db:
 *     columns: [...]
 *     rows: [...]
 *     view: table
 *   ---
 */

// ─── Types ───────────────────────────────────────────────────

export type ColumnType = 'text' | 'number' | 'select' | 'multi-select' | 'date' | 'checkbox' | 'url' | 'relation';
export type ViewType = 'table' | 'kanban' | 'calendar' | 'gallery' | 'timeline';

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  options?: string[];   // for select/multi-select
  width?: number;
}

export interface Row {
  id: string;
  [columnId: string]: unknown;
}

export interface DatabaseSchema {
  columns: Column[];
  rows: Row[];
  view: ViewType;
  kanbanColumn?: string;
  calendarColumn?: string;
  timelineColumn?: string;     // date column used for timeline view
  galleryTitleColumn?: string;  // text column used as card title in gallery
  galleryCoverColumn?: string;  // url column used as card cover image in gallery
  sortBy?: { column: string; direction: 'asc' | 'desc' };
  filters?: Filter[];
}

export interface Filter {
  column: string;
  operator: 'eq' | 'neq' | 'contains' | 'empty' | 'notEmpty';
  value?: string;
}

// ─── ID Generation ──────────────────────────────────────────

let idCounter = 0;

export function generateId(): string {
  return Date.now().toString(36) + (idCounter++).toString(36);
}

// ─── Default Schema ─────────────────────────────────────────

export function createDefaultSchema(): DatabaseSchema {
  const titleCol: Column = { id: generateId(), name: 'Title', type: 'text' };
  const statusCol: Column = {
    id: generateId(),
    name: 'Status',
    type: 'select',
    options: ['Todo', 'In Progress', 'Done'],
  };
  const dateCol: Column = { id: generateId(), name: 'Date', type: 'date' };

  return {
    columns: [titleCol, statusCol, dateCol],
    rows: [],
    view: 'table',
    kanbanColumn: statusCol.id,
    calendarColumn: dateCol.id,
  };
}

// ─── Frontmatter Parsing ────────────────────────────────────

/**
 * Extract oxide-db schema from Markdown frontmatter.
 * Returns null if no oxide-db block is found.
 */
export function parseDatabaseFromContent(content: string): DatabaseSchema | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];

  try {
    // Primary format: base64-encoded JSON (safe for any content in cells)
    const b64Match = frontmatter.match(/oxide-db-json:\s*(.+)$/);
    if (b64Match) {
      const decoded = atob(b64Match[1].trim());
      return JSON.parse(decoded) as DatabaseSchema;
    }
  } catch {
    // Parse error — return null
  }

  return null;
}

/**
 * Serialize database schema back into Markdown content,
 * replacing the existing oxide-db block in frontmatter.
 */
export function serializeDatabaseToContent(content: string, schema: DatabaseSchema): string {
  // Base64-encode the JSON to avoid any quoting/escaping issues in YAML frontmatter
  const b64Str = btoa(JSON.stringify(schema));

  // Check if frontmatter exists
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (fmMatch) {
    let frontmatter = fmMatch[2];

    // Replace existing oxide-db-json line
    if (frontmatter.includes('oxide-db-json:')) {
      frontmatter = frontmatter.replace(/oxide-db-json:\s*.+$/m, `oxide-db-json: ${b64Str}`);
    } else {
      frontmatter += `\noxide-db-json: ${b64Str}`;
    }

    return fmMatch[1] + frontmatter + fmMatch[3] + content.slice(fmMatch[0].length);
  }

  // No frontmatter — create one
  return `---\noxide-db-json: ${b64Str}\n---\n\n${content}`;
}

// ─── CRUD Operations ────────────────────────────────────────

export function addRow(schema: DatabaseSchema): DatabaseSchema {
  const newRow: Row = { id: generateId() };
  for (const col of schema.columns) {
    if (col.type === 'checkbox') {
      newRow[col.id] = false;
    } else {
      newRow[col.id] = '';
    }
  }
  return { ...schema, rows: [...schema.rows, newRow] };
}

export function deleteRow(schema: DatabaseSchema, rowId: string): DatabaseSchema {
  return { ...schema, rows: schema.rows.filter((r) => r.id !== rowId) };
}

export function updateCell(schema: DatabaseSchema, rowId: string, columnId: string, value: unknown): DatabaseSchema {
  return {
    ...schema,
    rows: schema.rows.map((r) => (r.id === rowId ? { ...r, [columnId]: value } : r)),
  };
}

export function addColumn(schema: DatabaseSchema, column: Column): DatabaseSchema {
  const rows = schema.rows.map((r) => ({ ...r, [column.id]: column.type === 'checkbox' ? false : '' }));
  return { ...schema, columns: [...schema.columns, column], rows };
}

export function deleteColumn(schema: DatabaseSchema, columnId: string): DatabaseSchema {
  const columns = schema.columns.filter((c) => c.id !== columnId);
  const rows = schema.rows.map((r) => {
    const newRow = { ...r };
    delete newRow[columnId];
    return newRow;
  });
  return { ...schema, columns, rows };
}

export function renameColumn(schema: DatabaseSchema, columnId: string, newName: string): DatabaseSchema {
  return {
    ...schema,
    columns: schema.columns.map((c) => (c.id === columnId ? { ...c, name: newName } : c)),
  };
}

export function duplicateRow(schema: DatabaseSchema, rowId: string): DatabaseSchema {
  const sourceRow = schema.rows.find((r) => r.id === rowId);
  if (!sourceRow) return schema;
  const newRow = { ...sourceRow, id: generateId() };
  const idx = schema.rows.findIndex((r) => r.id === rowId);
  const rows = [...schema.rows];
  rows.splice(idx + 1, 0, newRow);
  return { ...schema, rows };
}

export function reorderColumns(schema: DatabaseSchema, fromIndex: number, toIndex: number): DatabaseSchema {
  const cols = [...schema.columns];
  const [moved] = cols.splice(fromIndex, 1);
  cols.splice(toIndex, 0, moved);
  return { ...schema, columns: cols };
}

export function exportToCsv(schema: DatabaseSchema): string {
  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };
  const header = schema.columns.map((c) => escape(c.name)).join(',');
  const dataRows = schema.rows.map((row) =>
    schema.columns.map((c) => escape(String(row[c.id] ?? ''))).join(',')
  );
  return [header, ...dataRows].join('\n');
}

export function moveRow(schema: DatabaseSchema, rowId: string, targetColumnValue: string, kanbanColumnId: string): DatabaseSchema {
  return {
    ...schema,
    rows: schema.rows.map((r) =>
      r.id === rowId ? { ...r, [kanbanColumnId]: targetColumnValue } : r
    ),
  };
}

// ─── Sorting & Filtering ────────────────────────────────────

export function sortRows(rows: Row[], column: string, direction: 'asc' | 'desc'): Row[] {
  const sorted = [...rows].sort((a, b) => {
    const va = String(a[column] ?? '');
    const vb = String(b[column] ?? '');
    return va.localeCompare(vb);
  });
  return direction === 'desc' ? sorted.reverse() : sorted;
}

export function filterRows(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const val = String(row[f.column] ?? '');
      switch (f.operator) {
        case 'eq': return val === f.value;
        case 'neq': return val !== f.value;
        case 'contains': return val.includes(f.value || '');
        case 'empty': return val === '';
        case 'notEmpty': return val !== '';
        default: return true;
      }
    })
  );
}
