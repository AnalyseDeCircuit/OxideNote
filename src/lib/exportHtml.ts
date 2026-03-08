/**
 * HTML Export Module
 *
 * Renders Markdown content to a standalone HTML file with embedded styles.
 * Reuses the same marked pipeline as MarkdownPreview for visual consistency.
 *
 * Flow: markdown → marked HTML → DOMPurify → wrap in HTML template → save dialog → write file
 */

import { Marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import i18n from '@/i18n';

/**
 * Build a minimal marked instance for HTML export.
 * Mirrors the MarkdownPreview pipeline minus interactive features.
 */
export function createHtmlMarked(): Marked {
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
            return `<div class="math-block"><code>${escapeHtml(token.text)}</code></div>`;
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
          return `<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>`;
        }
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
      },
    },
  });

  return marked;
}

/**
 * Export Markdown content as a standalone HTML file.
 */
export async function exportToHtml(content: string, title: string): Promise<void> {
  const t = i18n.t.bind(i18n);

  const filePath = await save({
    title: t('export.htmlExport'),
    defaultPath: `${sanitizeFilename(title)}.html`,
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });

  if (!filePath) return;

  const marked = createHtmlMarked();
  const rawHtml = await marked.parse(content);
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['math-block'],
    ADD_ATTR: ['displaystyle'],
  });

  const fullHtml = buildHtmlDocument(title, cleanHtml);
  await writeTextFile(filePath, fullHtml);
}

/**
 * Wrap rendered content in a complete HTML document with embedded styles.
 */
export function buildHtmlDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <style>
${HTML_EXPORT_STYLES}
  </style>
</head>
<body>
  <article class="markdown-body">
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </article>
</body>
</html>`;
}

// ─── Embedded styles for standalone HTML ────────────────────

export const HTML_EXPORT_STYLES = `
  :root {
    color-scheme: light;
  }
  body {
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 16px;
    line-height: 1.7;
    color: #1a1a1a;
    background: #ffffff;
  }
  .markdown-body h1 { font-size: 2em; margin: 0.67em 0 0.4em; font-weight: 700; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
  .markdown-body h2 { font-size: 1.5em; margin: 1em 0 0.4em; font-weight: 600; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
  .markdown-body h3 { font-size: 1.25em; margin: 1em 0 0.4em; font-weight: 600; }
  .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 1em; margin: 1em 0 0.4em; font-weight: 600; }
  .markdown-body p { margin: 0.8em 0; }
  .markdown-body ul, .markdown-body ol { margin: 0.5em 0; padding-left: 2em; }
  .markdown-body li { margin: 0.25em 0; }
  .markdown-body blockquote {
    margin: 1em 0; padding: 0.5em 1em;
    border-left: 4px solid #dfe2e5; color: #6a737d; background: #f6f8fa;
  }
  .markdown-body pre {
    margin: 1em 0; padding: 16px; border-radius: 6px;
    background: #f6f8fa; overflow-x: auto; font-size: 0.9em;
  }
  .markdown-body code {
    font-family: "SF Mono", "Fira Code", Consolas, "Liberation Mono", monospace;
    font-size: 0.9em;
  }
  .markdown-body :not(pre) > code {
    background: #eff1f3; padding: 0.2em 0.4em; border-radius: 3px;
  }
  .markdown-body table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  .markdown-body th, .markdown-body td { border: 1px solid #dfe2e5; padding: 8px 12px; text-align: left; }
  .markdown-body th { background: #f6f8fa; font-weight: 600; }
  .markdown-body img { max-width: 100%; height: auto; border-radius: 4px; }
  .markdown-body hr { border: none; border-top: 1px solid #eee; margin: 2em 0; }
  .markdown-body a { color: #0366d6; text-decoration: none; }
  .markdown-body a:hover { text-decoration: underline; }
  .math-block { margin: 1em 0; text-align: center; overflow-x: auto; }
  .markdown-body input[type="checkbox"] { margin-right: 0.5em; }
`;

// ─── Helpers ─────────────────────────────────────────────────

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'export';
}
