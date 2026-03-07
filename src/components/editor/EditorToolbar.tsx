/**
 * EditorToolbar — 编辑器格式化工具栏
 *
 * 提供常用 Markdown 格式化快捷操作：
 *   · 标题 (H1~H3)  · 粗体 / 斜体 / 删除线
 *   · 代码           · 引用块
 *   · 无序列表       · 有序列表
 *   · 链接           · 图片引用
 *   · 水平分割线     · 公式块
 *
 * 直接操控 CodeMirror EditorView 实例进行文本插入/包裹，
 * 保持 undo 历史的完整性。
 */

import type { MutableRefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  List,
  ListOrdered,
  Link,
  Image,
  Minus,
  Sigma,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// 工具栏组件
// ═══════════════════════════════════════════════════════════════

interface EditorToolbarProps {
  viewRef: MutableRefObject<EditorView | null>;
}

export function EditorToolbar({ viewRef }: EditorToolbarProps) {
  // ── 包裹选中文本的通用操作 ────────────────────────────────
  // 如果没有选中文本，插入占位符并选中它
  const wrapSelection = (prefix: string, suffix: string, placeholder: string) => {
    const view = viewRef.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const text = selected || placeholder;
    const wrapped = `${prefix}${text}${suffix}`;

    view.dispatch({
      changes: { from, to, insert: wrapped },
      // 选中包裹后的内容（不含前缀后缀），方便用户直接编辑
      selection: { anchor: from + prefix.length, head: from + prefix.length + text.length },
    });
    view.focus();
  };

  // ── 行首插入操作 ──────────────────────────────────────────
  // 用于标题、引用、列表等行首标记
  const insertLinePrefix = (prefix: string) => {
    const view = viewRef.current;
    if (!view) return;

    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);

    view.dispatch({
      changes: { from: line.from, to: line.from, insert: prefix },
    });
    view.focus();
  };

  // ── 插入独立文本块 ────────────────────────────────────────
  const insertBlock = (text: string) => {
    const view = viewRef.current;
    if (!view) return;

    const { from } = view.state.selection.main;
    view.dispatch({
      changes: { from, to: from, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  };

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-theme-border bg-surface shrink-0 overflow-x-auto">
      {/* ── 标题层级 ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Heading1 size={14} />} title="Heading 1" onClick={() => insertLinePrefix('# ')} />
        <ToolbarBtn icon={<Heading2 size={14} />} title="Heading 2" onClick={() => insertLinePrefix('## ')} />
        <ToolbarBtn icon={<Heading3 size={14} />} title="Heading 3" onClick={() => insertLinePrefix('### ')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 行内格式 ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Bold size={14} />} title="Bold (Ctrl+B)" onClick={() => wrapSelection('**', '**', 'bold')} />
        <ToolbarBtn icon={<Italic size={14} />} title="Italic (Ctrl+I)" onClick={() => wrapSelection('*', '*', 'italic')} />
        <ToolbarBtn icon={<Strikethrough size={14} />} title="Strikethrough" onClick={() => wrapSelection('~~', '~~', 'text')} />
        <ToolbarBtn icon={<Code size={14} />} title="Code" onClick={() => wrapSelection('`', '`', 'code')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 块级元素 ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Quote size={14} />} title="Blockquote" onClick={() => insertLinePrefix('> ')} />
        <ToolbarBtn icon={<List size={14} />} title="Unordered List" onClick={() => insertLinePrefix('- ')} />
        <ToolbarBtn icon={<ListOrdered size={14} />} title="Ordered List" onClick={() => insertLinePrefix('1. ')} />
        <ToolbarBtn icon={<Minus size={14} />} title="Horizontal Rule" onClick={() => insertBlock('\n---\n')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 嵌入 ───────────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Link size={14} />} title="Link" onClick={() => wrapSelection('[', '](url)', 'link text')} />
        <ToolbarBtn icon={<Image size={14} />} title="Image" onClick={() => insertBlock('![alt](image-url)')} />
        <ToolbarBtn icon={<Sigma size={14} />} title="Math Block" onClick={() => insertBlock('\n$$\nE = mc^2\n$$\n')} />
      </ToolbarGroup>
    </div>
  );
}

// ── 工具栏内部子组件 ────────────────────────────────────────

function ToolbarBtn({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground hover:text-foreground"
      title={title}
      onClick={onClick}
      type="button"
    >
      {icon}
    </button>
  );
}

function ToolbarGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function ToolbarDivider() {
  return <div className="w-px h-4 bg-theme-border mx-1" />;
}
