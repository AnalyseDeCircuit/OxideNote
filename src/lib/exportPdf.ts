/**
 * PDF Export Module
 *
 * Renders Markdown content to HTML, captures it as a canvas image,
 * and writes pages into a jsPDF document. Uses the same marked pipeline
 * as MarkdownPreview to ensure visual consistency.
 *
 * Flow:
 *   markdown → marked HTML → hidden DOM container → html2canvas → jsPDF → save dialog
 */

import { Marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import DOMPurify from 'dompurify';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import i18n from '@/i18n';

// ─── A4 page constants (in pixels at 96 DPI, 2x render scale) ────
const A4_WIDTH_PX = 794;
const A4_HEIGHT_MM = 297;
const A4_WIDTH_MM = 210;
const RENDER_SCALE = 2;

/**
 * Build a minimal marked instance for PDF rendering.
 * Mirrors the MarkdownPreview pipeline minus interactive features (WikiLinks, Mermaid).
 */
function createPdfMarked(): Marked {
  const marked = new Marked();

  // KaTeX block math
  marked.use({
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src: string) { return src.indexOf('$$'); },
        tokenizer(src: string) {
          const m = src.match(/^\$\$([\s\S]*?)\$\$/);
          if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          try {
            return `<div class="math-block">${katex.renderToString(token.text, { displayMode: true, throwOnError: false })}</div>`;
          } catch {
            return `<div class="math-block">${escapeHtml(token.text)}</div>`;
          }
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src: string) { return src.indexOf('$'); },
        tokenizer(src: string) {
          const m = src.match(/^\$(?!\$)((?:[^$\\]|\\.)+?)\$/);
          if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim() };
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          try {
            return katex.renderToString(token.text, { displayMode: false, throwOnError: false });
          } catch {
            return `<code>${escapeHtml(token.text)}</code>`;
          }
        },
      },
    ],
  });

  // Code highlighting
  marked.use({
    renderer: {
      code({ text, lang }: { text: string; lang?: string }) {
        if (lang && hljs.getLanguage(lang)) {
          const highlighted = hljs.highlight(text, { language: lang }).value;
          return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
        }
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
      },
    },
  });

  return marked;
}

/**
 * Export the current note content as a PDF file.
 *
 * @param content - Raw Markdown string
 * @param title   - Note title (used as default filename)
 */
export async function exportToPdf(content: string, title: string): Promise<void> {
  const t = i18n.t.bind(i18n);

  // Prompt user for save location
  const filePath = await save({
    title: t('pdf.export'),
    defaultPath: `${sanitizeFilename(title)}.pdf`,
    filters: [{ name: t('pdf.fileFilter'), extensions: ['pdf'] }],
  });

  if (!filePath) return; // User cancelled

  // Parse markdown to HTML
  const marked = createPdfMarked();
  const rawHtml = await marked.parse(content);
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['math-block'],
    ADD_ATTR: ['displaystyle'],
  });

  // Create offscreen container for rendering
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed; left: -9999px; top: 0;
    width: ${A4_WIDTH_PX}px;
    background: white; color: black;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; line-height: 1.6;
    padding: 40px 50px;
    box-sizing: border-box;
  `;
  container.innerHTML = cleanHtml;

  // Inject print-friendly styles
  const style = document.createElement('style');
  style.textContent = PDF_STYLES;
  container.prepend(style);

  document.body.appendChild(container);

  try {
    // Capture the rendered HTML as a canvas
    const canvas = await html2canvas(container, {
      scale: RENDER_SCALE,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });

    // Calculate pagination
    const imgWidth = A4_WIDTH_MM;
    const imgFullHeight = (canvas.height * A4_WIDTH_MM) / canvas.width;
    const pageHeight = A4_HEIGHT_MM;

    const pdf = new jsPDF('p', 'mm', 'a4');
    let position = 0;
    let pageIndex = 0;

    while (position < imgFullHeight) {
      if (pageIndex > 0) {
        pdf.addPage();
      }

      // Crop the canvas for this page
      const sourceY = Math.round((position / imgFullHeight) * canvas.height);
      const sourceHeight = Math.min(
        Math.round((pageHeight / imgFullHeight) * canvas.height),
        canvas.height - sourceY
      );

      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sourceHeight;
      const ctx = pageCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);
      }

      const pageImgData = pageCanvas.toDataURL('image/png');
      const drawHeight = (sourceHeight * imgWidth) / canvas.width;
      pdf.addImage(pageImgData, 'PNG', 0, 0, imgWidth, drawHeight);

      position += pageHeight;
      pageIndex++;
    }

    // Save to disk
    const pdfBytes = pdf.output('arraybuffer');
    await writeFile(filePath, new Uint8Array(pdfBytes));
  } finally {
    document.body.removeChild(container);
  }
}

// ─── Print-friendly CSS for the offscreen container ─────────

const PDF_STYLES = `
  * { margin: 0; box-sizing: border-box; }
  h1 { font-size: 24px; margin: 16px 0 8px; font-weight: 700; }
  h2 { font-size: 20px; margin: 14px 0 6px; font-weight: 600; }
  h3 { font-size: 17px; margin: 12px 0 4px; font-weight: 600; }
  h4, h5, h6 { font-size: 15px; margin: 10px 0 4px; font-weight: 600; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 24px; }
  li { margin: 2px 0; }
  blockquote {
    margin: 8px 0; padding: 8px 16px;
    border-left: 3px solid #ccc; color: #555; background: #f9f9f9;
  }
  pre {
    margin: 8px 0; padding: 12px; border-radius: 4px;
    background: #f5f5f5; overflow-x: auto; font-size: 13px;
  }
  code { font-family: "SF Mono", "Fira Code", Consolas, monospace; font-size: 0.9em; }
  :not(pre) > code { background: #eee; padding: 1px 4px; border-radius: 3px; }
  table { border-collapse: collapse; margin: 8px 0; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
  a { color: #0066cc; text-decoration: none; }
  .math-block { margin: 12px 0; text-align: center; }
`;

// ─── Helpers ─────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Sanitize title for use as a filename (remove illegal chars) */
function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'export';
}

// ─── Typesetting settings type ──────────────────────────────

export interface TypesettingSettings {
  pageSize: string;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  fontFamily: string;
  header: string;
  footer: string;
  coverPage: boolean;
  coverTitle: string;
  coverAuthor: string;
  coverDate: string;
  tableOfContents: boolean;
}

// ─── Page size map (mm) ─────────────────────────────────────

const PAGE_SIZE_MAP: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  Letter: { w: 216, h: 279 },
  A3: { w: 297, h: 420 },
};

/**
 * Export PDF with advanced typesetting settings.
 * Extends the basic export with cover page, TOC, headers/footers, margins.
 */
export async function exportToPdfWithSettings(
  content: string,
  title: string,
  settings: TypesettingSettings
): Promise<void> {
  const t = i18n.t.bind(i18n);

  const filePath = await save({
    title: t('pdf.export'),
    defaultPath: `${sanitizeFilename(title)}.pdf`,
    filters: [{ name: t('pdf.fileFilter'), extensions: ['pdf'] }],
  });

  if (!filePath) return;

  const pageSize = PAGE_SIZE_MAP[settings.pageSize] || PAGE_SIZE_MAP.A4;
  const contentWidthPx = Math.round((pageSize.w - settings.marginLeft - settings.marginRight) * (A4_WIDTH_PX / A4_WIDTH_MM));

  // Parse markdown
  const marked = createPdfMarked();
  const rawHtml = await marked.parse(content);
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['math-block'],
    ADD_ATTR: ['displaystyle'],
  });

  // Create offscreen container
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed; left: -9999px; top: 0;
    width: ${contentWidthPx}px;
    background: white; color: black;
    font-family: ${settings.fontFamily}, -apple-system, sans-serif;
    font-size: 14px; line-height: 1.6;
    padding: 20px;
    box-sizing: border-box;
  `;
  container.innerHTML = cleanHtml;

  const style = document.createElement('style');
  style.textContent = PDF_STYLES;
  container.prepend(style);
  document.body.appendChild(container);

  try {
    const canvas = await html2canvas(container, {
      scale: RENDER_SCALE,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });

    // Use the correct page format
    const format = settings.pageSize === 'Letter' ? 'letter' : settings.pageSize.toLowerCase();
    const pdf = new jsPDF('p', 'mm', format as 'a4' | 'a3' | 'letter');

    // ── Cover page ──────────────────────────────────────────
    if (settings.coverPage) {
      const cx = pageSize.w / 2;
      pdf.setFontSize(28);
      pdf.text(settings.coverTitle || title, cx, pageSize.h * 0.35, { align: 'center' });
      if (settings.coverAuthor) {
        pdf.setFontSize(16);
        pdf.text(settings.coverAuthor, cx, pageSize.h * 0.45, { align: 'center' });
      }
      if (settings.coverDate) {
        pdf.setFontSize(12);
        pdf.text(settings.coverDate, cx, pageSize.h * 0.50, { align: 'center' });
      }
      pdf.addPage();
    }

    // ── Table of contents ───────────────────────────────────
    if (settings.tableOfContents) {
      const headings = content.match(/^#{1,3}\s+.+$/gm) || [];
      if (headings.length > 0) {
        pdf.setFontSize(20);
        pdf.text('Table of Contents', settings.marginLeft, settings.marginTop + 10);
        let tocY = settings.marginTop + 25;
        pdf.setFontSize(11);
        for (const heading of headings) {
          const level = (heading.match(/^#+/) || [''])[0].length;
          const text = heading.replace(/^#+\s+/, '');
          const indent = settings.marginLeft + (level - 1) * 6;
          pdf.text(text, indent, tocY);
          tocY += 6;
          if (tocY > pageSize.h - settings.marginBottom) {
            pdf.addPage();
            tocY = settings.marginTop + 10;
          }
        }
        pdf.addPage();
      }
    }

    // ── Content pages ───────────────────────────────────────
    const imgWidth = pageSize.w - settings.marginLeft - settings.marginRight;
    const imgFullHeight = (canvas.height * imgWidth) / canvas.width;
    const usableHeight = pageSize.h - settings.marginTop - settings.marginBottom;
    let position = 0;
    let pageIndex = 0;
    let totalPages = Math.ceil(imgFullHeight / usableHeight);

    // Pre-compute total pages for footer template
    const coverPages = settings.coverPage ? 1 : 0;
    const tocPages = settings.tableOfContents ? 1 : 0;
    totalPages += coverPages + tocPages;

    while (position < imgFullHeight) {
      if (pageIndex > 0) {
        pdf.addPage();
      }

      const sourceY = Math.round((position / imgFullHeight) * canvas.height);
      const sourceHeight = Math.min(
        Math.round((usableHeight / imgFullHeight) * canvas.height),
        canvas.height - sourceY
      );

      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sourceHeight;
      const ctx = pageCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);
      }

      const pageImgData = pageCanvas.toDataURL('image/png');
      const drawHeight = (sourceHeight * imgWidth) / canvas.width;
      pdf.addImage(pageImgData, 'PNG', settings.marginLeft, settings.marginTop, imgWidth, drawHeight);

      // Header
      if (settings.header) {
        const headerText = replaceTemplateVars(settings.header, title, pageIndex + 1 + coverPages + tocPages, totalPages);
        pdf.setFontSize(9);
        pdf.setTextColor(128);
        pdf.text(headerText, pageSize.w / 2, settings.marginTop - 5, { align: 'center' });
        pdf.setTextColor(0);
      }

      // Footer
      if (settings.footer) {
        const footerText = replaceTemplateVars(settings.footer, title, pageIndex + 1 + coverPages + tocPages, totalPages);
        pdf.setFontSize(9);
        pdf.setTextColor(128);
        pdf.text(footerText, pageSize.w / 2, pageSize.h - settings.marginBottom + 8, { align: 'center' });
        pdf.setTextColor(0);
      }

      position += usableHeight;
      pageIndex++;
    }

    const pdfBytes = pdf.output('arraybuffer');
    await writeFile(filePath, new Uint8Array(pdfBytes));
  } finally {
    document.body.removeChild(container);
  }
}

/** Replace template variables in header/footer strings */
function replaceTemplateVars(template: string, title: string, page: number, pages: number): string {
  return template
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{page\}\}/g, String(page))
    .replace(/\{\{pages\}\}/g, String(pages));
}
