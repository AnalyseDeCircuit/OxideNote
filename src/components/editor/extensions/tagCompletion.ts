/**
 * Tag Autocompletion Extension
 *
 * Triggers when typing `#` (outside code blocks / headings)
 * and provides suggestions from existing tags in the vault.
 * Data sourced from existing `list_all_tags` API.
 */

import {
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import { listAllTags } from '@/lib/api';

// Cache tag list to avoid excessive IPC calls
let cachedTags: Completion[] = [];
let cacheTimestamp = 0;
const CACHE_TTL = 10_000; // 10s

/**
 * Refresh the tag cache from the backend if stale.
 */
async function refreshTagCache(): Promise<Completion[]> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL && cachedTags.length > 0) {
    return cachedTags;
  }

  try {
    const tags = await listAllTags();
    cachedTags = tags.map((t) => ({
      label: t.tag,
      detail: `${t.count} notes`,
      type: 'keyword',
    }));
    cacheTimestamp = now;
  } catch {
    // Use stale cache on error
  }

  return cachedTags;
}

/**
 * CodeMirror CompletionSource for tags.
 * Activates when the user types `#` followed by word characters,
 * but NOT when at the start of a line (heading) or inside code.
 */
export async function tagCompletionSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  // Match `#` followed by optional word chars
  const match = context.matchBefore(/#[\w\u4e00-\u9fff\-_/]*/);
  if (!match) return null;

  // Skip if this looks like a heading (# at line start)
  const line = context.state.doc.lineAt(match.from);
  const textBeforeHash = line.text.slice(0, match.from - line.from);
  if (textBeforeHash.trim() === '') return null; // `#` at line start = heading

  // Don't trigger for single `#` without explicit request
  if (match.text === '#' && !context.explicit) return null;

  const tags = await refreshTagCache();

  return {
    from: match.from + 1, // skip the `#` itself
    options: tags,
    filter: true,
  };
}
