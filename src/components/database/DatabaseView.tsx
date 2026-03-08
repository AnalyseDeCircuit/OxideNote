/**
 * DatabaseView — Entry component for database-style note rendering
 *
 * Detects `oxide-db-json` in note frontmatter and renders an interactive
 * database view (table / kanban / calendar) with CRUD operations.
 *
 * Data is persisted back to the note's frontmatter via writeNote.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DatabaseSchema } from '@/lib/database';
import {
  parseDatabaseFromContent,
  serializeDatabaseToContent,
  createDefaultSchema,
  addRow,
} from '@/lib/database';
import { writeNote, reindexNote } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { DatabaseToolbar } from './DatabaseToolbar';
import { TableView } from './TableView';
import { KanbanView } from './KanbanView';
import { CalendarView } from './CalendarView';

interface DatabaseViewProps {
  content: string;
  filePath: string;
}

export function DatabaseView({ content, filePath }: DatabaseViewProps) {
  const { t } = useTranslation();

  // Parse the database schema from the note content
  const [schema, setSchema] = useState<DatabaseSchema>(() => {
    return parseDatabaseFromContent(content) || createDefaultSchema();
  });

  // Track whether the last content change was self-triggered (by our own save)
  const selfSaveRef = useRef(false);
  // Track latest content for use in callbacks (avoids stale closure)
  const contentRef = useRef(content);
  contentRef.current = content;

  // Re-parse when external content changes (e.g. file reloaded from disk)
  useEffect(() => {
    // Skip re-parsing if this content change was triggered by our own save
    if (selfSaveRef.current) {
      selfSaveRef.current = false;
      return;
    }
    const parsed = parseDatabaseFromContent(content);
    if (parsed) {
      setSchema(parsed);
    }
  }, [content]);

  // Persist schema changes back to the note file
  const handleSchemaChange = useCallback(async (newSchema: DatabaseSchema) => {
    setSchema(newSchema);

    // Use ref to get the latest content, avoiding stale closure issues
    const updatedContent = serializeDatabaseToContent(contentRef.current, newSchema);
    // Mark the next content change as self-triggered to prevent re-parse loop
    selfSaveRef.current = true;
    try {
      await writeNote(filePath, updatedContent);
      await reindexNote(filePath);
      // Update the in-memory content via noteStore
      useNoteStore.getState().setActiveContent(updatedContent);
      // Keep contentRef in sync
      contentRef.current = updatedContent;
    } catch {
      // Save failed — schema is still updated in-memory
      selfSaveRef.current = false;
    }
  }, [filePath]);

  // Handle adding a new row
  const handleAddRow = useCallback(() => {
    handleSchemaChange(addRow(schema));
  }, [schema, handleSchemaChange]);

  // View switching
  const handleViewChange = useCallback((view: DatabaseSchema['view']) => {
    handleSchemaChange({ ...schema, view });
  }, [schema, handleSchemaChange]);

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      <DatabaseToolbar
        view={schema.view}
        onViewChange={handleViewChange}
        onAddRow={handleAddRow}
        schema={schema}
        onSchemaChange={handleSchemaChange}
      />

      {schema.view === 'table' && (
        <TableView schema={schema} onSchemaChange={handleSchemaChange} />
      )}
      {schema.view === 'kanban' && (
        <KanbanView schema={schema} onSchemaChange={handleSchemaChange} />
      )}
      {schema.view === 'calendar' && (
        <CalendarView schema={schema} onSchemaChange={handleSchemaChange} />
      )}
    </div>
  );
}

/**
 * Check if a note content contains a database schema.
 * Used by NoteEditor to decide whether to show DatabaseView.
 */
export function isDatabaseNote(content: string): boolean {
  return content.includes('oxide-db-json:');
}
