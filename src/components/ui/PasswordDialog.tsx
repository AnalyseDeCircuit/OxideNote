/**
 * PasswordDialog — secure password input dialog using Radix Dialog.
 *
 * Provides `promptPassword()` and `promptPasswordWithConfirm()` functions
 * that return a Promise<string | null>, usable from non-React code like commandRegistry.
 * Uses <input type="password"> to mask input (unlike window.prompt).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';

// ── Store for dialog state (bridge between imperative API and React) ──

interface PasswordDialogState {
  open: boolean;
  title: string;
  needConfirm: boolean;
  resolve: ((value: string | null) => void) | null;
  show: (title: string, needConfirm: boolean) => Promise<string | null>;
  close: (value: string | null) => void;
}

const usePasswordDialogStore = create<PasswordDialogState>((set, get) => ({
  open: false,
  title: '',
  needConfirm: false,
  resolve: null,
  show: (title, needConfirm) => {
    return new Promise<string | null>((resolve) => {
      set({ open: true, title, needConfirm, resolve });
    });
  },
  close: (value) => {
    const { resolve } = get();
    if (resolve) resolve(value);
    set({ open: false, resolve: null });
  },
}));

// ── Imperative API for use in commandRegistry ────────────────

/** Prompt user for a password (masked input). Returns null if cancelled. */
export function promptPassword(title: string): Promise<string | null> {
  return usePasswordDialogStore.getState().show(title, false);
}

/** Prompt for password + confirmation. Returns null if cancelled or mismatch handled internally. */
export function promptPasswordWithConfirm(title: string): Promise<string | null> {
  return usePasswordDialogStore.getState().show(title, true);
}

// ── React component (mount once in App.tsx or AppShell) ──────

export function PasswordDialog() {
  const { t } = useTranslation();
  const { open, title, needConfirm, close } = usePasswordDialogStore();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPassword('');
      setConfirm('');
      setError('');
      // Focus the input after dialog animation
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (!password) return;
    if (needConfirm && password !== confirm) {
      setError(t('crypto.passwordMismatch'));
      return;
    }
    close(password);
  }, [password, confirm, needConfirm, close, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(null); }}>
      <DialogContent className="max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3 space-y-3">
          <input
            ref={inputRef}
            type="password"
            placeholder={t('crypto.enterPassword')}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            className="w-full px-3 py-2 text-sm rounded border border-theme-border bg-theme-bg text-foreground outline-none focus:ring-1 focus:ring-theme-accent"
            autoComplete="off"
          />
          {needConfirm && (
            <input
              type="password"
              placeholder={t('crypto.confirmPassword')}
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              className="w-full px-3 py-2 text-sm rounded border border-theme-border bg-theme-bg text-foreground outline-none focus:ring-1 focus:ring-theme-accent"
              autoComplete="off"
            />
          )}
          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
        </div>
        <DialogFooter>
          <button
            onClick={() => close(null)}
            className="px-3 py-1.5 text-sm rounded border border-theme-border text-foreground hover:bg-theme-bg-hover"
          >
            {t('actions.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!password}
            className="px-3 py-1.5 text-sm rounded bg-theme-accent text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('actions.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
