/**
 * Static Site Publish — render vault notes as a browsable HTML site
 *
 * Flow:
 *   1. Collect all .md note paths from the workspace tree
 *   2. Read each note via readNote API
 *   3. Render markdown → HTML via the shared export pipeline
 *   4. Build an index.html with navigation links
 *   5. Call publish_static_site Rust command to write output directory
 */

import DOMPurify from 'dompurify';
import { open } from '@tauri-apps/plugin-dialog';
import { readNote, publishStaticSite, type SitePage } from '@/lib/api';
import { createHtmlMarked, escapeHtml, sanitizeFilename, HTML_EXPORT_STYLES } from '@/lib/exportHtml';
import type { TreeNode } from '@/lib/api';

/**
 * Collect all .md file relative paths from the workspace tree recursively.
 */
function collectNotePaths(entries: TreeNode[], prefix = ''): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.is_dir && entry.children) {
      paths.push(...collectNotePaths(entry.children, fullPath));
    } else if (entry.name.endsWith('.md')) {
      paths.push(fullPath);
    }
  }
  return paths;
}

/**
 * Build the index.html for the static site.
 */
function buildIndexPage(noteLinks: { href: string; title: string }[]): string {
  const listItems = noteLinks
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((link) => `      <li><a href="${escapeHtml(link.href)}">${escapeHtml(link.title)}</a></li>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OxideNote Site</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <style>
${HTML_EXPORT_STYLES}
    nav { margin-bottom: 2em; }
    nav a { text-decoration: none; color: #0366d6; }
    nav a:hover { text-decoration: underline; }
    nav ul { list-style: none; padding: 0; }
    nav li { margin: 0.4em 0; }
  </style>
</head>
<body>
  <article class="markdown-body">
    <h1>OxideNote</h1>
    <nav>
      <ul>
${listItems}
      </ul>
    </nav>
  </article>
</body>
</html>`;
}

/**
 * Build a site page HTML document with a back-to-index link.
 */
function buildSitePage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <style>
${HTML_EXPORT_STYLES}
    .back-link { 
      display: inline-block; margin-bottom: 1.5em; color: #0366d6; 
      text-decoration: none; font-size: 0.9em; 
    }
    .back-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <article class="markdown-body">
    <a class="back-link" href="index.html">&larr; Index</a>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </article>
</body>
</html>`;
}

/**
 * Publish the entire vault (or a subset) as a static HTML site.
 * Returns the number of pages written.
 */
export async function publishSite(tree: TreeNode[]): Promise<number> {
  // Pick output directory
  const outputDir = await open({
    directory: true,
    title: 'Select output directory for static site',
  });
  if (!outputDir) return 0;

  const notePaths = collectNotePaths(tree);
  if (notePaths.length === 0) return 0;

  const marked = createHtmlMarked();
  const pages: SitePage[] = [];
  const links: { href: string; title: string }[] = [];

  for (const notePath of notePaths) {
    try {
      const noteData = await readNote(notePath);
      const rawHtml = await marked.parse(noteData.content);
      const cleanHtml = DOMPurify.sanitize(rawHtml, {
        ADD_TAGS: ['math-block'],
        ADD_ATTR: ['displaystyle'],
      });

      // Convert .md path to .html path, sanitize each segment individually
      const htmlPath = notePath.replace(/\.md$/, '.html');
      const title = notePath.replace(/\.md$/, '').split('/').pop() || notePath;
      const safePath = htmlPath.split('/').map(sanitizeFilename).join('/');

      const pageHtml = buildSitePage(title, cleanHtml);
      pages.push({ path: safePath, html: pageHtml });
      links.push({ href: safePath, title });
    } catch {
      // Skip notes that fail to read/render
    }
  }

  const indexHtml = buildIndexPage(links);
  return publishStaticSite(outputDir, pages, indexHtml);
}
