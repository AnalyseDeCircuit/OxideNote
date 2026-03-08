/**
 * Preview Content Cache — shared cache for block refs and note embeds
 *
 * Provides a TTL-based in-memory cache that avoids redundant API calls
 * when the MarkdownPreview re-renders. Entries auto-expire after 30s
 * and are invalidated immediately when `vault:file-changed` fires for
 * the relevant note path.
 *
 * Usage:
 *   import { blockRefCache, noteEmbedCache, initPreviewCacheInvalidation } from '@/lib/previewCache';
 *   blockRefCache.get(key)  / blockRefCache.set(key, value)
 *   noteEmbedCache.get(key) / noteEmbedCache.set(key, value)
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ── TTL Cache ───────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiry: number;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES = 200;

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttl: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    // Promote to most-recent for LRU eviction order
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest entries if cache is too large
    if (this.store.size >= MAX_ENTRIES) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiry: Date.now() + this.ttl });
  }

  /** Invalidate all entries whose key starts with the given prefix */
  invalidateByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Shared cache instances ──────────────────────────────────

/** Cache for block ref content: key = "notePath\0blockId" */
export const blockRefCache = new TtlCache<string | null>();

/** Cache for note name → resolved {path, title}: key = noteName */
export const noteResolveCache = new TtlCache<{ path: string; title: string }>();

/** Cache for note embed data: key = notePath */
export const noteEmbedCache = new TtlCache<{ title: string; html: string }>();

// ── Cache key helpers ───────────────────────────────────────

export function blockRefKey(notePath: string, blockId: string): string {
  return `${notePath}\0${blockId}`;
}

// ── Vault change invalidation ───────────────────────────────

let unlisten: UnlistenFn | null = null;

/** Clear all preview caches (call on vault switch) */
export function clearAllPreviewCaches(): void {
  blockRefCache.clear();
  noteResolveCache.clear();
  noteEmbedCache.clear();
}

/**
 * Start listening for vault file changes and invalidate cache entries
 * whose note path matches the changed file. Returns a cleanup function.
 */
export async function initPreviewCacheInvalidation(): Promise<() => void> {
  // Stop previous listener if any
  if (unlisten) {
    unlisten();
    unlisten = null;
  }

  clearAllPreviewCaches();

  unlisten = await listen<{ kind: string; path: string }>(
    'vault:file-changed',
    (event) => {
      const changedPath = event.payload.path;
      if (!changedPath) return;

      // Invalidate block ref entries for this note
      blockRefCache.invalidateByPrefix(changedPath);

      // Invalidate note embed for this path
      noteEmbedCache.invalidateByPrefix(changedPath);

      // Invalidate resolved names that point to this path
      // (conservative: note rename may change resolution)
      noteResolveCache.clear();
    },
  );

  return () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    clearAllPreviewCaches();
  };
}
