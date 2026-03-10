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
import { useState, useCallback, useRef, useEffect } from 'react';
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
  Printer,
  PenTool,
  Sparkles,
  Bot,
} from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';
import { useChatStore } from '@/store/chatStore';
import { useUIStore } from '@/store/uiStore';
import { useAgentStore } from '@/store/agentStore';
import { exportToPdf } from '@/lib/exportPdf';
import { exportToHtml, createHtmlMarked, buildHtmlDocument } from '@/lib/exportHtml';
import { printHtml } from '@/lib/api';
import DOMPurify from 'dompurify';
import { isSpeechRecognitionSupported, startVoiceInput, stopVoiceInput } from '@/lib/speechRecognition';
import { toast } from '@/hooks/useToast';
import { TypesettingDialog } from '@/components/typesetting/TypesettingDialog';
import { AudioRecorder } from '@/components/editor/AudioRecorder';
import { CanvasEditor } from '@/components/canvas/CanvasEditor';
import { triggerAiTransform, triggerAiContinue } from '@/components/editor/extensions/aiInline';
import { suggestTags, suggestLinks, listAllTags, getGraphData } from '@/lib/api';
import { stripNoteExtension } from '@/lib/utils';

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
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);

  // Derive file extension from active tab for file-aware AI actions
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const fileExt = activeTabPath?.split('.').pop() || 'md';
  const agentRunning = useAgentStore((s) => s.isRunning);

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
    const title = activeTab ? stripNoteExtension(activeTab).split('/').pop() || 'export' : 'export';
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
    const title = activeTab ? stripNoteExtension(activeTab).split('/').pop() || 'export' : 'export';
    try {
      await exportToHtml(content, title);
      toast({ title: t('export.htmlExportSuccess') });
    } catch (err) {
      toast({ title: t('export.htmlExportFailed'), description: String(err), variant: 'error' });
    }
  };

  // ── Print via system browser ──────────────────────────────
  // window.print() does not work in Tauri WebView. Instead we
  // render Markdown → sanitized HTML, then call the Rust backend
  // to write a temp file and open it in the system browser with
  // an auto-print script.
  const handlePrint = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const content = view.state.doc.toString();
    const activeTab = useNoteStore.getState().activeTabPath;
    if (!activeTab) return;
    const title = stripNoteExtension(activeTab).split('/').pop() || 'print';

    try {
      const marked = createHtmlMarked();
      const rawHtml = await marked.parse(content);
      // Sanitize to prevent XSS from untrusted Markdown content
      const cleanHtml = DOMPurify.sanitize(rawHtml, {
        ADD_TAGS: ['math-block'],
        ADD_ATTR: ['displaystyle'],
      });
      const fullHtml = buildHtmlDocument(title, cleanHtml);
      // Delegate to Rust: inlines local images as data URIs,
      // writes temp file and opens in system browser
      await printHtml(fullHtml, activeTab);
    } catch (err) {
      toast({ title: t('toolbar.printFailed'), description: String(err), variant: 'error' });
    }
  }, [viewRef, t]);

  // ── AI action handlers ──────────────────────────────────
  const handleAiClick = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    if (from === to) {
      // No selection: trigger continuation
      const config = useChatStore.getState().config;
      const noteTitle = useNoteStore.getState().activeTabPath ? stripNoteExtension(useNoteStore.getState().activeTabPath!).split('/').pop() || '' : '';
      triggerAiContinue(view, config, noteTitle).catch((err) => {
        toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
      });
    } else {
      // Has selection: show action menu
      setAiMenuOpen((prev) => !prev);
    }
  }, [viewRef, t]);

  const handleAiAction = useCallback((instruction: string) => {
    setAiMenuOpen(false);
    const view = viewRef.current;
    if (!view) return;
    const config = useChatStore.getState().config;
    const activePath = useNoteStore.getState().activeTabPath || '';
    const noteTitle = activePath.replace(/\.[^.]+$/, '').split('/').pop() || '';
    const fileExt = activePath.split('.').pop() || 'md';
    triggerAiTransform(view, instruction, config, noteTitle, fileExt).catch((err) => {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    });
  }, [viewRef, t]);

  // AI suggest tags: inserts inline #tags at the end of the note
  const handleSuggestTags = useCallback(async () => {
    setAiMenuOpen(false);
    const view = viewRef.current;
    if (!view) return;
    const config = useChatStore.getState().config;
    const noteTitle = useNoteStore.getState().activeTabPath ? stripNoteExtension(useNoteStore.getState().activeTabPath!).split('/').pop() || '' : '';
    const content = view.state.doc.toString();
    try {
      const allTags = await listAllTags();
      const tags = await suggestTags(content, noteTitle, allTags.map((t) => t.tag), config);
      if (!tags.length) return;
      // Insert suggested tags as inline #tags at the end of the document
      const tagLine = '\n\n' + tags.map((tag) => `#${tag}`).join(' ');
      const docLen = view.state.doc.length;
      view.dispatch({ changes: { from: docLen, to: docLen, insert: tagLine } });
      toast({ title: t('smartTags.inserted', { count: tags.length }) });
    } catch (err) {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    }
  }, [viewRef, t]);

  // AI suggest links: inserts [[WikiLinks]] at the cursor
  const handleSuggestLinks = useCallback(async () => {
    setAiMenuOpen(false);
    const view = viewRef.current;
    if (!view) return;
    const config = useChatStore.getState().config;
    const noteTitle = useNoteStore.getState().activeTabPath ? stripNoteExtension(useNoteStore.getState().activeTabPath!).split('/').pop() || '' : '';
    const content = view.state.doc.toString();
    try {
      const graphData = await getGraphData();
      const allTitles = graphData.nodes.map((n) => n.title).filter((t) => t && t !== noteTitle);
      const suggestions = await suggestLinks(content, noteTitle, allTitles, config);
      if (!suggestions.length) return;
      // Insert suggested links at the end of the document
      const linkLine = '\n\n' + suggestions.map((s) => `[[${s}]]`).join(' · ');
      const docLen = view.state.doc.length;
      view.dispatch({ changes: { from: docLen, to: docLen, insert: linkLine } });
      toast({ title: t('smartLinks.inserted', { count: suggestions.length }) });
    } catch (err) {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    }
  }, [viewRef, t]);

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
        <ToolbarBtn icon={<Printer size={14} />} title={t('toolbar.print')} onClick={handlePrint} />
        <ToolbarBtn icon={<Settings2 size={14} />} title={t('typesetting.title')} onClick={() => setTypesettingOpen(true)} />
        <ToolbarBtn
          icon={isListening ? <MicOff size={14} /> : <Mic size={14} />}
          title={isListening ? t('voice.stop') : t('voice.start')}
          onClick={handleVoiceToggle}
          active={isListening}
        />
        <AudioRecorder
          onSaved={(relPath) => {
            const view = viewRef.current;
            if (!view) return;
            // Insert audio embed as Markdown image syntax (rendered as <audio> by preview)
            const embed = `![${relPath.split('/').pop() || 'audio'}](${relPath})`;
            const { from } = view.state.selection.main;
            view.dispatch({
              changes: { from, to: from, insert: `\n${embed}\n` },
              selection: { anchor: from + embed.length + 2 },
            });
          }}
        />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Canvas ─────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<PenTool size={14} />} title={t('canvas.title')} onClick={() => setCanvasOpen(true)} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── AI ─────────────────────────────────────────── */}
      <ToolbarGroup>
        <div className="relative">
          <ToolbarBtn
            icon={<Sparkles size={14} />}
            title={t('inlineAi.title')}
            onClick={handleAiClick}
          />
          {aiMenuOpen && (
            <AiActionMenu
              onSelect={handleAiAction}
              onSuggestTags={handleSuggestTags}
              onSuggestLinks={handleSuggestLinks}
              onClose={() => setAiMenuOpen(false)}
              fileExt={fileExt}
            />
          )}
        </div>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Agent shortcut ─────────────────────────────── */}
      <ToolbarGroup>
        <div className="relative">
          <ToolbarBtn
            icon={<Bot size={14} />}
            title={t('agent.title')}
            onClick={() => {
              useUIStore.getState().setSidePanelVisible(true);
              useUIStore.getState().setSidePanelTab('agent');
            }}
            active={agentRunning}
          />
          {/* Running badge */}
          {agentRunning && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-theme-accent animate-pulse" />
          )}
        </div>
      </ToolbarGroup>

      {/* ── Typesetting dialog ──────────────────────────── */}
      <TypesettingDialog
        open={typesettingOpen}
        onClose={() => setTypesettingOpen(false)}
        content={viewRef.current?.state.doc.toString() || ''}
      />

      {/* ── Canvas editor overlay ──────────────────────── */}
      {canvasOpen && (
        <CanvasEditor
          onSaved={(relPath) => {
            const view = viewRef.current;
            if (!view) return;
            const embed = `![canvas](${relPath})`;
            const { from } = view.state.selection.main;
            view.dispatch({
              changes: { from, to: from, insert: `\n${embed}\n` },
              selection: { anchor: from + embed.length + 2 },
            });
            setCanvasOpen(false);
          }}
          onClose={() => setCanvasOpen(false)}
        />
      )}
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

// ── AI action popup menu ────────────────────────────────────

const AI_ACTIONS = [
  { key: 'rewrite', instruction: 'Rewrite this text to be clearer and more concise' },
  { key: 'improve', instruction: 'Improve the writing quality while preserving the meaning' },
  { key: 'shorter', instruction: 'Make this text shorter while keeping the key points' },
  { key: 'longer', instruction: 'Expand this text with more detail and explanation' },
  { key: 'translate', instruction: 'Translate this text to the other language (Chinese↔English)' },
  { key: 'summarize', instruction: 'Summarize this text into bullet points' },
  { key: 'explain', instruction: 'Explain this text in simpler terms' },
] as const;

// Academic-specific AI actions for Typst/LaTeX files
const ACADEMIC_ACTIONS_TYPST = [
  { key: 'fixErrors', instruction: 'Fix any compilation errors or syntax issues in this Typst code' },
  { key: 'convertToLatex', instruction: 'Convert this Typst code to equivalent LaTeX syntax' },
  { key: 'explainFormula', instruction: 'Explain what this mathematical formula or expression does in plain language' },
  { key: 'simplifyExpression', instruction: 'Algebraically simplify this mathematical expression' },
] as const;

const ACADEMIC_ACTIONS_LATEX = [
  { key: 'fixErrors', instruction: 'Fix any compilation errors or syntax issues in this LaTeX code' },
  { key: 'convertToTypst', instruction: 'Convert this LaTeX code to equivalent Typst syntax' },
  { key: 'explainFormula', instruction: 'Explain what this mathematical formula or expression does in plain language' },
  { key: 'simplifyExpression', instruction: 'Algebraically simplify this mathematical expression' },
] as const;

function AiActionMenu({
  onSelect,
  onSuggestTags,
  onSuggestLinks,
  onClose,
  fileExt,
}: {
  onSelect: (instruction: string) => void;
  onSuggestTags: () => void;
  onSuggestLinks: () => void;
  onClose: () => void;
  fileExt: string;
}) {
  const { t } = useTranslation();

  // Academic actions based on file type
  const academicActions = fileExt === 'typ'
    ? ACADEMIC_ACTIONS_TYPST
    : fileExt === 'tex'
      ? ACADEMIC_ACTIONS_LATEX
      : null;

  // Close on click outside
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="absolute top-full left-0 mt-1 z-50 min-w-[160px] bg-surface border border-theme-border rounded-lg shadow-lg py-1"
    >
      {AI_ACTIONS.map((action) => (
        <button
          key={action.key}
          type="button"
          className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-theme-hover transition-colors"
          onClick={() => onSelect(action.instruction)}
        >
          {t(`inlineAi.${action.key}`)}
        </button>
      ))}
      {/* Academic actions for Typst/LaTeX */}
      {academicActions && (
        <>
          <div className="h-px bg-theme-border my-1 mx-2" />
          {academicActions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="w-full text-left px-3 py-1.5 text-sm text-theme-accent hover:bg-theme-hover transition-colors"
              onClick={() => onSelect(action.instruction)}
            >
              {t(`inlineAi.${action.key}`)}
            </button>
          ))}
        </>
      )}
      {/* Intelligence actions separator */}
      <div className="h-px bg-theme-border my-1 mx-2" />
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-theme-hover transition-colors"
        onClick={onSuggestTags}
      >
        {t('smartTags.suggest')}
      </button>
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-theme-hover transition-colors"
        onClick={onSuggestLinks}
      >
        {t('smartLinks.suggest')}
      </button>
    </div>
  );
}
