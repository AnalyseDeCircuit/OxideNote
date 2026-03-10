/**
 * DOCX Export Module
 *
 * Converts Markdown content to a Word document (.docx) using the
 * `docx` npm package. Parses Markdown via `marked` lexer to an AST,
 * then maps each token to the corresponding docx element type.
 *
 * Supported elements:
 *   · Headings (H1–H6)    · Paragraphs with inline formatting
 *   · Bold / Italic / Strikethrough / Code spans
 *   · Ordered & Unordered lists (with nesting)
 *   · Code blocks          · Block quotes
 *   · Horizontal rules     · Tables
 *   · Links (as hyperlinks)
 *
 * Flow: markdown → marked.lexer() → token tree → docx Document → Packer.toBuffer() → save dialog → write file
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  TableRow,
  TableCell,
  Table,
  WidthType,
  ExternalHyperlink,
  UnderlineType,
  type IRunOptions,
} from 'docx';
import { Marked, type Token, type Tokens } from 'marked';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import i18n from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Export Markdown content to a .docx file using a system save dialog.
 */
export async function exportToDocx(content: string, title: string): Promise<boolean> {
  const t = i18n.t.bind(i18n);

  const filePath = await save({
    title: t('export.docxExport'),
    defaultPath: `${sanitizeFilename(title)}.docx`,
    filters: [{ name: 'Word Document', extensions: ['docx'] }],
  });

  if (!filePath) return false;

  const doc = buildDocxDocument(content, title);
  const buffer = await Packer.toBuffer(doc);
  await writeFile(filePath, new Uint8Array(buffer));
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Document builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build a docx Document from Markdown source text.
 */
function buildDocxDocument(markdown: string, title: string): Document {
  // Strip YAML frontmatter before parsing (---\n...\n---)
  const cleaned = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const marked = new Marked();
  const tokens = marked.lexer(cleaned);
  const children = tokensToDocxElements(tokens);

  return new Document({
    title,
    creator: 'OxideNote',
    sections: [{ children }],
  });
}

// ═══════════════════════════════════════════════════════════════
// Token → DOCX element conversion
// ═══════════════════════════════════════════════════════════════

type DocxChild = Paragraph | Table;

/**
 * Convert a flat list of marked tokens to DOCX paragraph/table elements.
 */
function tokensToDocxElements(tokens: Token[]): DocxChild[] {
  const elements: DocxChild[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        elements.push(headingToParagraph(token as Tokens.Heading));
        break;

      case 'paragraph':
        elements.push(paragraphToParagraph(token as Tokens.Paragraph));
        break;

      case 'code':
        elements.push(...codeBlockToParagraphs(token as Tokens.Code));
        break;

      case 'blockquote':
        elements.push(...blockquoteToParagraphs(token as Tokens.Blockquote));
        break;

      case 'list':
        elements.push(...listToParagraphs(token as Tokens.List, 0));
        break;

      case 'table':
        elements.push(tableToDocxTable(token as Tokens.Table));
        break;

      case 'hr':
        elements.push(horizontalRule());
        break;

      case 'space':
        // Blank lines — skip
        break;

      default:
        // Fallback: render raw text as a plain paragraph
        if ('raw' in token && typeof token.raw === 'string' && token.raw.trim()) {
          elements.push(new Paragraph({ children: [new TextRun(token.raw.trim())] }));
        }
        break;
    }
  }

  return elements;
}

// ── Heading ─────────────────────────────────────────────────

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function headingToParagraph(token: Tokens.Heading): Paragraph {
  return new Paragraph({
    heading: HEADING_LEVELS[token.depth] || HeadingLevel.HEADING_1,
    children: inlineTokensToRuns(token.tokens),
  });
}

// ── Paragraph ───────────────────────────────────────────────

function paragraphToParagraph(token: Tokens.Paragraph): Paragraph {
  return new Paragraph({
    children: inlineTokensToRuns(token.tokens),
    spacing: { after: 120 },
  });
}

// ── Code block ──────────────────────────────────────────────

function codeBlockToParagraphs(token: Tokens.Code): Paragraph[] {
  // Split code into individual lines — each gets its own Paragraph
  // because docx TextRun ignores literal \n characters.
  const lines = token.text.split('\n');
  return lines.map((line, i) =>
    new Paragraph({
      children: [
        new TextRun({
          text: line || ' ', // empty line needs at least a space
          font: 'Courier New',
          size: 20, // 10pt
          color: '333333',
        }),
      ],
      border: {
        left: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 4 },
      },
      shading: { fill: 'F5F5F5' },
      spacing: {
        before: i === 0 ? 120 : 0,
        after: i === lines.length - 1 ? 120 : 0,
      },
    })
  );
}

// ── Blockquote ──────────────────────────────────────────────

function blockquoteToParagraphs(token: Tokens.Blockquote): Paragraph[] {
  const innerTokens = token.tokens || [];
  const elements: Paragraph[] = [];

  for (const inner of innerTokens) {
    if (inner.type === 'paragraph') {
      elements.push(new Paragraph({
        children: inlineTokensToRuns((inner as Tokens.Paragraph).tokens),
        indent: { left: 720 }, // 0.5 inch
        border: {
          left: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 8 },
        },
        spacing: { after: 80 },
      }));
    }
  }

  if (elements.length === 0) {
    elements.push(new Paragraph({
      children: [new TextRun({ text: token.raw.replace(/^>\s?/gm, '').trim(), italics: true })],
      indent: { left: 720 },
    }));
  }

  return elements;
}

// ── Lists ───────────────────────────────────────────────────

function listToParagraphs(token: Tokens.List, depth: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const ordered = token.ordered;

  token.items.forEach((item, index) => {
    const bullet = ordered ? `${(token.start || 1) + index}. ` : '• ';
    const indent = depth * 360; // 0.25 inch per level

    // Main item text
    const inlineTokens = item.tokens.filter((t) => t.type === 'text' || t.type === 'paragraph');
    const runs: (TextRun | ExternalHyperlink)[] = [];

    // Prepend bullet/number
    runs.push(new TextRun({ text: bullet }));

    for (const sub of inlineTokens) {
      if (sub.type === 'paragraph' && 'tokens' in sub) {
        runs.push(...inlineTokensToRuns((sub as Tokens.Paragraph).tokens));
      } else if (sub.type === 'text' && 'tokens' in sub) {
        runs.push(...inlineTokensToRuns((sub as Tokens.Text).tokens || []));
      } else if ('raw' in sub) {
        runs.push(new TextRun(sub.raw));
      }
    }

    paragraphs.push(new Paragraph({
      children: runs,
      indent: { left: 360 + indent },
      spacing: { after: 40 },
    }));

    // Nested lists
    const nestedLists = item.tokens.filter((t) => t.type === 'list');
    for (const nested of nestedLists) {
      paragraphs.push(...listToParagraphs(nested as Tokens.List, depth + 1));
    }
  });

  return paragraphs;
}

// ── Table ───────────────────────────────────────────────────

function tableToDocxTable(token: Tokens.Table): Table {
  // Use token.align array for correct per-column alignment
  const headerCells = token.header.map((cell, colIndex) =>
    new TableCell({
      children: [new Paragraph({
        children: inlineTokensToRuns(cell.tokens),
        alignment: alignMap(token.align[colIndex]),
      })],
      shading: { fill: 'F0F0F0' },
    })
  );

  const bodyRows = token.rows.map((row) =>
    new TableRow({
      children: row.map((cell, colIndex) =>
        new TableCell({
          children: [new Paragraph({
            children: inlineTokensToRuns(cell.tokens),
            alignment: alignMap(token.align[colIndex]),
          })],
        })
      ),
    })
  );

  return new Table({
    rows: [new TableRow({ children: headerCells }), ...bodyRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function alignMap(align: string | null): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (align) {
    case 'center': return AlignmentType.CENTER;
    case 'right': return AlignmentType.RIGHT;
    default: return AlignmentType.LEFT;
  }
}

// ── Horizontal rule ─────────────────────────────────────────

function horizontalRule(): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    spacing: { before: 200, after: 200 },
  });
}

// ═══════════════════════════════════════════════════════════════
// Inline token → TextRun conversion
// ═══════════════════════════════════════════════════════════════

/**
 * Convert marked inline tokens (text, strong, em, codespan, link, etc.)
 * to an array of docx TextRun / ExternalHyperlink elements.
 */
function inlineTokensToRuns(tokens: Token[] | undefined): (TextRun | ExternalHyperlink)[] {
  if (!tokens) return [];
  const runs: (TextRun | ExternalHyperlink)[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        runs.push(new TextRun({
          text: (token as Tokens.Text).raw,
        }));
        break;

      case 'strong':
        runs.push(...flattenInline((token as Tokens.Strong).tokens, { bold: true }));
        break;

      case 'em':
        runs.push(...flattenInline((token as Tokens.Em).tokens, { italics: true }));
        break;

      case 'del':
        runs.push(...flattenInline((token as Tokens.Del).tokens, { strike: true }));
        break;

      case 'codespan':
        runs.push(new TextRun({
          text: (token as Tokens.Codespan).text,
          font: 'Courier New',
          size: 20,
          color: 'C7254E',
          shading: { fill: 'F9F2F4' },
        }));
        break;

      case 'link': {
        const linkToken = token as Tokens.Link;
        // Only create clickable hyperlinks for safe URL schemes
        const isSafeUrl = /^(https?:\/\/|mailto:)/i.test(linkToken.href);
        if (isSafeUrl) {
          runs.push(new ExternalHyperlink({
            link: linkToken.href,
            children: [new TextRun({
              text: linkToken.text,
              color: '2563EB',
              underline: { type: UnderlineType.SINGLE },
              style: 'Hyperlink',
            })],
          }));
        } else {
          runs.push(new TextRun({ text: linkToken.text, color: '2563EB' }));
        }
        break;
      }

      case 'image':
        // Images require binary data — render as alt text placeholder
        runs.push(new TextRun({
          text: `[${(token as Tokens.Image).text || 'image'}]`,
          italics: true,
          color: '888888',
        }));
        break;

      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;

      case 'escape':
        runs.push(new TextRun({ text: (token as Tokens.Escape).text }));
        break;

      default:
        // Unknown inline — output raw text
        if ('raw' in token && typeof token.raw === 'string') {
          runs.push(new TextRun({ text: token.raw }));
        }
        break;
    }
  }

  return runs;
}

/**
 * Recursively flatten inline tokens with inherited style overrides.
 * E.g. **bold _italic_** → [bold text, bold+italic text]
 */
function flattenInline(tokens: Token[] | undefined, style: Partial<IRunOptions>): TextRun[] {
  if (!tokens) return [];
  const runs: TextRun[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        runs.push(new TextRun({ text: (token as Tokens.Text).raw, ...style }));
        break;
      case 'strong':
        runs.push(...flattenInline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...flattenInline((token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case 'del':
        runs.push(...flattenInline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({
          text: (token as Tokens.Codespan).text,
          font: 'Courier New',
          size: 20,
          ...style,
        }));
        break;
      default:
        if ('raw' in token && typeof token.raw === 'string') {
          runs.push(new TextRun({ text: token.raw, ...style }));
        }
        break;
    }
  }

  return runs;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'export';
}
