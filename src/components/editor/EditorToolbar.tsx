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
import { useState, useCallback } from 'react';
import type { EditorView } from '@codemirror/view';
import { useTranslation } from 'react-i18next';
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
  Table2,
  FileDown,
  FileCode,
  Mic,
  MicOff,
  Settings2,
} from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';
import { exportToPdf } from '@/lib/exportPdf';
import { exportToHtml } from '@/lib/exportHtml';
import { isSpeechRecognitionSupported, startVoiceInput, stopVoiceInput } from '@/lib/speechRecognition';
import { toast } from '@/hooks/useToast';
import { TypesettingDialog } from '@/components/typesetting/TypesettingDialog';

// ═══════════════════════════════════════════════════════════════
// 工具栏组件
// ═══════════════════════════════════════════════════════════════

interface EditorToolbarProps {
  viewRef: MutableRefObject<EditorView | null>;
}

export function EditorToolbar({ viewRef }: EditorToolbarProps) {
  const { t, i18n } = useTranslation();
  const [isListening, setIsListening] = useState(false);
  const [typesettingOpen, setTypesettingOpen] = useState(false);

  // ── Voice input handler ───────────────────────────────────
  const handleVoiceToggle = useCallback(() => {
    if (isListening) {
      stopVoiceInput();
      setIsListening(false);
      return;
    }

    if (!isSpeechRecognitionSupported()) {
      toast({ title: t('voice.notSupported'), variant: 'error' });
      return;
    }

    const lang = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
    startVoiceInput(lang, {
      onStart: () => setIsListening(true),
      onResult: (transcript, isFinal) => {
        if (!isFinal) return;
        const view = viewRef.current;
        if (!view) return;
        const { from } = view.state.selection.main;
        view.dispatch({
          changes: { from, to: from, insert: transcript },
          selection: { anchor: from + transcript.length },
        });
      },
      onError: (error) => {
        setIsListening(false);
        if (error === 'not_supported') {
          toast({ title: t('voice.notSupported'), variant: 'error' });
        } else {
          toast({ title: t('voice.error'), description: error, variant: 'error' });
        }
      },
      onEnd: () => setIsListening(false),
    });
  }, [isListening, viewRef, t, i18n.language]);

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

  // ── 标题层级切换 ──────────────────────────────────────────
  // 如果行首已有标题前缀，先移除再替换（避免叠加）
  const toggleHeading = (level: number) => {
    const view = viewRef.current;
    if (!view) return;

    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const lineText = view.state.sliceDoc(line.from, line.to);
    const headingMatch = lineText.match(/^(#{1,6})\s/);
    const prefix = '#'.repeat(level) + ' ';

    if (headingMatch) {
      // 如果当前标题层级与目标相同 → 取消标题
      // 否则替换为新层级
      const existingPrefix = headingMatch[0];
      if (headingMatch[1].length === level) {
        view.dispatch({
          changes: { from: line.from, to: line.from + existingPrefix.length, insert: '' },
        });
      } else {
        view.dispatch({
          changes: { from: line.from, to: line.from + existingPrefix.length, insert: prefix },
        });
      }
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.from, insert: prefix },
      });
    }
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

  // ── PDF 导出操作 ──────────────────────────────────────────
  const handleExportPdf = async () => {
    const view = viewRef.current;
    if (!view) return;
    const content = view.state.doc.toString();
    const activeTab = useNoteStore.getState().activeTabPath;
    const title = activeTab?.replace(/\.md$/, '').split('/').pop() || 'export';
    try {
      await exportToPdf(content, title);
      toast({ title: t('pdf.exportSuccess') });
    } catch (err) {
      toast({ title: t('pdf.exportFailed'), description: String(err), variant: 'error' });
    }
  };

  // ── HTML 导出操作 ─────────────────────────────────────────
  const handleExportHtml = async () => {
    const view = viewRef.current;
    if (!view) return;
    const content = view.state.doc.toString();
    const activeTab = useNoteStore.getState().activeTabPath;
    const title = activeTab?.replace(/\.md$/, '').split('/').pop() || 'export';
    try {
      await exportToHtml(content, title);
      toast({ title: t('export.htmlExportSuccess') });
    } catch (err) {
      toast({ title: t('export.htmlExportFailed'), description: String(err), variant: 'error' });
    }
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-theme-border bg-surface shrink-0 overflow-x-auto">
      {/* ── 标题层级 ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Heading1 size={14} />} title={t('toolbar.heading1')} onClick={() => toggleHeading(1)} />
        <ToolbarBtn icon={<Heading2 size={14} />} title={t('toolbar.heading2')} onClick={() => toggleHeading(2)} />
        <ToolbarBtn icon={<Heading3 size={14} />} title={t('toolbar.heading3')} onClick={() => toggleHeading(3)} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 行内格式 ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Bold size={14} />} title={t('toolbar.bold')} onClick={() => wrapSelection('**', '**', 'bold')} />
        <ToolbarBtn icon={<Italic size={14} />} title={t('toolbar.italic')} onClick={() => wrapSelection('*', '*', 'italic')} />
        <ToolbarBtn icon={<Strikethrough size={14} />} title={t('toolbar.strikethrough')} onClick={() => wrapSelection('~~', '~~', 'text')} />
        <ToolbarBtn icon={<Code size={14} />} title={t('toolbar.code')} onClick={() => wrapSelection('`', '`', 'code')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 块级元素 ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Quote size={14} />} title={t('toolbar.quote')} onClick={() => insertLinePrefix('> ')} />
        <ToolbarBtn icon={<List size={14} />} title={t('toolbar.unorderedList')} onClick={() => insertLinePrefix('- ')} />
        <ToolbarBtn icon={<ListOrdered size={14} />} title={t('toolbar.orderedList')} onClick={() => insertLinePrefix('1. ')} />
        <ToolbarBtn icon={<Table2 size={14} />} title={t('toolbar.table')} onClick={() => insertBlock('\n| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n|          |          |          |\n')} />
        <ToolbarBtn icon={<Minus size={14} />} title={t('toolbar.horizontalRule')} onClick={() => insertBlock('\n---\n')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 嵌入 ───────────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Link size={14} />} title={t('toolbar.link')} onClick={() => wrapSelection('[', '](url)', 'link text')} />
        <ToolbarBtn icon={<Image size={14} />} title={t('toolbar.image')} onClick={() => insertBlock('![alt](image-url)')} />
        <ToolbarBtn icon={<Sigma size={14} />} title={t('toolbar.math')} onClick={() => insertBlock('\n$$\nE = mc^2\n$$\n')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── 导出 & 语音 ─────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<FileDown size={14} />} title={t('pdf.export')} onClick={handleExportPdf} />
        <ToolbarBtn icon={<FileCode size={14} />} title={t('export.htmlExport')} onClick={handleExportHtml} />
        <ToolbarBtn icon={<Settings2 size={14} />} title={t('typesetting.title')} onClick={() => setTypesettingOpen(true)} />
        <ToolbarBtn
          icon={isListening ? <MicOff size={14} /> : <Mic size={14} />}
          title={isListening ? t('voice.stop') : t('voice.start')}
          onClick={handleVoiceToggle}
          active={isListening}
        />
      </ToolbarGroup>

      {/* ── Typesetting dialog ──────────────────────────── */}
      <TypesettingDialog
        open={typesettingOpen}
        onClose={() => setTypesettingOpen(false)}
        content={viewRef.current?.state.doc.toString() || ''}
      />
    </div>
  );
}

// ── 工具栏内部子组件 ────────────────────────────────────────

function ToolbarBtn({
  icon,
  title,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      className={`p-1.5 rounded-md hover:bg-theme-hover transition-colors ${
        active ? 'text-theme-accent bg-theme-accent/10' : 'text-muted-foreground hover:text-foreground'
      }`}
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
  return <div className="w-px h-4 bg-theme-border mx-1.5" />;
}
