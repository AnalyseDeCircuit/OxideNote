/**
 * PropertiesPanel — read-only YAML frontmatter viewer.
 *
 * Parses the `---` delimited frontmatter block from the active
 * note content and displays key-value pairs in a table layout.
 * Tags and aliases are displayed as chips.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNoteStore } from '@/store/noteStore';

/**
 * Parse YAML frontmatter from markdown content (simple key: value parser).
 * Limitations: does not handle nested objects, multi-line strings (| or >),
 * quoted values, or typed scalars (booleans/numbers are kept as strings).
 */
function parseFrontmatter(content: string): Record<string, string | string[]> | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;

  const yaml = content.substring(4, end);
  const result: Record<string, string | string[]> = {};

  let currentKey = '';
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item under current key
    if (trimmed.startsWith('- ') && currentKey) {
      const existing = result[currentKey];
      const val = trimmed.substring(2).trim();
      if (Array.isArray(existing)) {
        existing.push(val);
      } else {
        result[currentKey] = [val];
      }
      continue;
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();
      currentKey = key;
      if (value) {
        // Inline array: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          result[key] = value;
        }
      } else {
        // Value on next lines (array)
        result[key] = [];
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function PropertiesPanel() {
  const { t } = useTranslation();
  const activeContent = useNoteStore((s) => s.activeContent);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);

  const frontmatter = useMemo(() => parseFrontmatter(activeContent), [activeContent]);

  if (!activeTabPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">
        {t('outline.noNote')}
      </div>
    );
  }

  if (!frontmatter) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">
        {t('properties.empty')}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-2">
      <div className="text-xs font-medium text-muted-foreground mb-2">
        {t('properties.title')}
      </div>
      {Object.entries(frontmatter).map(([key, value]) => (
        <div key={key} className="flex items-start gap-2 text-sm">
          <span className="font-medium text-muted-foreground shrink-0 min-w-[60px]">{key}</span>
          <div className="flex-1 min-w-0">
            {Array.isArray(value) ? (
              <div className="flex flex-wrap gap-1">
                {value.map((v, i) => (
                  <span
                    key={i}
                    className="inline-block px-1.5 py-0.5 text-xs rounded bg-theme-bg-hover text-foreground"
                  >
                    {v}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-foreground break-words">{value}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
