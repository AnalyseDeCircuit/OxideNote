/**
 * MarkdownPreview — 实时 Markdown 渲染预览面板
 *
 * 基于 marked 解析器，集成以下渲染管线：
 *   · highlight.js — 代码块语法高亮
 *   · KaTeX        — LaTeX 数学公式 ($inline$ / $$block$$)
 *   · Mermaid      — 流程图 / 序列图 / 甘特图等
 *   · WikiLink     — [[双链]] 点击跳转
 *
 * 设计原则：
 *   1. 与编辑器共享 CSS 主题变量，确保视觉一致性
 *   2. 使用 DOMPurify 理念：仅渲染受信任的本地内容
 *   3. 异步渲染 Mermaid 图表，避免阻塞主线程
 */

import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { Marked, type Token } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { useNoteStore } from '@/store/noteStore';
import { searchByFilename, createNote, readNote, getBlockContent, compileTypstContent } from '@/lib/api';
import { blockRefCache, noteResolveCache, noteEmbedCache, blockRefKey } from '@/lib/previewCache';
import { ImageLightbox } from '@/components/editor/ImageLightbox';
import { getSourceLineForPreviewOffset } from '@/components/editor/scrollSync';
import 'katex/dist/katex.min.css';
import { NOTE_EXT_RE } from '@/lib/utils';

// ── Mermaid 初始化 ──────────────────────────────────────────
// 动态检测主题明暗，匹配 OxideNote 当前界面
const LIGHT_THEMES = ['paper-oxide', 'github-light', 'catppuccin-latte', 'solarized-light', 'gruvbox-light', 'rose-pine-dawn', 'hot-pink', 'spring-green'];

function getMermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'dark';
  const theme = document.documentElement.getAttribute('data-theme') || '';
  return LIGHT_THEMES.includes(theme) ? 'default' : 'dark';
}

function getMermaidConfig() {
  return {
    startOnLoad: false,
    theme: getMermaidTheme(),
    securityLevel: 'strict' as const,
  };
}

mermaid.initialize(getMermaidConfig());

// Mermaid needs globally unique IDs per render call.
// Use a combination of a per-session prefix and an incrementing counter
// to avoid collisions when the same content is re-rendered (e.g. split mode).
const mermaidSessionId = Math.random().toString(36).slice(2, 8);
let mermaidIdCounter = 0;

/**
 * Build an inline SVG string with Lucide-compatible attributes.
 * Used for callout icons rendered inside HTML strings.
 */
function calloutSvg(paths: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// Pre-built Lucide-style inline SVG icons for each callout category
const CALLOUT_PENCIL = calloutSvg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>');
const CALLOUT_FILE_TEXT = calloutSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>');
const CALLOUT_INFO = calloutSvg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const CALLOUT_CHECK_SQUARE = calloutSvg('<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>');
const CALLOUT_LIGHTBULB = calloutSvg('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>');
const CALLOUT_FLAME = calloutSvg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>');
const CALLOUT_CIRCLE_CHECK = calloutSvg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>');
const CALLOUT_CIRCLE_HELP = calloutSvg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>');
const CALLOUT_TRIANGLE_ALERT = calloutSvg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const CALLOUT_CIRCLE_X = calloutSvg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>');
const CALLOUT_SHIELD_ALERT = calloutSvg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
const CALLOUT_BUG = calloutSvg('<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>');
const CALLOUT_CLIPBOARD = calloutSvg('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>');
const CALLOUT_QUOTE = calloutSvg('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 5v3z"/>');
const CALLOUT_PIN = calloutSvg('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>');
const CALLOUT_MUSIC = calloutSvg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');

/** Callout type → inline SVG icon, compatible with Obsidian callout type names */
const CALLOUT_ICON_MAP: Record<string, string> = {
  note: CALLOUT_PENCIL,
  abstract: CALLOUT_FILE_TEXT, summary: CALLOUT_FILE_TEXT, tldr: CALLOUT_FILE_TEXT,
  info: CALLOUT_INFO,
  todo: CALLOUT_CHECK_SQUARE,
  tip: CALLOUT_LIGHTBULB, hint: CALLOUT_LIGHTBULB,
  important: CALLOUT_FLAME,
  success: CALLOUT_CIRCLE_CHECK, check: CALLOUT_CIRCLE_CHECK, done: CALLOUT_CIRCLE_CHECK,
  question: CALLOUT_CIRCLE_HELP, help: CALLOUT_CIRCLE_HELP, faq: CALLOUT_CIRCLE_HELP,
  warning: CALLOUT_TRIANGLE_ALERT, caution: CALLOUT_TRIANGLE_ALERT, attention: CALLOUT_TRIANGLE_ALERT,
  failure: CALLOUT_CIRCLE_X, fail: CALLOUT_CIRCLE_X, missing: CALLOUT_CIRCLE_X,
  danger: CALLOUT_SHIELD_ALERT, error: CALLOUT_SHIELD_ALERT,
  bug: CALLOUT_BUG,
  example: CALLOUT_CLIPBOARD,
  quote: CALLOUT_QUOTE, cite: CALLOUT_QUOTE,
};

function getCalloutIcon(type: string): string {
  return `<span class="callout-icon">${CALLOUT_ICON_MAP[type] || CALLOUT_PIN}</span>`;
}

/**
 * 构建自定义 Marked 实例
 *
 * 通过 extension 机制注入：
 *   · KaTeX 行内/块级公式解析
 *   · Mermaid 代码块识别（标记为占位符，后续异步渲染）
 *   · WikiLink [[target]] 解析
 *   · highlight.js 代码高亮
 */
function createMarkedInstance(getTokenLine: (token: object) => number | undefined) {
  const marked = new Marked();

  // ── KaTeX 块级公式扩展 ($$ ... $$) ───────────────────────
  marked.use({
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src: string) {
          return src.indexOf('$$');
        },
        tokenizer(src: string) {
          const match = src.match(/^\$\$([\s\S]*?)\$\$/);
          if (match) {
            return {
              type: 'mathBlock',
              raw: match[0],
              text: match[1].trim(),
            };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          try {
            return `<div class="math-block">${katex.renderToString(token.text, {
              displayMode: true,
              throwOnError: false,
            })}</div>`;
          } catch {
            return `<div class="math-block math-error">${escapeHtml(token.text)}</div>`;
          }
        },
      },
      // ── KaTeX 行内公式扩展 ($...$) ──────────────────────
      {
        name: 'mathInline',
        level: 'inline',
        start(src: string) {
          return src.indexOf('$');
        },
        tokenizer(src: string) {
          // 匹配 $...$ 但不匹配 $$
          const match = src.match(/^\$(?!\$)((?:[^$\\]|\\.)+?)\$/);
          if (match) {
            return {
              type: 'mathInline',
              raw: match[0],
              text: match[1],
            };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          try {
            return katex.renderToString(token.text, {
              displayMode: false,
              throwOnError: false,
            });
          } catch {
            return `<code class="math-error">${escapeHtml(token.text)}</code>`;
          }
        },
      },
      {
        name: 'blockRef',
        level: 'inline',
        start(src: string) {
          return src.indexOf('[[');
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\[([^\]|#]+)?#\^([\w-]+)(?:\|([^\]]+))?\]\]/);
          if (match) {
            return {
              type: 'blockRef',
              raw: match[0],
              targetNote: match[1]?.trim() || '',
              blockId: match[2],
              display: match[3]?.trim() || '',
            };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          const note = escapeAttr(token.targetNote || '');
          const blockId = escapeAttr(token.blockId);
          const fallback = token.display ? escapeHtml(token.display) : `Loading block ^${escapeHtml(token.blockId)}...`;
          return `<span class="block-ref block-ref-loading" data-note="${note}" data-block="${blockId}">${fallback}</span>`;
        },
      },
      // ── WikiLink 扩展 [[target|display]] ────────────────
      {
        name: 'wikilink',
        level: 'inline',
        start(src: string) {
          return src.indexOf('[[');
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
          if (match) {
            return {
              type: 'wikilink',
              raw: match[0],
              target: match[1].trim(),
              display: (match[2] || match[1]).trim(),
            };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          return `<a class="wikilink" data-target="${escapeAttr(token.target)}" href="#">${escapeHtml(token.display)}</a>`;
        },
      },
      // ── Bilibili 视频嵌入 @bilibili[BVxxx] ─────────────
      {
        name: 'bilibiliEmbed',
        level: 'block',
        start(src: string) {
          return src.indexOf('@bilibili[');
        },
        tokenizer(src: string) {
          const match = src.match(/^@bilibili\[(BV[\w]+)\]/i);
          if (match) {
            return {
              type: 'bilibiliEmbed',
              raw: match[0],
              bvid: match[1],
            };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          return `<div class="bilibili-embed" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;margin:12px 0;border-radius:8px;"><iframe src="https://player.bilibili.com/player.html?bvid=${escapeAttr(token.bvid)}&autoplay=0&high_quality=1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="fullscreen" sandbox="allow-scripts allow-popups" title="Bilibili Video"></iframe></div>`;
        },
      },
      // ── Footnote reference [^id] ────────────────────────
      {
        name: 'footnoteRef',
        level: 'inline' as const,
        start(src: string) {
          return src.indexOf('[^');
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\^([\w-]+)\](?!:)/);
          if (match) {
            return { type: 'footnoteRef', raw: match[0], id: match[1] };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          const id = escapeAttr(token.id);
          return `<sup class="footnote-ref"><a href="#fn-${id}" id="fnref-${id}">[${escapeHtml(token.id)}]</a></sup>`;
        },
      },
      // ── Footnote definition [^id]: content ──────────────
      {
        name: 'footnoteDef',
        level: 'block' as const,
        start(src: string) {
          return src.match(/^\[\^/m)?.index;
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\^([\w-]+)\]:\s+(.+)/);
          if (match) {
            return { type: 'footnoteDef', raw: match[0], id: match[1], content: match[2].trim() };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          const id = escapeAttr(token.id);
          return `<div class="footnote-def" id="fn-${id}"><span class="footnote-label"><a href="#fnref-${id}">[${escapeHtml(token.id)}]</a></span> ${escapeHtml(token.content)}</div>`;
        },
      },
      // ── Note embed ![[notename]] ────────────────────────
      {
        name: 'noteEmbed',
        level: 'block' as const,
        start(src: string) {
          return src.indexOf('![[');
        },
        tokenizer(src: string) {
          const match = src.match(/^!\[\[([^\]]+)\]\]/);
          if (match) {
            return { type: 'noteEmbed', raw: match[0], target: match[1].trim() };
          }
          return undefined;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer(token: any) {
          return `<div class="note-embed" data-embed-target="${escapeAttr(token.target)}"><span class="note-embed-loading">Loading…</span></div>`;
        },
      },
    ],
  });

  // ── Audio file rendering ──────────────────────────────────
  // Override image renderer to detect audio file extensions and
  // render <audio> elements instead of <img> tags.
  const audioExtensions = /\.(webm|mp3|wav|ogg|m4a|aac|flac)$/i;
  marked.use({
    renderer: {
      image({ href, title }: { href: string; title?: string | null; text?: string }) {
        if (audioExtensions.test(href)) {
          const safeHref = escapeAttr(href);
          const label = title ? escapeHtml(title) : escapeHtml(href.split('/').pop() || 'Audio');
          return `<div class="audio-player"><span class="audio-label">${CALLOUT_MUSIC} ${label}</span><audio controls preload="metadata" src="${safeHref}"></audio></div>`;
        }
        // Fall through by returning false to use default rendering
        return false as unknown as string;
      },
    },
  });

  // ── 代码块渲染器：highlight.js + Mermaid 占位 ───────────
  marked.use({
    renderer: {
      code(token: { text: string; lang?: string } & object) {
        const startLine = getTokenLine(token) ?? 0;

        // Mermaid code block → placeholder div, rendered async later
        if (token.lang === 'mermaid') {
          const id = `mermaid-${mermaidSessionId}-${++mermaidIdCounter}`;
          return `<div class="mermaid-container code-line" data-mermaid-id="${id}" data-line="${startLine}">${escapeHtml(token.text)}</div>`;
        }

        // Typst code block → placeholder div, compiled async via backend
        if (token.lang === 'typst') {
          return `<div class="typst-block code-line" data-typst="${encodeURIComponent(token.text)}" data-line="${startLine}"><pre><code class="hljs language-typst">${escapeHtml(token.text)}</code></pre></div>`;
        }

        // Standard code block: single data-line on <code> element,
        // full-block highlight (VS Code style — one anchor per block)
        const languageClass = token.lang ? ` language-${escapeAttr(token.lang)}` : '';
        let highlighted: string;
        if (token.lang && hljs.getLanguage(token.lang)) {
          highlighted = hljs.highlight(token.text, { language: token.lang }).value;
        } else if (token.text.trim()) {
          highlighted = hljs.highlightAuto(token.text).value;
        } else {
          highlighted = escapeHtml(token.text);
        }
        return `<pre><code class="hljs${languageClass} code-line" data-line="${startLine}">${highlighted}</code></pre>`;
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listitem(token: any) {
        const startLine = getTokenLine(token) ?? 0;
        const body = this.parser.parse(token.tokens);
        const checkbox = token.task
          ? `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox">`
          : '';
        const className = token.task ? 'task-list-item code-line' : 'code-line';
        return `<li class="${className}" data-line="${startLine}">${checkbox}${body}</li>`;
      },
    },
  });

  // ── Callout blockquote renderer (Obsidian-compatible) ─────
  marked.use({
    renderer: {
      blockquote({ tokens }: { tokens: import('marked').Token[] }) {
        const body = this.parser.parse(tokens);
        // Detect callout syntax: > [!type](+/-) optional title
        const match = body.match(/^<p>\[!([\w-]+)\]([-+])?\s?([\s\S]*?)<\/p>([\s\S]*)$/);
        if (!match) return `<blockquote>${body}</blockquote>`;

        const type = match[1].toLowerCase();
        const fold = match[2]; // '+' open, '-' collapsed, undefined = static
        const rawInner = match[3];
        const restBody = match[4]?.trim() || '';

        // First line = title, rest = content from first paragraph
        const nlIdx = rawInner.indexOf('\n');
        const title = nlIdx >= 0 ? rawInner.substring(0, nlIdx).trim() : rawInner.trim();
        const firstParaContent = nlIdx >= 0 ? rawInner.substring(nlIdx + 1).trim() : '';

        const displayTitle = title || type.charAt(0).toUpperCase() + type.slice(1);
        const icon = getCalloutIcon(type);
        const safeType = escapeAttr(type);

        // Build content HTML from remaining paragraph content
        let contentHtml = '';
        if (firstParaContent) contentHtml += `<p>${firstParaContent}</p>`;
        if (restBody) contentHtml += restBody;
        const content = contentHtml ? `<div class="callout-content">${contentHtml}</div>` : '';

        if (fold !== undefined) {
          return `<div class="callout callout-${safeType}" data-callout="${safeType}"><details${fold !== '-' ? ' open' : ''}><summary class="callout-title">${icon}<span>${displayTitle}</span></summary>${content}</details></div>`;
        }
        return `<div class="callout callout-${safeType}" data-callout="${safeType}"><div class="callout-title">${icon}<span>${displayTitle}</span></div>${content}</div>`;
      },
    },
  });

  return marked;
}

// ── HTML 转义工具 ───────────────────────────────────────────
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════
// MarkdownPreview 组件
// ═══════════════════════════════════════════════════════════════

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  onScroll?: (sourceLine: number) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

interface PreviewBlock {
  line: number;
  html: string;
  anchored: boolean;
}

export function MarkdownPreview({ content, className = '', onScroll, scrollRef }: MarkdownPreviewProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const containerRef = scrollRef ?? internalRef;
  const tokenLineMapRef = useRef<WeakMap<object, number>>(new WeakMap());
  const marked = useMemo(() => createMarkedInstance((token) => tokenLineMapRef.current.get(token)), []);
  const activeTabPath = useNoteStore((state) => state.activeTabPath);

  // ── Image lightbox state ──────────────────────────────────
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState<string>('');

  // ── 解析 Markdown → 带源码行号锚点的块列表 ────────────────
  const blocks = useMemo(() => {
    if (!content) return [] as PreviewBlock[];

    try {
      const tokens = marked.lexer(content) as Token[];
      tokenLineMapRef.current = buildTokenLineMap(tokens);
      const renderedBlocks: PreviewBlock[] = [];
      let currentLine = 0;

      for (const token of tokens) {
        const startLine = currentLine;
        const raw = typeof token.raw === 'string' ? token.raw : '';
        currentLine += countLineBreaks(raw);

        const rendered = marked.parser([token]) as string;
        const sanitized = sanitizeMarkdownHtml(rendered);
        if (sanitized.trim()) {
          renderedBlocks.push({
            line: startLine,
            html: sanitized,
            anchored: shouldAnchorBlock(token),
          });
        }
      }

      if (renderedBlocks.length > 0) {
        return renderedBlocks;
      }

      const fallback = sanitizeMarkdownHtml(marked.parse(content) as string);
      return fallback.trim() ? [{ line: 0, html: fallback, anchored: true }] : [];
    } catch {
      return [{ line: 0, html: '<p class="text-red-400">Render error</p>', anchored: true }];
    }
  }, [content, marked]);

  // ── 异步渲染 Mermaid 图表 ─────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const mermaidContainers = el.querySelectorAll<HTMLDivElement>('.mermaid-container');
    if (mermaidContainers.length === 0) return;

    let cancelled = false;

    (async () => {
      // Re-initialize Mermaid theme in case user switched themes
      mermaid.initialize(getMermaidConfig());

      for (const container of mermaidContainers) {
        if (cancelled) break;
        // Skip already-rendered containers
        if (container.classList.contains('mermaid-rendered')) continue;
        const id = container.dataset.mermaidId;
        const code = container.textContent || '';
        if (!id || !code) continue;
        try {
          // Clean up any stale SVG element from a previous render attempt
          // (Mermaid creates a temp element with the given ID in document body)
          document.getElementById(id)?.remove();

          const { svg } = await mermaid.render(id, code);
          if (!cancelled) {
            // Mermaid uses foreignObject with HTML inside SVG for node labels.
            // Allow both SVG + HTML profiles so DOMPurify does not strip label content.
            // Mermaid's own securityLevel:'strict' already prevents script injection.
            container.innerHTML = DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true, html: true },
              ADD_TAGS: ['foreignObject'],
            });
            container.classList.add('mermaid-rendered');
          }
        } catch {
          // Mermaid 语法错误 → 保留原始文本
          container.classList.add('mermaid-error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [blocks]);

  // ── Async Typst code block compilation ────────────────────
  // Same hydration pattern as Mermaid: query placeholder divs, compile via
  // backend, replace with sanitized SVG output. Cached by content hash.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const typstBlocks = el.querySelectorAll<HTMLDivElement>('.typst-block[data-typst]');
    if (typstBlocks.length === 0) return;

    let cancelled = false;

    (async () => {
      for (const container of typstBlocks) {
        if (cancelled) break;
        if (container.classList.contains('typst-rendered')) continue;

        const encoded = container.dataset.typst;
        if (!encoded) continue;
        const content = decodeURIComponent(encoded);
        if (!content.trim()) continue;

        try {
          const result = await compileTypstContent(content);
          if (cancelled) break;

          if (result.pages.length > 0) {
            // Render all pages as sanitized SVG
            const svgHtml = result.pages
              .map((svg) =>
                DOMPurify.sanitize(svg, {
                  USE_PROFILES: { svg: true, svgFilters: true },
                }),
              )
              .join('');
            container.innerHTML = `<div class="typst-block-output">${svgHtml}</div>`;
            container.classList.add('typst-rendered');
          } else if (result.diagnostics.length > 0) {
            // Show compilation errors inline
            const errorHtml = result.diagnostics
              .map((d) => `<div class="typst-error-line">L${d.line}: ${escapeHtml(d.message)}</div>`)
              .join('');
            container.innerHTML = `<div class="typst-block-error">${errorHtml}</div>`;
            container.classList.add('typst-rendered', 'typst-error');
          }
        } catch {
          container.classList.add('typst-error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [blocks]);

  // ── 异步加载块引用 [[note#^block]] (with cache) ─────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const blockRefs = el.querySelectorAll<HTMLSpanElement>('.block-ref[data-block]');
    if (blockRefs.length === 0) return;

    let cancelled = false;

    (async () => {
      for (const span of blockRefs) {
        if (cancelled) break;
        const noteTarget = span.dataset.note || '';
        const blockId = span.dataset.block;
        if (!blockId) continue;

        // Resolve note target to a vault path (cached)
        let resolvedPath: string | undefined;
        try {
          if (noteTarget) {
            const cached = noteResolveCache.get(noteTarget);
            resolvedPath = cached?.path;
            if (!resolvedPath) {
              const results = await searchByFilename(noteTarget);
              if (cancelled) break;
              if (results.length > 0) {
                const targetLower = noteTarget.toLowerCase();
                const exact = results.find((r) => {
                  const stem = r.path.replace(NOTE_EXT_RE, '').split('/').pop()?.toLowerCase();
                  return stem === targetLower || r.path.toLowerCase() === targetLower;
                });
                const best = exact ?? results[0];
                resolvedPath = best.path;
                noteResolveCache.set(noteTarget, { path: best.path, title: best.title || noteTarget });
              }
            }
          } else {
            resolvedPath = activeTabPath || undefined;
          }

          if (!resolvedPath) {
            span.textContent = `Block not found: ^${blockId}`;
            span.classList.remove('block-ref-loading');
            span.classList.add('block-ref-error');
            continue;
          }

          // Fetch block content (cached)
          const cacheKey = blockRefKey(resolvedPath, blockId);
          let content = blockRefCache.get(cacheKey);
          if (content === undefined) {
            content = await getBlockContent(resolvedPath, blockId);
            if (cancelled) break;
            blockRefCache.set(cacheKey, content);
          }

          span.classList.remove('block-ref-loading');
          if (content) {
            span.textContent = content;
            span.classList.add('block-ref-loaded');
          } else {
            span.textContent = `Block not found: ^${blockId}`;
            span.classList.add('block-ref-error');
          }
        } catch {
          span.classList.remove('block-ref-loading');
          span.classList.add('block-ref-error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTabPath, blocks]);

  // ── Async embed loader for ![[note]] and ![[note#^block]] (with cache) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const embedContainers = el.querySelectorAll<HTMLDivElement>('.note-embed[data-embed-target]');
    if (embedContainers.length === 0) return;

    let cancelled = false;

    (async () => {
      for (const container of embedContainers) {
        if (cancelled) break;
        const target = container.dataset.embedTarget;
        if (!target) continue;
        try {
          // Parse optional #^blockId from target
          let noteName = target;
          let blockId: string | null = null;
          const blockMatch = target.match(/^(.+?)#\^([a-zA-Z0-9_-]+)$/);
          if (blockMatch) {
            noteName = blockMatch[1];
            blockId = blockMatch[2];
          }

          // Resolve note name (cached)
          const cachedResolve = noteResolveCache.get(noteName);
          let resolvedPath = cachedResolve?.path;
          let resolvedTitle = cachedResolve?.title || noteName;
          if (!resolvedPath) {
            const results = await searchByFilename(noteName);
            if (cancelled) break;
            if (results.length > 0) {
              resolvedPath = results[0].path;
              resolvedTitle = results[0].title || noteName;
              noteResolveCache.set(noteName, { path: resolvedPath, title: resolvedTitle });
            }
          }

          if (!resolvedPath) {
            container.textContent = `Note not found: ${noteName}`;
            container.classList.add('note-embed-error');
            continue;
          }

          // Block embed: fetch only the specific block content
          if (blockId) {
            const cacheKey = blockRefKey(resolvedPath, blockId);
            let blockContent = blockRefCache.get(cacheKey);
            if (!blockContent) {
              blockContent = (await getBlockContent(resolvedPath, blockId)) ?? undefined;
              if (cancelled) break;
              if (blockContent) {
                blockRefCache.set(cacheKey, blockContent);
              }
            }
            if (!blockContent) {
              container.textContent = `Block not found: ${noteName}#^${blockId}`;
              container.classList.add('note-embed-error');
              continue;
            }
            const embedHtml = marked.parse(blockContent) as string;
            const sanitized = sanitizeMarkdownHtml(embedHtml);
            container.innerHTML = `<div class="note-embed-title">${escapeHtml(resolvedTitle)} › ^${escapeHtml(blockId)}</div>${sanitized}`;
            container.classList.add('note-embed-loaded');
            continue;
          }

          // Full note embed: fetch entire note content (cached)
          let cached = noteEmbedCache.get(resolvedPath);
          if (!cached) {
            const noteContent = await readNote(resolvedPath);
            if (cancelled) break;
            cached = { title: resolvedTitle, html: noteContent.content };
            noteEmbedCache.set(resolvedPath, cached);
          }

          const embedHtml = marked.parse(cached.html) as string;
          const sanitized = sanitizeMarkdownHtml(embedHtml);
          container.innerHTML = `<div class="note-embed-title">${escapeHtml(cached.title)}</div>${sanitized}`;
          container.classList.add('note-embed-loaded');
        } catch {
          container.classList.add('note-embed-error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [blocks, marked]);

  // ── WikiLink 点击导航 + Image 灯箱 ───────────────────────
  const handleClick = useCallback(async (e: React.MouseEvent) => {
    // Image lightbox: click on <img> opens fullscreen preview
    const imgTarget = (e.target as HTMLElement).closest<HTMLImageElement>('img');
    if (imgTarget) {
      e.preventDefault();
      setLightboxSrc(imgTarget.src);
      setLightboxAlt(imgTarget.alt || '');
      return;
    }

    const target = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.wikilink');
    if (!target) return;

    e.preventDefault();
    const linkTarget = target.dataset.target;
    if (!linkTarget) return;

    try {
      const results = await searchByFilename(linkTarget);
      if (results.length > 0) {
        // 精确匹配优先：先查找 stem 完全一致的结果
        const targetLower = linkTarget.toLowerCase();
        const exact = results.find((r) => {
          const stem = r.path.replace(NOTE_EXT_RE, '').split('/').pop()?.toLowerCase();
          return stem === targetLower || r.path.toLowerCase() === targetLower;
        });
        const best = exact ?? results[0];
        useNoteStore.getState().openNote(best.path, best.title || best.path);
      } else {
        const newPath = await createNote('', linkTarget);
        useNoteStore.getState().openNote(newPath, linkTarget);
      }
    } catch {
      // WikiLink navigation/creation failed
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!onScroll) return;
    const el = containerRef.current;
    if (!el) return;
    const sourceLine = getSourceLineForPreviewOffset(el, el.scrollTop);
    if (typeof sourceLine === 'number' && !Number.isNaN(sourceLine)) {
      onScroll(sourceLine);
    }
  }, [onScroll, containerRef]);

  return (
    <>
      <div
        ref={containerRef}
        className={`oxide-markdown-preview overflow-y-auto p-6 ${className}`}
        onClick={handleClick}
        onScroll={handleScroll}
      >
        {blocks.map((block, index) => (
          <div
            key={`${block.line}-${index}`}
            className={block.anchored ? 'preview-block code-line' : 'preview-block'}
            data-line={block.anchored ? block.line : undefined}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: block.html }}
          />
        ))}
      </div>
      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          alt={lightboxAlt}
          onClose={() => setLightboxSrc(null)}
        />
      )}
    </>
  );
}

function sanitizeMarkdownHtml(raw: string): string {
  return DOMPurify.sanitize(raw, {
    ADD_TAGS: ['math-block', 'details', 'summary'],
    ADD_ATTR: ['data-target', 'data-mermaid-id', 'data-callout', 'data-embed-target', 'data-note', 'data-block', 'data-line', 'open'],
  });
}

function countLineBreaks(text: string): number {
  return text.match(/\n/g)?.length ?? 0;
}

function shouldAnchorBlock(token: Token): boolean {
  // Lists and code blocks have internal code-line anchors
  // (on <li> and <code> elements respectively), so the wrapper div
  // should not duplicate them — matching VS Code's approach.
  if (token.type === 'list') return false;
  if (token.type === 'code') return false;
  return true;
}

function buildTokenLineMap(tokens: Token[]): WeakMap<object, number> {
  const lineMap = new WeakMap<object, number>();
  assignTokenLines(tokens, 0, lineMap);
  return lineMap;
}

function assignTokenLines(tokens: Token[], startLine: number, lineMap: WeakMap<object, number>): number {
  let currentLine = startLine;

  for (const token of tokens) {
    lineMap.set(token, currentLine);
    assignNestedTokenLines(token, currentLine, lineMap);
    currentLine += countLineBreaks(token.raw || '');
  }

  return currentLine;
}

function assignNestedTokenLines(token: Token, startLine: number, lineMap: WeakMap<object, number>) {
  if (token.type === 'list') {
    let itemLine = startLine;
    for (const item of token.items) {
      lineMap.set(item, itemLine);
      assignNestedTokenLines(item as Token, itemLine, lineMap);
      itemLine += countLineBreaks(item.raw || '');
    }
    return;
  }

  if ('tokens' in token && Array.isArray(token.tokens)) {
    assignTokenLines(token.tokens as Token[], startLine, lineMap);
  }
}


