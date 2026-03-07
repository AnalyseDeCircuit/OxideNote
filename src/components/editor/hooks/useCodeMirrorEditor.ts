import { useRef, useEffect, useCallback } from 'react';
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  lineNumbers,
  highlightActiveLineGutter,
  type ViewUpdate,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { wikilinkExtension } from '../extensions/wikilink';

export interface UseCodeMirrorOptions {
  initialContent?: string;
  onChange?: (content: string) => void;
  onSave?: () => void;
  onNavigate?: (target: string) => void;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  tabSize?: number;
  wordWrap?: boolean;
}

// Compartments for runtime reconfiguration
const fontSizeCompartment = new Compartment();
const fontFamilyCompartment = new Compartment();
const lineHeightCompartment = new Compartment();
const tabSizeCompartment = new Compartment();
const wordWrapCompartment = new Compartment();

function makeFontSizeTheme(size: number) {
  return EditorView.theme({
    '.cm-content': { fontSize: `${size}px` },
    '.cm-gutters': { fontSize: `${size}px` },
  });
}

function makeFontFamilyTheme(family: string) {
  return EditorView.theme({
    '.cm-content': { fontFamily: family },
    '.cm-gutters': { fontFamily: family },
  });
}

function makeLineHeightTheme(lh: number) {
  return EditorView.theme({
    '.cm-content': { lineHeight: String(lh) },
  });
}

// Oxide theme: read colors from CSS variables
const oxideTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--bg-background)',
      color: 'var(--text-foreground)',
    },
    '.cm-content': {
      caretColor: 'var(--theme-accent)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--theme-accent)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: 'var(--theme-accent-transparent, rgba(99,102,241,0.15))',
      },
    '.cm-activeLine': {
      backgroundColor: 'var(--bg-surface, rgba(255,255,255,0.03))',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--bg-surface, rgba(255,255,255,0.03))',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-surface)',
      color: 'var(--text-muted-foreground)',
      border: 'none',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--bg-surface)',
      color: 'var(--text-muted-foreground)',
      border: 'none',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-surface)',
      border: '1px solid var(--theme-border)',
      color: 'var(--text-foreground)',
    },
    '.cm-tooltip-autocomplete': {
      '& > ul > li[aria-selected]': {
        backgroundColor: 'var(--theme-hover)',
      },
    },
    '.cm-panels': {
      backgroundColor: 'var(--bg-surface)',
      color: 'var(--text-foreground)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(255,200,0,0.15)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(255,200,0,0.3)',
    },
  },
  { dark: typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') !== 'light' }
);

export function useCodeMirrorEditor(options: UseCodeMirrorOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(options.onChange);
  const onSaveRef = useRef(options.onSave);
  const onNavigateRef = useRef(options.onNavigate);
  onChangeRef.current = options.onChange;
  onSaveRef.current = options.onSave;
  onNavigateRef.current = options.onNavigate;

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    });

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: options.initialContent ?? '',
      extensions: [
        // Core
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

        // Markdown
        markdown({ base: markdownLanguage }),

        // WikiLink decoration + Cmd/Ctrl+click navigation
        wikilinkExtension((target) => onNavigateRef.current?.(target)),

        // Theme
        oxideTheme,

        // Keymaps
        saveKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),

        // Compartments
        fontSizeCompartment.of(makeFontSizeTheme(options.fontSize ?? 14)),
        fontFamilyCompartment.of(
          makeFontFamilyTheme(
            options.fontFamily ?? "'SF Mono', 'Fira Code', monospace"
          )
        ),
        lineHeightCompartment.of(makeLineHeightTheme(options.lineHeight ?? 1.6)),
        tabSizeCompartment.of(EditorState.tabSize.of(options.tabSize ?? 2)),
        wordWrapCompartment.of(
          options.wordWrap !== false ? EditorView.lineWrapping : []
        ),

        // Listener
        updateListener,

        // Padding
        EditorView.contentAttributes.of({ style: 'padding: 16px 0' }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only on mount

  // Reconfigure font size
  useEffect(() => {
    if (viewRef.current && options.fontSize) {
      viewRef.current.dispatch({
        effects: fontSizeCompartment.reconfigure(
          makeFontSizeTheme(options.fontSize)
        ),
      });
    }
  }, [options.fontSize]);

  // Reconfigure font family
  useEffect(() => {
    if (viewRef.current && options.fontFamily) {
      viewRef.current.dispatch({
        effects: fontFamilyCompartment.reconfigure(
          makeFontFamilyTheme(options.fontFamily)
        ),
      });
    }
  }, [options.fontFamily]);

  // Reconfigure line height
  useEffect(() => {
    if (viewRef.current && options.lineHeight) {
      viewRef.current.dispatch({
        effects: lineHeightCompartment.reconfigure(
          makeLineHeightTheme(options.lineHeight)
        ),
      });
    }
  }, [options.lineHeight]);

  // Reconfigure tab size
  useEffect(() => {
    if (viewRef.current && options.tabSize) {
      viewRef.current.dispatch({
        effects: tabSizeCompartment.reconfigure(
          EditorState.tabSize.of(options.tabSize)
        ),
      });
    }
  }, [options.tabSize]);

  // Reconfigure word wrap
  useEffect(() => {
    if (viewRef.current && options.wordWrap !== undefined) {
      viewRef.current.dispatch({
        effects: wordWrapCompartment.reconfigure(
          options.wordWrap ? EditorView.lineWrapping : []
        ),
      });
    }
  }, [options.wordWrap]);

  // Method to set content programmatically (e.g., when loading a different note)
  const setContent = useCallback((content: string) => {
    if (viewRef.current) {
      const currentContent = viewRef.current.state.doc.toString();
      if (currentContent !== content) {
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: content,
          },
        });
      }
    }
  }, []);

  return { containerRef, viewRef, setContent };
}
