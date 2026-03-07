const INVALID_CHARS = /[/\\:*?"<>|]/;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;

export function validateFilename(name: string): 'empty' | 'invalid' | 'reserved' | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.') return 'empty';
  if (INVALID_CHARS.test(trimmed)) return 'invalid';
  // Check reserved names (with or without extension)
  const base = trimmed.replace(/\.[^.]+$/, '');
  if (WINDOWS_RESERVED.test(base)) return 'reserved';
  return null;
}
