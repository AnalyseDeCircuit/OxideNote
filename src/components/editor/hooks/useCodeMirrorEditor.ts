import { useRef, useEffect, useCallback } from 'react';
import { useNoteStore } from '@/store/noteStore';
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
  LanguageSupport,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { typst as typstLanguage } from 'codemirror-lang-typst';
import { latexLanguage } from 'codemirror-lang-latex';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter } from '@codemirror/lint';
import { wikilinkExtension } from '../extensions/wikilink';
import { blockRefExtension, refreshBlockRefEffect } from '../extensions/blockRef';
import { wikilinkCompletionSource } from '../extensions/wikilinkCompletion';
import { tagCompletionSource } from '../extensions/tagCompletion';
import { slashCommandSource } from '../extensions/slashCommands';
import { typstCitationSource, latexCitationSource } from '../extensions/citationCompletion';
import { aiInlineExtension } from '../extensions/aiInline';

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
const themeCompartment = new Compartment();
const languageCompartment = new Compartment();
const completionCompartment = new Compartment();
const markdownExtensionsCompartment = new Compartment();
const lintCompartment = new Compartment();

/** Check if a file path refers to a Typst source file */
function isTypstFile(path: string | null): boolean {
  return path?.toLowerCase().endsWith('.typ') ?? false;
}

/** Check if a file path refers to a LaTeX source file */
function isLatexFile(path: string | null): boolean {
  return path?.toLowerCase().endsWith('.tex') ?? false;
}

/** Determine the CM6 language extension based on the file path. */
function languageForPath(path: string | null) {
  if (isTypstFile(path)) {
    return typstLanguage();
  }
  if (isLatexFile(path)) {
    // Use the raw LRLanguage instead of the package's helper wrapper.
    // The helper injects its own autocompletion config, which conflicts with
    // our editor-level autocompletion override when CodeMirror merges configs.
    return new LanguageSupport(latexLanguage);
  }
  return markdown({ base: markdownLanguage });
}

function completionConfigForPath(path: string | null) {
  return autocompletion({
    override: isTypstFile(path)
      ? [typstCitationSource]
      : isLatexFile(path)
        ? [latexCitationSource]
        : [wikilinkCompletionSource, tagCompletionSource, slashCommandSource],
  });
}

/** Detect if path is a typesetting source (Typst or LaTeX) — not Markdown */
function isTypesetFile(path: string | null): boolean {
  return isTypstFile(path) || isLatexFile(path);
}

/** Markdown-specific extensions (wikilinks, block refs, completions) — disabled for Typst/LaTeX */
function markdownExtensionsForPath(
  path: string | null,
  onNavigate: React.RefObject<((target: string) => void) | undefined>,
  getCurrentPath: () => string,
) {
  if (isTypesetFile(path)) return [];
  return [
    wikilinkExtension((target) => onNavigate.current?.(target)),
    blockRefExtension(getCurrentPath),
    aiInlineExtension(),
  ];
}

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

// Light themes list — shared with MarkdownPreview
const LIGHT_THEMES = ['paper-oxide', 'github-light', 'catppuccin-latte', 'solarized-light', 'gruvbox-light', 'rose-pine-dawn', 'hot-pink', 'spring-green'];

function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return true;
  const theme = document.documentElement.getAttribute('data-theme') || '';
  return !LIGHT_THEMES.includes(theme);
}

// Oxide theme: read colors from CSS variables
function makeOxideTheme(dark: boolean) {
  return EditorView.theme(
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
  { dark }
);
}

export function useCodeMirrorEditor(options: UseCodeMirrorOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(options.onChange);
  const onSaveRef = useRef(options.onSave);
  const onNavigateRef = useRef(options.onNavigate);
  const currentNotePathRef = useRef('');

  const activeTabPath = useNoteStore((state) => state.activeTabPath);
  onChangeRef.current = options.onChange;
  onSaveRef.current = options.onSave;
  onNavigateRef.current = options.onNavigate;

  useEffect(() => {
    const activePath = activeTabPath ?? '';
    currentNotePathRef.current = activePath;
  }, [activeTabPath]);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    // Debounce doc.toString() to reduce GC pressure on large documents.
    // On a 100KB file, toString() is O(n) — batching rapid keystrokes
    // reduces string allocations from N per keystroke to ~1 per 50ms.
    let changeTimer: ReturnType<typeof setTimeout> | undefined;

    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          if (viewRef.current) {
            onChangeRef.current?.(viewRef.current.state.doc.toString());
          }
        }, 50);
      }
      // Cursor position uses O(log n) B-tree lookup, no string conversion needed
      if (update.docChanged || update.selectionSet) {
        const pos = update.state.selection.main.head;
        const line = update.state.doc.lineAt(pos);
        useNoteStore.getState().setCursorPosition(line.number, pos - line.from + 1);
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
        completionCompartment.of(completionConfigForPath(activeTabPath)),
        EditorState.allowMultipleSelections.of(true),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

        // Language — dynamically resolved per file type
        languageCompartment.of(languageForPath(activeTabPath)),

        // Markdown-specific extensions — disabled for Typst files
        markdownExtensionsCompartment.of(
          markdownExtensionsForPath(activeTabPath, onNavigateRef, () => currentNotePathRef.current)
        ),

        // Lint gutter — shown for Typst/LaTeX to display compilation diagnostics
        lintCompartment.of(isTypesetFile(activeTabPath) ? lintGutter() : []),

        // Theme
        themeCompartment.of(makeOxideTheme(isDarkTheme())),

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

    // Watch for theme changes (data-theme attribute on <html>)
    const observer = new MutationObserver(() => {
      if (viewRef.current) {
        viewRef.current.dispatch({
          effects: themeCompartment.reconfigure(makeOxideTheme(isDarkTheme())),
        });
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      if (changeTimer) clearTimeout(changeTimer);
      observer.disconnect();
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

  // Reconfigure language and markdown-specific extensions when switching file types
  const prevFileTypeRef = useRef<'typst' | 'latex' | 'md'>(
    isTypstFile(activeTabPath) ? 'typst' : isLatexFile(activeTabPath) ? 'latex' : 'md',
  );
  useEffect(() => {
    if (!viewRef.current) return;
    const nowType = isTypstFile(activeTabPath) ? 'typst' as const
      : isLatexFile(activeTabPath) ? 'latex' as const
      : 'md' as const;
    // Only reconfigure if the language type actually changed
    if (nowType !== prevFileTypeRef.current) {
      prevFileTypeRef.current = nowType;
      viewRef.current.dispatch({
        effects: [
          languageCompartment.reconfigure(languageForPath(activeTabPath)),
          completionCompartment.reconfigure(completionConfigForPath(activeTabPath)),
          markdownExtensionsCompartment.reconfigure(
            markdownExtensionsForPath(activeTabPath, onNavigateRef, () => currentNotePathRef.current)
          ),
          lintCompartment.reconfigure(isTypesetFile(activeTabPath) ? lintGutter() : []),
        ],
      });
    }
  }, [activeTabPath]);

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

  const refreshBlockRefs = useCallback(() => {
    if (viewRef.current) {
      viewRef.current.dispatch({ effects: refreshBlockRefEffect.of(undefined) });
    }
  }, []);

  return { containerRef, viewRef, setContent, refreshBlockRefs };
}
