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

import { useEffect, useRef, useMemo, useCallback } from 'react';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { useNoteStore } from '@/store/noteStore';
import { searchByFilename, createNote } from '@/lib/api';
import 'katex/dist/katex.min.css';

// ── Mermaid 初始化 ──────────────────────────────────────────
// 动态检测主题明暗，匹配 OxideNote 当前界面
const LIGHT_THEMES = ['paper-oxide', 'github-light', 'catppuccin-latte', 'solarized-light', 'gruvbox-light', 'rose-pine-dawn', 'hot-pink', 'spring-green'];

function getMermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'dark';
  const theme = document.documentElement.getAttribute('data-theme') || '';
  return LIGHT_THEMES.includes(theme) ? 'default' : 'dark';
}

mermaid.initialize({
  startOnLoad: false,
  theme: getMermaidTheme(),
  securityLevel: 'strict',
});

// ── 自增 ID，用于 Mermaid 图表容器唯一标识 ─────────────────
let mermaidIdCounter = 0;

/**
 * 构建自定义 Marked 实例
 *
 * 通过 extension 机制注入：
 *   · KaTeX 行内/块级公式解析
 *   · Mermaid 代码块识别（标记为占位符，后续异步渲染）
 *   · WikiLink [[target]] 解析
 *   · highlight.js 代码高亮
 */
function createMarkedInstance() {
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
    ],
  });

  // ── 代码块渲染器：highlight.js + Mermaid 占位 ───────────
  marked.use({
    renderer: {
      code({ text, lang }: { text: string; lang?: string }) {
        // Mermaid 代码块 → 插入占位 div，后续异步渲染
        if (lang === 'mermaid') {
          const id = `mermaid-${++mermaidIdCounter}`;
          return `<div class="mermaid-container" data-mermaid-id="${id}">${escapeHtml(text)}</div>`;
        }

        // 常规代码块 → highlight.js
        if (lang && hljs.getLanguage(lang)) {
          const highlighted = hljs.highlight(text, { language: lang }).value;
          return `<pre><code class="hljs language-${escapeAttr(lang)}">${highlighted}</code></pre>`;
        }
        // 无语言标注的代码块 → 自动检测
        const auto = hljs.highlightAuto(text).value;
        return `<pre><code class="hljs">${auto}</code></pre>`;
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
  onScroll?: (scrollFraction: number) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export function MarkdownPreview({ content, className = '', onScroll, scrollRef }: MarkdownPreviewProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const containerRef = scrollRef ?? internalRef;
  const marked = useMemo(() => createMarkedInstance(), []);

  // ── 解析 Markdown → HTML（DOMPurify 净化）─────────────────
  const html = useMemo(() => {
    if (!content) return '';
    try {
      const raw = marked.parse(content) as string;
      return DOMPurify.sanitize(raw, {
        ADD_TAGS: ['math-block'],
        ADD_ATTR: ['data-target', 'data-mermaid-id'],
      });
    } catch {
      return `<p class="text-red-400">Render error</p>`;
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
      mermaid.initialize({
        startOnLoad: false,
        theme: getMermaidTheme(),
        securityLevel: 'strict',
      });

      for (const container of mermaidContainers) {
        if (cancelled) break;
        const id = container.dataset.mermaidId;
        const code = container.textContent || '';
        if (!id || !code) continue;
        try {
          const { svg } = await mermaid.render(id, code);
          if (!cancelled) {
            // 对 Mermaid 生成的 SVG 进行 DOMPurify 净化，防止 SVG 内嵌脚本
            container.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
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
  }, [html]);

  // ── WikiLink 点击导航 ─────────────────────────────────────
  const handleClick = useCallback(async (e: React.MouseEvent) => {
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
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return;
    onScroll(el.scrollTop / maxScroll);
  }, [onScroll, containerRef]);

  return (
    <div
      ref={containerRef}
      className={`oxide-markdown-preview overflow-y-auto p-6 ${className}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
      onScroll={handleScroll}
    />
  );
}
