/**
 * OutlinePanel — 文档大纲面板
 *
 * 从当前笔记的 Markdown 内容中提取标题层级，
 * 生成可点击导航的 TOC（Table of Contents）树。
 *
 * 提取策略：
 *   · 使用正则匹配 ATX 标题语法 (# ~ ######)
 *   · 忽略代码块内的 # 符号
 *   · 层级缩进通过 paddingLeft 计算
 *
 * 点击标题时滚动编辑器到对应行。
 */

import { useMemo } from 'react';
import { useNoteStore } from '@/store/noteStore';
import { useTranslation } from 'react-i18next';

// ── 标题条目类型 ────────────────────────────────────────────
interface HeadingItem {
  /** 标题层级 1~6 */
  level: number;
  /** 标题文本 */
  text: string;
  /** 在源文档中的行号（0-based） */
  line: number;
}

/**
 * 从 Markdown 源文本中提取标题列表
 *
 * 规则：
 *   · 跳过围栏代码块内的行 (``` / ~~~)
 *   · 匹配 ATX 标题格式：^#{1,6}\s+(.*)$
 */
function extractHeadings(content: string): HeadingItem[] {
  const lines = content.split('\n');
  const headings: HeadingItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测围栏代码块边界
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // 匹配 ATX 标题
    const match = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i,
      });
    }
  }

  return headings;
}

// ═══════════════════════════════════════════════════════════════
// OutlinePanel 组件
// ═══════════════════════════════════════════════════════════════

export function OutlinePanel() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);

  // 根据是否有打开的笔记显示不同状态
  if (!activeTabPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('outline.noNote')}
      </div>
    );
  }

  return <OutlinePanelContent />;
}

/**
 * 内部组件：读取当前活动笔记的内容并渲染大纲。
 *
 * 通过监听编辑器内容变化来实时更新。
 * 由于编辑器内容存储在 contentRef 中（非 React state），
 * 这里额外监听 DOM 变化来触发重新提取。
 */
function OutlinePanelContent() {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);

  // 从编辑器的 CodeMirror DOM 中提取内容
  // 通过 MutationObserver 或定时刷新方案
  // 简化方案：直接从 cm-content 元素获取文本
  const headings = useEditorHeadings();

  if (headings.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('outline.empty')}
      </div>
    );
  }

  // 计算最小层级用于相对缩进
  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <div className="flex-1 overflow-y-auto py-2">
      <ul className="space-y-0.5">
        {headings.map((heading, idx) => (
          <li key={`${heading.line}-${idx}`}>
            <button
              className="w-full text-left px-3 py-1 text-[13px] truncate hover:bg-theme-hover transition-colors text-foreground/80 hover:text-foreground"
              style={{ paddingLeft: `${(heading.level - minLevel) * 16 + 12}px` }}
              onClick={() => scrollToLine(heading.line)}
              title={heading.text}
            >
              <span className="text-theme-accent mr-1.5 text-xs font-mono opacity-50">
                {'#'.repeat(heading.level)}
              </span>
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 从 CodeMirror 编辑器内容中提取标题 ─────────────────────
// 使用轮询方案（每 500ms）以跟踪编辑器实时变化

import { useState, useEffect, useRef } from 'react';

function useEditorHeadings(): HeadingItem[] {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const prevContentRef = useRef('');

  useEffect(() => {
    if (!activeTabPath) {
      setHeadings([]);
      return;
    }

    // 轮询间隔：500ms，在编辑时实时更新大纲
    const interval = setInterval(() => {
      const cmContent = document.querySelector('.cm-content');
      if (!cmContent) return;

      const text = cmContent.textContent || '';
      // 仅在内容变化时重新解析（避免冗余计算）
      if (text !== prevContentRef.current) {
        prevContentRef.current = text;

        // 从 CodeMirror 的 DOM 结构中获取实际文本
        // cm-line 元素保留了原始文本
        const cmEditor = document.querySelector('.cm-editor');
        if (!cmEditor) return;

        // 通过 CodeMirror 的 view 实例获取文档内容
        const lines: string[] = [];
        const cmLines = cmEditor.querySelectorAll('.cm-line');
        cmLines.forEach((line) => {
          lines.push(line.textContent || '');
        });

        const content = lines.join('\n');
        setHeadings(extractHeadings(content));
      }
    }, 500);

    return () => clearInterval(interval);
  }, [activeTabPath]);

  return headings;
}

// ── 滚动编辑器到指定行 ──────────────────────────────────────

function scrollToLine(line: number) {
  const cmEditor = document.querySelector('.cm-editor');
  if (!cmEditor) return;

  const cmLines = cmEditor.querySelectorAll('.cm-line');
  if (line >= 0 && line < cmLines.length) {
    cmLines[line].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
