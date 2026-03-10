/**
 * formatAdapter — Unified text formatting abstraction for Markdown, Typst, and LaTeX.
 *
 * Each adapter defines how to produce inline wraps (bold, italic, code, etc.),
 * line prefixes (headings, quotes, lists), and block insertions (tables, math,
 * links, images, horizontal rules) for a specific markup language.
 *
 * The EditorToolbar uses these adapters to apply the correct syntax based on
 * the current file extension, enabling a single toolbar UI for all languages.
 */

import type { EditorView } from '@codemirror/view';

// ── Core types ──────────────────────────────────────────────

/** Inline wrap definition: prefix + suffix around selected text */
export interface WrapDef {
  prefix: string;
  suffix: string;
  placeholder: string;
}

/** Heading definition per level (1-6) */
export interface HeadingDef {
  /** Regex to detect existing heading at line start */
  pattern: RegExp;
  /** The prefix string to insert (e.g. "# ", "= ") */
  prefix: string;
}

/** Block insertion: a raw string to insert at cursor */
export type BlockInsert = string;

/**
 * Format adapter interface — one implementation per markup language.
 * Each method returns the syntax-specific primitives that the toolbar
 * engine uses to manipulate the CodeMirror document.
 */
export interface FormatAdapter {
  readonly lang: 'md' | 'typ' | 'tex';

  // ── Inline wraps ──────────────────────────────────────────
  bold: WrapDef;
  italic: WrapDef;
  strikethrough: WrapDef;
  inlineCode: WrapDef;
  inlineMath: WrapDef;

  // ── Headings ──────────────────────────────────────────────
  heading(level: number): HeadingDef;

  // ── Line prefixes ────────────────────────────────────────
  quote: string;
  unorderedList: string;
  orderedList: string;

  // ── Block insertions ──────────────────────────────────────
  horizontalRule: BlockInsert;
  table: BlockInsert;
  mathBlock: BlockInsert;
  link(text: string, url: string): BlockInsert;
  image(alt: string, url: string): BlockInsert;
  codeBlock(lang: string): BlockInsert;
}

// ── Markdown adapter ────────────────────────────────────────

const markdownAdapter: FormatAdapter = {
  lang: 'md',

  bold:          { prefix: '**', suffix: '**', placeholder: 'bold' },
  italic:        { prefix: '*',  suffix: '*',  placeholder: 'italic' },
  strikethrough: { prefix: '~~', suffix: '~~', placeholder: 'text' },
  inlineCode:    { prefix: '`',  suffix: '`',  placeholder: 'code' },
  inlineMath:    { prefix: '$',  suffix: '$',  placeholder: 'x^2' },

  heading(level: number) {
    const hashes = '#'.repeat(level);
    return {
      pattern: new RegExp(`^#{1,6}\\s`),
      prefix: `${hashes} `,
    };
  },

  quote: '> ',
  unorderedList: '- ',
  orderedList: '1. ',

  horizontalRule: '\n---\n',
  table: '\n| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n|          |          |          |\n',
  mathBlock: '\n$$\nE = mc^2\n$$\n',
  link: (text, url) => `[${text}](${url})`,
  image: (alt, url) => `![${alt}](${url})`,
  codeBlock: (lang) => `\n\`\`\`${lang}\n\n\`\`\`\n`,
};

// ── Typst adapter ───────────────────────────────────────────

const typstAdapter: FormatAdapter = {
  lang: 'typ',

  // Typst uses *bold* for strong, _italic_ for emphasis
  bold:          { prefix: '*',  suffix: '*',  placeholder: 'bold' },
  italic:        { prefix: '_',  suffix: '_',  placeholder: 'italic' },
  strikethrough: { prefix: '#strike[', suffix: ']', placeholder: 'text' },
  inlineCode:    { prefix: '`',  suffix: '`',  placeholder: 'code' },
  inlineMath:    { prefix: '$',  suffix: '$',  placeholder: 'x^2' },

  heading(level: number) {
    const equals = '='.repeat(level);
    return {
      pattern: new RegExp(`^={1,6}\\s`),
      prefix: `${equals} `,
    };
  },

  // Typst #quote[] requires closing bracket; insert as complete block
  quote: '\n#quote[\n  \n]\n',
  unorderedList: '- ',
  orderedList: '+ ',

  horizontalRule: '\n#line(length: 100%)\n',
  table: '\n#table(\n  columns: 3,\n  [Header 1], [Header 2], [Header 3],\n  [], [], [],\n)\n',
  mathBlock: '\n$ E = m c^2 $\n',
  link: (text, url) => `#link("${url}")[${text}]`,
  image: (alt, url) => `#figure(\n  image("${url}"),\n  caption: [${alt}],\n)`,
  codeBlock: (lang) => `\n\`\`\`${lang}\n\n\`\`\`\n`,
};

// ── LaTeX adapter ───────────────────────────────────────────

const latexAdapter: FormatAdapter = {
  lang: 'tex',

  bold:          { prefix: '\\textbf{', suffix: '}', placeholder: 'bold' },
  italic:        { prefix: '\\textit{', suffix: '}', placeholder: 'italic' },
  strikethrough: { prefix: '\\sout{',   suffix: '}', placeholder: 'text' },
  inlineCode:    { prefix: '\\texttt{', suffix: '}', placeholder: 'code' },
  inlineMath:    { prefix: '$',         suffix: '$', placeholder: 'x^2' },

  heading(level: number) {
    const commands: Record<number, string> = {
      1: '\\section',
      2: '\\subsection',
      3: '\\subsubsection',
      4: '\\paragraph',
      5: '\\subparagraph',
      6: '\\subparagraph',
    };
    const cmd = commands[level] || commands[6];
    return {
      // Match \section{...}, \subsection{...}, etc. at line start
      pattern: new RegExp(`^\\\\(?:sub)*(?:section|paragraph)\\{`),
      prefix: `${cmd}{`,
    };
  },

  // LaTeX environments require begin/end; insert as complete blocks
  quote: '\n\\begin{quote}\n  \n\\end{quote}\n',
  unorderedList: '\n\\begin{itemize}\n  \\item \n\\end{itemize}\n',
  orderedList: '\n\\begin{enumerate}\n  \\item \n\\end{enumerate}\n',

  horizontalRule: '\n\\noindent\\rule{\\textwidth}{0.4pt}\n',
  table: '\n\\begin{tabular}{|c|c|c|}\n\\hline\nCol 1 & Col 2 & Col 3 \\\\\n\\hline\n & & \\\\\n\\hline\n\\end{tabular}\n',
  mathBlock: '\n\\[\nE = mc^2\n\\]\n',
  link: (text, url) => `\\href{${url}}{${text}}`,
  image: (alt, url) => `\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{${url}}\n\\caption{${alt}}\n\\end{figure}`,
  codeBlock: (lang) => `\n\\begin{lstlisting}[language=${lang}]\n\n\\end{lstlisting}\n`,
};

// ── Adapter factory ─────────────────────────────────────────

const ADAPTERS: Record<string, FormatAdapter> = {
  md: markdownAdapter,
  typ: typstAdapter,
  tex: latexAdapter,
  // Fallback: treat unknown as Markdown
  markdown: markdownAdapter,
};

/** Get the format adapter for a given file extension */
export function getFormatAdapter(ext: string): FormatAdapter {
  return ADAPTERS[ext] || markdownAdapter;
}

// ── Toolbar engine — operates on CodeMirror via adapter defs ─

/**
 * Wrap or unwrap selected text with prefix/suffix.
 * If already wrapped, removes the wrapping (toggle behavior).
 * If nothing is selected, inserts placeholder and selects it.
 */
export function wrapSelection(view: EditorView, def: WrapDef): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  // Check surrounding text for existing wrapping
  const beforeFrom = Math.max(0, from - def.prefix.length);
  const afterTo = Math.min(view.state.doc.length, to + def.suffix.length);
  const before = view.state.sliceDoc(beforeFrom, from);
  const after = view.state.sliceDoc(to, afterTo);

  if (before === def.prefix && after === def.suffix) {
    // Toggle OFF: remove the wrapping
    view.dispatch({
      changes: [
        { from: beforeFrom, to: from, insert: '' },
        { from: to, to: afterTo, insert: '' },
      ],
      selection: { anchor: beforeFrom, head: beforeFrom + selected.length },
    });
  } else {
    // Toggle ON: wrap the selection
    const text = selected || def.placeholder;
    const wrapped = `${def.prefix}${text}${def.suffix}`;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: { anchor: from + def.prefix.length, head: from + def.prefix.length + text.length },
    });
  }
  view.focus();
}

/**
 * Insert a line prefix (for headings, quotes, lists).
 * Inserts at the beginning of the current line.
 */
export function insertLinePrefix(view: EditorView, prefix: string): void {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix },
  });
  view.focus();
}

/**
 * Toggle heading level — removes existing heading prefix before inserting new one.
 * If the same level is already applied, removes it entirely.
 */
export function toggleHeading(view: EditorView, adapter: FormatAdapter, level: number): void {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const lineText = view.state.sliceDoc(line.from, line.to);
  const def = adapter.heading(level);

  const match = lineText.match(def.pattern);
  if (match) {
    const existingPrefix = match[0];
    if (adapter.lang === 'md') {
      // Markdown: compare # count
      const existingLevel = existingPrefix.replace(/\s$/, '').length;
      if (existingLevel === level) {
        // Same level → remove
        view.dispatch({ changes: { from: line.from, to: line.from + existingPrefix.length, insert: '' } });
      } else {
        // Different level → replace
        view.dispatch({ changes: { from: line.from, to: line.from + existingPrefix.length, insert: def.prefix } });
      }
    } else if (adapter.lang === 'typ') {
      // Typst: compare = count
      const existingLevel = existingPrefix.replace(/\s$/, '').length;
      if (existingLevel === level) {
        view.dispatch({ changes: { from: line.from, to: line.from + existingPrefix.length, insert: '' } });
      } else {
        view.dispatch({ changes: { from: line.from, to: line.from + existingPrefix.length, insert: def.prefix } });
      }
    } else {
      // LaTeX: heading wraps content with \section{...} — extract inner text
      const closingBrace = lineText.lastIndexOf('}');
      const innerText = closingBrace > existingPrefix.length
        ? lineText.slice(existingPrefix.length, closingBrace)
        : lineText.slice(existingPrefix.length);
      // Detect current level to support same-level toggle (remove heading)
      const levelMap: Record<string, number> = {
        '\\section{': 1, '\\subsection{': 2, '\\subsubsection{': 3,
        '\\paragraph{': 4, '\\subparagraph{': 5,
      };
      const currentLevel = levelMap[existingPrefix] || 0;
      if (currentLevel === level) {
        // Same level → remove heading, keep bare text
        view.dispatch({ changes: { from: line.from, to: line.to, insert: innerText } });
      } else {
        // Different level → replace command, preserve content and closing brace
        view.dispatch({ changes: { from: line.from, to: line.to, insert: `${def.prefix}${innerText}}` } });
      }
    }
  } else {
    // No heading → insert
    if (adapter.lang === 'tex') {
      // LaTeX headings wrap the content: \section{content}
      const content = lineText.trim() || 'Section';
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: `${def.prefix}${content}}` },
      });
    } else {
      view.dispatch({ changes: { from: line.from, to: line.from, insert: def.prefix } });
    }
  }
  view.focus();
}

/**
 * Insert a block of text at the current cursor position.
 */
export function insertBlock(view: EditorView, text: string): void {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, to: from, insert: text },
    selection: { anchor: from + text.length },
  });
  view.focus();
}
