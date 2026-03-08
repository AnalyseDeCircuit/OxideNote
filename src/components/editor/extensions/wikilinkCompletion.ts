/**
 * WikiLink Autocompletion Extension
 *
 * Triggers when typing `[[` and provides a fuzzy-match list of note names
 * from the vault. Also supports heading sub-completion after `#`.
 * Data sourced from existing `search_by_filename` + `readNote` APIs.
 */

import {
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import { searchByFilename, readNote } from '@/lib/api';

// Debounce tracking for API calls
let lastQuery = '';
let lastResults: Completion[] = [];
let fetchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Extract headings from markdown content for sub-completion.
 * Returns heading text without the `#` prefix.
 */
function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push(match[2].trim());
    }
  }
  return headings;
}

/**
 * CodeMirror CompletionSource for WikiLinks.
 * Activates when the user types `[[` and provides note name suggestions.
 * After typing `#`, provides heading suggestions for the selected note.
 */
export async function wikilinkCompletionSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  // Find the start of the wikilink — look for `[[` before cursor
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  // Check if we're inside a wikilink — find last unmatched `[[`
  const lastOpen = textBefore.lastIndexOf('[[');
  if (lastOpen === -1) return null;

  // Make sure there's no `]]` between `[[` and cursor
  const afterOpen = textBefore.slice(lastOpen + 2);
  if (afterOpen.includes(']]')) return null;

  // The content between [[ and cursor is the query
  const fullQuery = afterOpen;
  const from = line.from + lastOpen + 2;

  // Check if query contains `#` for heading sub-completion
  const hashIndex = fullQuery.indexOf('#');

  if (hashIndex >= 0) {
    // Heading sub-completion: [[noteName#heading
    const noteName = fullQuery.slice(0, hashIndex);
    const headingQuery = fullQuery.slice(hashIndex + 1).toLowerCase();

    try {
      // Find the note file
      const results = await searchByFilename(noteName);
      if (results.length === 0) return null;

      // Pick exact match or first result
      const targetLower = noteName.toLowerCase();
      const exact = results.find((r) => {
        const stem = r.path.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
        return stem === targetLower || r.path.toLowerCase() === targetLower;
      });
      const best = exact ?? results[0];

      // Read note content and extract headings
      const noteContent = await readNote(best.path);
      const headings = extractHeadings(noteContent.content);

      const options: Completion[] = headings
        .filter((h) => h.toLowerCase().includes(headingQuery))
        .map((h) => ({
          label: `${noteName}#${h}`,
          detail: '§ heading',
          apply: `${noteName}#${h}]]`,
        }));

      return {
        from,
        options,
        filter: false,
      };
    } catch {
      return null;
    }
  }

  // Normal note name completion
  const query = fullQuery.split('|')[0].trim(); // handle [[target|display syntax

  // Don't fetch for empty query — too many results
  if (!query && !context.explicit) return null;

  try {
    // Reuse cached results if query prefix matches
    if (query !== lastQuery) {
      lastQuery = query;
      if (fetchTimer) clearTimeout(fetchTimer);
      const results = await searchByFilename(query || '');
      lastResults = results.map((r) => {
        const stem = r.path.replace(/\.md$/i, '').split('/').pop() || r.path;
        return {
          label: stem,
          detail: r.path,
          apply: `${stem}]]`,
        };
      });
    }

    return {
      from,
      options: lastResults,
      filter: true,
    };
  } catch {
    return null;
  }
}
