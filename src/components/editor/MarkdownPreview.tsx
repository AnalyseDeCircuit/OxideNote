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
import { useNoteStore } from '@/store/noteStore';
import { searchByFilename } from '@/lib/api';
import 'katex/dist/katex.min.css';

// ── Mermaid 初始化 ──────────────────────────────────────────
// 使用 dark 主题以匹配 OxideNote 默认深色界面
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
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
}

export function MarkdownPreview({ content, className = '' }: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const marked = useMemo(() => createMarkedInstance(), []);

  // ── 解析 Markdown → HTML ──────────────────────────────────
  const html = useMemo(() => {
    if (!content) return '';
    try {
      return marked.parse(content) as string;
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
      for (const container of mermaidContainers) {
        if (cancelled) break;
        const id = container.dataset.mermaidId;
        const code = container.textContent || '';
        if (!id || !code) continue;
        try {
          const { svg } = await mermaid.render(id, code);
          if (!cancelled) {
            container.innerHTML = svg;
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
        useNoteStore.getState().openNote(results[0].path, results[0].title || results[0].path);
      }
    } catch {
      // 链接目标不存在 — 静默忽略
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={`oxide-markdown-preview overflow-y-auto p-6 ${className}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}
