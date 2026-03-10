import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Supported note file extensions — keep in sync with the Rust backend
export const NOTE_EXTENSIONS = ['.md', '.typ', '.tex'] as const;

// Regex matching any supported note extension at end of string
export const NOTE_EXT_RE = /\.(md|typ|tex)$/i;

/** Strip the note file extension from a file name to derive the display title */
export function stripNoteExtension(name: string): string {
  return name.replace(NOTE_EXT_RE, '');
}

/** Check whether a file name has a supported note extension */
export function isNoteFile(name: string): boolean {
  return NOTE_EXT_RE.test(name);
}
