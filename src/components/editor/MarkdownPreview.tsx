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
import { searchByFilename, createNote, readNote, getBlockContent } from '@/lib/api';
import { blockRefCache, noteResolveCache, noteEmbedCache, blockRefKey } from '@/lib/previewCache';
import { ImageLightbox } from '@/components/editor/ImageLightbox';
import { getSourceLineForPreviewOffset } from '@/components/editor/scrollSync';
import 'katex/dist/katex.min.css';

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
 * Returns emoji icon for callout type.
 * Compatible with Obsidian callout type names.
 */
function getCalloutIcon(type: string): string {
  const icons: Record<string, string> = {
    note: '📝', abstract: '📄', summary: '📄', tldr: '📄',
    info: 'ℹ️', todo: '☑️', tip: '💡', hint: '💡', important: '🔥',
    success: '✅', check: '✅', done: '✅',
    question: '❓', help: '❓', faq: '❓',
    warning: '⚠️', caution: '⚠️', attention: '⚠️',
    failure: '❌', fail: '❌', missing: '❌',
    danger: '🚫', error: '🚫', bug: '🐛',
    example: '📋', quote: '💬', cite: '💬',
  };
  return `<span class="callout-icon">${icons[type] || '📌'}</span>`;
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
          return `<div class="bilibili-embed" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;margin:12px 0;border-radius:8px;"><iframe src="https://player.bilibili.com/player.html?bvid=${escapeAttr(token.bvid)}&autoplay=0&high_quality=1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="fullscreen" sandbox="allow-scripts allow-same-origin allow-popups" title="Bilibili Video"></iframe></div>`;
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
          return `<div class="audio-player"><span class="audio-label">🎵 ${label}</span><audio controls preload="metadata" src="${safeHref}"></audio></div>`;
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
  return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
                  const stem = r.path.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
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

  // ── 异步加载嵌入笔记 ![[note]] (with cache) ────────────
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
          // Resolve note name (cached)
          const cachedResolve = noteResolveCache.get(target);
          let resolvedPath = cachedResolve?.path;
          let resolvedTitle = cachedResolve?.title || target;
          if (!resolvedPath) {
            const results = await searchByFilename(target);
            if (cancelled) break;
            if (results.length > 0) {
              resolvedPath = results[0].path;
              resolvedTitle = results[0].title || target;
              noteResolveCache.set(target, { path: resolvedPath, title: resolvedTitle });
            }
          }

          if (!resolvedPath) {
            container.textContent = `Note not found: ${target}`;
            container.classList.add('note-embed-error');
            continue;
          }

          // Fetch and render note content (cached raw content, rendered fresh)
          let cached = noteEmbedCache.get(resolvedPath);
          if (!cached) {
            const noteContent = await readNote(resolvedPath);
            if (cancelled) break;
            // Cache raw content + title; render fresh each time for theme consistency
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
          const stem = r.path.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
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


