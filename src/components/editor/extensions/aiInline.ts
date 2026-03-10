/**
 * Inline AI extension for CodeMirror.
 *
 * Provides two core capabilities:
 * 1. Selection action menu — transform selected text (rewrite, translate, summarize, etc.)
 * 2. Ghost text continuation — generate text continuation at the cursor position
 *
 * AI results appear as inline decorations that can be accepted (Tab/Enter)
 * or rejected (Escape). Uses the shared llm/client.rs backend via Tauri commands.
 */

import {
  StateField,
  StateEffect,
  type EditorState,
  type Transaction,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { inlineAiTransform, inlineAiContinue } from '@/lib/api';
import type { ChatConfig } from '@/lib/api';

// ── State effects for controlling inline AI ─────────────────

/** Trigger an AI transform on the current selection */
export const startAiTransform = StateEffect.define<{
  instruction: string;
  from: number;
  to: number;
}>();

/** Trigger AI continuation at cursor */
export const startAiContinue = StateEffect.define<null>();

/** Set the AI result to display as an inline diff/ghost text */
export const setAiResult = StateEffect.define<{
  from: number;
  to: number;
  original: string;
  replacement: string;
  mode: 'transform' | 'continue';
}>();

/** Accept the current AI result */
export const acceptAiResult = StateEffect.define<null>();

/** Reject / dismiss the current AI result */
export const rejectAiResult = StateEffect.define<null>();

/** Set loading state */
export const setAiLoading = StateEffect.define<boolean>();

// ── AI result state ─────────────────────────────────────────

interface AiResultState {
  /** Whether an AI operation is in progress */
  loading: boolean;
  /** The pending result, if any */
  pending: {
    from: number;
    to: number;
    original: string;
    replacement: string;
    mode: 'transform' | 'continue';
  } | null;
}

const emptyState: AiResultState = { loading: false, pending: null };

/** StateField tracking the current inline AI operation */
export const aiResultField = StateField.define<AiResultState>({
  create: () => emptyState,
  update(value: AiResultState, tr: Transaction) {
    for (const effect of tr.effects) {
      if (effect.is(setAiResult)) {
        return { loading: false, pending: effect.value };
      }
      if (effect.is(acceptAiResult) || effect.is(rejectAiResult)) {
        return emptyState;
      }
      if (effect.is(setAiLoading)) {
        return { ...value, loading: effect.value };
      }
    }
    // If the document changed while we have a pending result, invalidate it
    if (tr.docChanged && value.pending) {
      return emptyState;
    }
    return value;
  },
});

// ── Ghost text widget ───────────────────────────────────────

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ai-ghost-text';
    span.textContent = this.text;
    span.style.opacity = '0.4';
    span.style.fontStyle = 'italic';
    span.style.pointerEvents = 'none';
    return span;
  }

  eq(other: GhostTextWidget): boolean {
    return this.text === other.text;
  }
}

// ── Replacement preview widget ──────────────────────────────

class ReplacementWidget extends WidgetType {
  constructor(
    readonly original: string,
    readonly replacement: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-ai-replacement-preview';

    // Strikethrough original
    const del = document.createElement('span');
    del.className = 'cm-ai-deleted';
    del.textContent = this.original;
    del.style.textDecoration = 'line-through';
    del.style.opacity = '0.5';
    del.style.color = 'var(--color-red-500, #ef4444)';

    // Inserted replacement
    const ins = document.createElement('span');
    ins.className = 'cm-ai-inserted';
    ins.textContent = this.replacement;
    ins.style.backgroundColor = 'var(--color-green-500-alpha, rgba(34, 197, 94, 0.15))';
    ins.style.borderRadius = '2px';

    // Hint text
    const hint = document.createElement('span');
    hint.className = 'cm-ai-hint';
    hint.textContent = ' Tab ✓  Esc ✗';
    hint.style.opacity = '0.4';
    hint.style.fontSize = '0.75em';
    hint.style.marginLeft = '8px';

    container.appendChild(del);
    container.appendChild(document.createElement('br'));
    container.appendChild(ins);
    container.appendChild(hint);
    return container;
  }

  eq(other: ReplacementWidget): boolean {
    return this.original === other.original && this.replacement === other.replacement;
  }
}

// ── Loading indicator widget ────────────────────────────────

class LoadingWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ai-loading';
    span.textContent = '  ⟳ AI...';
    span.style.opacity = '0.5';
    span.style.fontStyle = 'italic';
    span.style.animation = 'pulse 1.5s ease-in-out infinite';
    return span;
  }

  eq(): boolean {
    return true;
  }
}

// ── Decoration provider ─────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const aiState = state.field(aiResultField);

  if (aiState.loading) {
    const cursor = state.selection.main.head;
    return Decoration.set([
      Decoration.widget({ widget: new LoadingWidget(), side: 1 }).range(cursor),
    ]);
  }

  if (!aiState.pending) return Decoration.none;

  const { from, to, original, replacement, mode } = aiState.pending;

  if (mode === 'continue') {
    // Ghost text at cursor
    return Decoration.set([
      Decoration.widget({
        widget: new GhostTextWidget(replacement),
        side: 1,
      }).range(to),
    ]);
  }

  // Transform mode: show inline diff
  return Decoration.set([
    Decoration.widget({
      widget: new ReplacementWidget(original, replacement),
      side: 1,
      block: true,
    }).range(to),
  ]);
}

const aiDecorations = EditorView.decorations.compute([aiResultField], (state) =>
  buildDecorations(state),
);

// ── Keybindings ─────────────────────────────────────────────

const aiKeymap = keymap.of([
  {
    key: 'Tab',
    run: (view) => {
      const aiState = view.state.field(aiResultField);
      if (!aiState.pending) return false;

      const { from, to, replacement, mode } = aiState.pending;

      if (mode === 'continue') {
        // Insert continuation at cursor
        view.dispatch({
          changes: { from: to, to, insert: replacement },
          selection: { anchor: to + replacement.length },
          effects: acceptAiResult.of(null),
        });
      } else {
        // Replace original with transformed text
        view.dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + replacement.length },
          effects: acceptAiResult.of(null),
        });
      }
      return true;
    },
  },
  {
    key: 'Enter',
    run: (view) => {
      const aiState = view.state.field(aiResultField);
      if (!aiState.pending) return false;

      const { from, to, replacement, mode } = aiState.pending;

      if (mode === 'continue') {
        view.dispatch({
          changes: { from: to, to, insert: replacement },
          selection: { anchor: to + replacement.length },
          effects: acceptAiResult.of(null),
        });
      } else {
        view.dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + replacement.length },
          effects: acceptAiResult.of(null),
        });
      }
      return true;
    },
  },
  {
    key: 'Escape',
    run: (view) => {
      const aiState = view.state.field(aiResultField);
      if (!aiState.pending && !aiState.loading) return false;
      view.dispatch({ effects: rejectAiResult.of(null) });
      return true;
    },
  },
]);

// ── Public API ──────────────────────────────────────────────

/**
 * Trigger an AI transform on the current selection.
 *
 * Reads the selected text, sends it to the backend with the instruction,
 * and displays the result as an inline diff decoration.
 */
export async function triggerAiTransform(
  view: EditorView,
  instruction: string,
  config: ChatConfig,
  noteTitle: string,
  fileExt: string = 'md',
): Promise<void> {
  const { from, to } = view.state.selection.main;
  if (from === to) return; // No selection

  const selectedText = view.state.doc.sliceString(from, to);

  // Get surrounding context (up to 500 chars before and after selection)
  const contextStart = Math.max(0, from - 500);
  const contextEnd = Math.min(view.state.doc.length, to + 500);
  const context = view.state.doc.sliceString(contextStart, contextEnd);

  // Show loading state
  view.dispatch({ effects: setAiLoading.of(true) });

  try {
    const result = await inlineAiTransform(selectedText, instruction, context, noteTitle, fileExt, config);
    view.dispatch({
      effects: setAiResult.of({
        from,
        to,
        original: selectedText,
        replacement: result,
        mode: 'transform',
      }),
    });
  } catch (err) {
    view.dispatch({ effects: rejectAiResult.of(null) });
    throw err; // Let caller handle the error toast
  }
}

/**
 * Trigger AI text continuation at the current cursor position.
 *
 * Reads up to 2000 chars before the cursor and asks the LLM to continue.
 * The result appears as ghost text that can be accepted with Tab.
 */
export async function triggerAiContinue(
  view: EditorView,
  config: ChatConfig,
  noteTitle: string,
): Promise<void> {
  const cursor = view.state.selection.main.head;

  // Get preceding text (up to 2000 chars)
  const start = Math.max(0, cursor - 2000);
  const precedingText = view.state.doc.sliceString(start, cursor);

  // Show loading state
  view.dispatch({ effects: setAiLoading.of(true) });

  try {
    const result = await inlineAiContinue(precedingText, noteTitle, config);
    view.dispatch({
      effects: setAiResult.of({
        from: cursor,
        to: cursor,
        original: '',
        replacement: result,
        mode: 'continue',
      }),
    });
  } catch (err) {
    view.dispatch({ effects: rejectAiResult.of(null) });
    throw err;
  }
}

// ── Extension bundle ────────────────────────────────────────

/**
 * Returns the CodeMirror extension bundle for inline AI features.
 * Includes state field, decorations, and keybindings.
 */
export function aiInlineExtension(): Extension {
  return [aiResultField, aiDecorations, aiKeymap];
}
