/**
 * BibTeX Citation Autocompletion Extension
 *
 * Provides citation key completion for academic documents:
 *   - In .typ files: triggers on `@` (Typst citation syntax)
 *   - In .tex files: triggers on `\cite{` (LaTeX citation syntax)
 *
 * Data sourced from .bib files found in the vault via `list_bib_entries`.
 */

import {
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import { listBibEntries } from '@/lib/api';

// Cache bib entries to avoid repeated vault scans
let cachedEntries: Completion[] = [];
let cacheTimestamp = 0;
const CACHE_TTL = 30_000; // 30s — bib files change infrequently

/**
 * Refresh the citation cache from the backend if stale.
 */
async function refreshCitationCache(): Promise<Completion[]> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL && cachedEntries.length > 0) {
    return cachedEntries;
  }

  try {
    const entries = await listBibEntries();
    cachedEntries = entries.map((e) => ({
      label: e.key,
      detail: e.year ? `(${e.year})` : undefined,
      info: [e.author, e.title].filter(Boolean).join(' — ') || undefined,
      type: 'text',
    }));
    cacheTimestamp = now;
  } catch {
    // Use stale cache on error
  }

  return cachedEntries;
}

/**
 * CompletionSource for Typst citation keys.
 * Activates when typing `@` followed by word characters in a .typ file.
 */
export async function typstCitationSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // Match @key pattern (Typst uses @citekey for citations)
  const match = context.matchBefore(/@[\w-]*/);
  if (!match) return null;

  // Don't trigger for bare `@` without explicit request
  if (match.text === '@' && !context.explicit) return null;

  const entries = await refreshCitationCache();
  if (entries.length === 0) return null;

  return {
    from: match.from + 1, // skip the `@` prefix
    options: entries,
    filter: true,
  };
}

/**
 * CompletionSource for LaTeX citation keys.
 * Activates inside \cite{...}, \citep{...}, \citet{...} etc.
 */
export async function latexCitationSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // Match \cite variants: \cite{partial, \citep{partial, \citet{partial, etc.
  const match = context.matchBefore(/\\cite[tp]?\{[\w,-]*$/);
  if (!match) return null;

  // Find the position after the last `{` or `,` for the current key
  const text = match.text;
  const lastSep = Math.max(text.lastIndexOf('{'), text.lastIndexOf(','));
  if (lastSep < 0) return null;

  const entries = await refreshCitationCache();
  if (entries.length === 0) return null;

  return {
    from: match.from + lastSep + 1,
    options: entries,
    filter: true,
  };
}
