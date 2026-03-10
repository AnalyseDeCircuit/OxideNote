/**
 * EditorToolbar — unified formatting toolbar for Markdown, Typst, and LaTeX.
 *
 * Uses the FormatAdapter abstraction to apply correct syntax based on
 * the current file extension. All three languages share one toolbar UI
 * with buttons that produce the right markup automatically.
 *
 * Features:
 *   · Headings (H1–H3)            · Bold / Italic / Strikethrough / Code
 *   · Blockquote / Lists / Tables  · Link / Image / Math
 *   · Export (PDF/HTML/DOCX/Print) · Voice input / Audio recording
 *   · Compile (Typst/LaTeX)        · AI inline actions
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
  FileText,
  Mic,
  MicOff,
  Settings2,
  Printer,
  PenTool,
  Sparkles,
  Bot,
  Play,
} from 'lucide-react';
import { useNoteStore } from '@/store/noteStore';
import { useChatStore } from '@/store/chatStore';
import { useUIStore } from '@/store/uiStore';
import { useAgentStore } from '@/store/agentStore';
import { exportToPdf } from '@/lib/exportPdf';
import { exportToHtml, createHtmlMarked, buildHtmlDocument } from '@/lib/exportHtml';
import { exportToDocx } from '@/lib/exportDocx';
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
import {
  getFormatAdapter,
  wrapSelection,
  insertLinePrefix,
  toggleHeading,
  insertBlock,
} from '@/lib/formatAdapter';

// ═══════════════════════════════════════════════════════════════
// EditorToolbar component
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

  // Derive file extension and format adapter
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const fileExt = activeTabPath?.split('.').pop() || 'md';
  const adapter = getFormatAdapter(fileExt);
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

  // ── PDF export ────────────────────────────────────────────
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

  // ── HTML export ───────────────────────────────────────────
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

  // ── DOCX export ───────────────────────────────────────────
  const handleExportDocx = async () => {
    const view = viewRef.current;
    if (!view) return;
    const content = view.state.doc.toString();
    const activeTab = useNoteStore.getState().activeTabPath;
    const title = activeTab ? stripNoteExtension(activeTab).split('/').pop() || 'export' : 'export';
    try {
      const exported = await exportToDocx(content, title);
      if (exported) toast({ title: t('export.docxExportSuccess') });
    } catch (err) {
      toast({ title: t('export.docxExportFailed'), description: String(err), variant: 'error' });
    }
  };

  // ── Print via system browser ──────────────────────────────
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
      const cleanHtml = DOMPurify.sanitize(rawHtml, {
        ADD_TAGS: ['math-block'],
        ADD_ATTR: ['displaystyle'],
      });
      const fullHtml = buildHtmlDocument(title, cleanHtml);
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
      const config = useChatStore.getState().config;
      const noteTitle = useNoteStore.getState().activeTabPath ? stripNoteExtension(useNoteStore.getState().activeTabPath!).split('/').pop() || '' : '';
      triggerAiContinue(view, config, noteTitle).catch((err) => {
        toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
      });
    } else {
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
    const ext = activePath.split('.').pop() || 'md';
    triggerAiTransform(view, instruction, config, noteTitle, ext).catch((err) => {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    });
  }, [viewRef, t]);

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
      const tagLine = '\n\n' + tags.map((tag) => `#${tag}`).join(' ');
      const docLen = view.state.doc.length;
      view.dispatch({ changes: { from: docLen, to: docLen, insert: tagLine } });
      toast({ title: t('smartTags.inserted', { count: tags.length }) });
    } catch (err) {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    }
  }, [viewRef, t]);

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
      const linkLine = '\n\n' + suggestions.map((s) => `[[${s}]]`).join(' · ');
      const docLen = view.state.doc.length;
      view.dispatch({ changes: { from: docLen, to: docLen, insert: linkLine } });
      toast({ title: t('smartLinks.inserted', { count: suggestions.length }) });
    } catch (err) {
      toast({ title: t('inlineAi.error'), description: String(err), variant: 'error' });
    }
  }, [viewRef, t]);

  // ── Compile handler for .typ/.tex files ───────────────────
  const isCompilable = fileExt === 'typ' || fileExt === 'tex';

  const handleCompile = useCallback(() => {
    if (!activeTabPath) return;
    window.dispatchEvent(new CustomEvent('compile-request', { detail: { path: activeTabPath } }));
  }, [activeTabPath]);

  // ── Format-aware toolbar actions ──────────────────────────
  // These use the adapter to produce correct syntax per language

  const doWrap = (key: 'bold' | 'italic' | 'strikethrough' | 'inlineCode' | 'inlineMath') => {
    const view = viewRef.current;
    if (view) wrapSelection(view, adapter[key]);
  };

  const doHeading = (level: number) => {
    const view = viewRef.current;
    if (view) toggleHeading(view, adapter, level);
  };

  const doLinePrefix = (key: 'quote' | 'unorderedList' | 'orderedList') => {
    const view = viewRef.current;
    if (!view) return;
    const val = adapter[key];
    // Block-style values (containing newlines) use insertBlock instead of line prefix
    if (val.includes('\n')) {
      insertBlock(view, val);
    } else {
      insertLinePrefix(view, val);
    }
  };

  const doBlock = (key: 'horizontalRule' | 'table' | 'mathBlock') => {
    const view = viewRef.current;
    if (view) insertBlock(view, adapter[key]);
  };

  const doLink = () => {
    const view = viewRef.current;
    if (view) insertBlock(view, adapter.link('link text', 'url'));
  };

  const doImage = () => {
    const view = viewRef.current;
    if (view) insertBlock(view, adapter.image('alt', 'image-url'));
  };

  // Language badge for current file type
  const langBadge = adapter.lang.toUpperCase();

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-theme-border bg-surface shrink-0 overflow-x-auto">
      {/* ── Language indicator ────────────────────────────── */}
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-theme-accent/10 text-theme-accent mr-1 select-none">
        {langBadge}
      </span>

      {/* ── Headings ─────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Heading1 size={14} />} title={t('toolbar.heading1')} onClick={() => doHeading(1)} />
        <ToolbarBtn icon={<Heading2 size={14} />} title={t('toolbar.heading2')} onClick={() => doHeading(2)} />
        <ToolbarBtn icon={<Heading3 size={14} />} title={t('toolbar.heading3')} onClick={() => doHeading(3)} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Inline formatting ────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Bold size={14} />} title={t('toolbar.bold')} onClick={() => doWrap('bold')} />
        <ToolbarBtn icon={<Italic size={14} />} title={t('toolbar.italic')} onClick={() => doWrap('italic')} />
        <ToolbarBtn icon={<Strikethrough size={14} />} title={t('toolbar.strikethrough')} onClick={() => doWrap('strikethrough')} />
        <ToolbarBtn icon={<Code size={14} />} title={t('toolbar.code')} onClick={() => doWrap('inlineCode')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Block elements ───────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Quote size={14} />} title={t('toolbar.quote')} onClick={() => doLinePrefix('quote')} />
        <ToolbarBtn icon={<List size={14} />} title={t('toolbar.unorderedList')} onClick={() => doLinePrefix('unorderedList')} />
        <ToolbarBtn icon={<ListOrdered size={14} />} title={t('toolbar.orderedList')} onClick={() => doLinePrefix('orderedList')} />
        <ToolbarBtn icon={<Table2 size={14} />} title={t('toolbar.table')} onClick={() => doBlock('table')} />
        <ToolbarBtn icon={<Minus size={14} />} title={t('toolbar.horizontalRule')} onClick={() => doBlock('horizontalRule')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Embed / math ─────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<Link size={14} />} title={t('toolbar.link')} onClick={doLink} />
        <ToolbarBtn icon={<Image size={14} />} title={t('toolbar.image')} onClick={doImage} />
        <ToolbarBtn icon={<Sigma size={14} />} title={t('toolbar.math')} onClick={() => doBlock('mathBlock')} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Export & voice ───────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<FileDown size={14} />} title={t('pdf.export')} onClick={handleExportPdf} />
        <ToolbarBtn icon={<FileCode size={14} />} title={t('export.htmlExport')} onClick={handleExportHtml} />
        <ToolbarBtn icon={<FileText size={14} />} title={t('export.docxExport')} onClick={handleExportDocx} />
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
            const embed = adapter.lang === 'md'
              ? `![${relPath.split('/').pop() || 'audio'}](${relPath})`
              : adapter.link(relPath.split('/').pop() || 'audio', relPath);
            const { from } = view.state.selection.main;
            view.dispatch({
              changes: { from, to: from, insert: `\n${embed}\n` },
              selection: { anchor: from + embed.length + 2 },
            });
          }}
        />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── Compile (Typst/LaTeX only) ───────────────────── */}
      {isCompilable && (
        <>
          <ToolbarGroup>
            <ToolbarBtn
              icon={<Play size={14} />}
              title={t('toolbar.compile')}
              onClick={handleCompile}
            />
          </ToolbarGroup>
          <ToolbarDivider />
        </>
      )}

      {/* ── Canvas ───────────────────────────────────────── */}
      <ToolbarGroup>
        <ToolbarBtn icon={<PenTool size={14} />} title={t('canvas.title')} onClick={() => setCanvasOpen(true)} />
      </ToolbarGroup>

      <ToolbarDivider />

      {/* ── AI ───────────────────────────────────────────── */}
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

      {/* ── Agent shortcut ───────────────────────────────── */}
      <ToolbarGroup>
        <div className="relative">
          <ToolbarBtn
            icon={<Bot size={14} />}
            title={t('agent.title')}
            onClick={() => useUIStore.getState().setSidebarSection('agent')}
            active={agentRunning}
          />
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
            const embed = adapter.image('canvas', relPath);
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
      aria-label={title}
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
