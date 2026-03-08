/**
 * PDF Annotation Data Model & Persistence
 *
 * Annotations are stored per-PDF in:
 *   <vault>/.oxidenote/annotations/<hash-of-path>.json
 *
 * Supports highlight and underline types with optional notes.
 */

import { readNote, writeNote } from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────

export interface PdfAnnotation {
  id: string;
  page: number;
  type: 'highlight' | 'underline';
  /** Normalized rectangles (relative to page dimensions, 0-1 range) */
  rects: AnnotationRect[];
  color: string;
  note: string;
  selectedText: string;
  createdAt: string;
}

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnnotationStore {
  annotations: PdfAnnotation[];
}

// ─── Persistence ─────────────────────────────────────────────

/** Generate a simple hash for a file path to use as annotation filename */
function hashPath(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    const ch = path.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function annotationFilePath(pdfPath: string): string {
  return `.oxidenote/annotations/${hashPath(pdfPath)}.json`;
}

/** Load annotations for a PDF file */
export async function loadAnnotations(pdfPath: string): Promise<PdfAnnotation[]> {
  try {
    const note = await readNote(annotationFilePath(pdfPath));
    const data = JSON.parse(note.content) as AnnotationStore;
    return data.annotations;
  } catch {
    return [];
  }
}

/** Save annotations for a PDF file */
export async function saveAnnotations(pdfPath: string, annotations: PdfAnnotation[]): Promise<void> {
  const data: AnnotationStore = { annotations };
  const json = JSON.stringify(data, null, 2);
  await writeNote(annotationFilePath(pdfPath), json);
}

/** Generate a unique annotation ID */
export function generateAnnotationId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Export annotations as Markdown content */
export function exportAnnotationsAsMarkdown(pdfPath: string, annotations: PdfAnnotation[]): string {
  const title = pdfPath.replace(/\.pdf$/i, '').split('/').pop() || 'PDF';
  const lines: string[] = [
    `# ${title} — Annotations`,
    '',
    `> Source: ${pdfPath}`,
    `> Exported: ${new Date().toISOString().slice(0, 19)}`,
    '',
  ];

  // Group by page
  const byPage = new Map<number, PdfAnnotation[]>();
  for (const a of annotations) {
    const list = byPage.get(a.page) || [];
    list.push(a);
    byPage.set(a.page, list);
  }

  for (const [page, pageAnnotations] of Array.from(byPage.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(`## Page ${page + 1}`, '');
    for (const a of pageAnnotations) {
      const icon = a.type === 'highlight' ? '🟡' : '📝';
      lines.push(`${icon} **${a.selectedText}**`);
      if (a.note) {
        lines.push(`> ${a.note}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
