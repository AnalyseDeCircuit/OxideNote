/**
 * SlashCommands — CodeMirror completion source for `/` commands.
 *
 * When the user types `/` at the beginning of a line (or after whitespace),
 * a popup offers common Markdown block insertions:
 *   heading, list, table, code block, callout, math, divider, etc.
 *
 * Each command replaces the `/query` with the corresponding Markdown template.
 */

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { triggerAiTransform, triggerAiContinue } from './aiInline';
import { useChatStore } from '@/store/chatStore';
import { useNoteStore } from '@/store/noteStore';

interface SlashCommand {
  label: string;
  detail: string;
  template: string;
}

// ── Available slash commands ────────────────────────────────
const COMMANDS: SlashCommand[] = [
  { label: 'heading1', detail: 'H1', template: '# ' },
  { label: 'heading2', detail: 'H2', template: '## ' },
  { label: 'heading3', detail: 'H3', template: '### ' },
  { label: 'bullet', detail: 'Bulleted list', template: '- ' },
  { label: 'numbered', detail: 'Numbered list', template: '1. ' },
  { label: 'todo', detail: 'Task item', template: '- [ ] ' },
  { label: 'quote', detail: 'Blockquote', template: '> ' },
  { label: 'code', detail: 'Code block', template: '```\n\n```' },
  { label: 'table', detail: 'Table', template: '| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n|          |          |          |' },
  { label: 'math', detail: 'Math block', template: '$$\n\n$$' },
  { label: 'divider', detail: 'Horizontal rule', template: '---' },
  { label: 'callout', detail: 'Callout block', template: '> [!note] Title\n> Content' },
  { label: 'mermaid', detail: 'Mermaid diagram', template: '```mermaid\ngraph TD\n  A --> B\n```' },
  { label: 'image', detail: 'Image', template: '![alt](url)' },
  { label: 'link', detail: 'Link', template: '[text](url)' },
  { label: 'footnote', detail: 'Footnote', template: '[^1]: ' },
];

// AI-related slash commands use a special `template: ''` and are handled
// by the `apply` function which dispatches AI operations on the editor.
const AI_COMMANDS: SlashCommand[] = [
  { label: 'ai-rewrite', detail: 'AI: Rewrite paragraph', template: '' },
  { label: 'ai-continue', detail: 'AI: Continue writing', template: '' },
  { label: 'ai-summarize', detail: 'AI: Summarize note', template: '' },
  { label: 'ai-translate', detail: 'AI: Translate', template: '' },
];

/**
 * CodeMirror completion source for slash commands.
 * Triggers when `/` appears at the start of a line or after whitespace.
 */
export function slashCommandSource(context: CompletionContext): CompletionResult | null {
  // Match `/` followed by optional word characters
  const match = context.matchBefore(/(?:^|\s)\/([\w]*)$/);
  if (!match) return null;

  // Extract the query after `/`
  const slashIdx = match.text.lastIndexOf('/');
  const query = match.text.substring(slashIdx + 1).toLowerCase();
  const from = match.from + slashIdx; // position of the `/`

  const options: Completion[] = COMMANDS
    .filter((cmd) => cmd.label.includes(query))
    .map((cmd) => ({
      label: `/${cmd.label}`,
      detail: cmd.detail,
      apply: (view, _completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: cmd.template },
          selection: { anchor: from + cmd.template.length },
        });
      },
    }));

  // Add AI slash commands with special apply handlers
  const aiOptions: Completion[] = AI_COMMANDS
    .filter((cmd) => cmd.label.includes(query))
    .map((cmd) => ({
      label: `/${cmd.label}`,
      detail: cmd.detail,
      apply: (view, _completion, from, to) => {
        // Remove the slash command text first
        view.dispatch({ changes: { from, to, insert: '' } });

        const config = useChatStore.getState().config;
        const activePath = useNoteStore.getState().activeTabPath || '';
        const noteTitle = activePath.replace(/\.[^.]+$/, '').split('/').pop() || '';
        const fileExt = activePath.split('.').pop() || 'md';

        if (cmd.label === 'ai-continue') {
          triggerAiContinue(view, config, noteTitle).catch(console.warn);
        } else {
          // For transform commands, select the current paragraph
          const cursor = view.state.selection.main.head;
          const line = view.state.doc.lineAt(cursor);
          // Find paragraph bounds (consecutive non-empty lines)
          let paraStart = line.from;
          let paraEnd = line.to;
          // Expand backward
          for (let ln = line.number - 1; ln >= 1; ln--) {
            const prev = view.state.doc.line(ln);
            if (prev.text.trim() === '') break;
            paraStart = prev.from;
          }
          // Expand forward
          for (let ln = line.number + 1; ln <= view.state.doc.lines; ln++) {
            const next = view.state.doc.line(ln);
            if (next.text.trim() === '') break;
            paraEnd = next.to;
          }

          const paraText = view.state.doc.sliceString(paraStart, paraEnd);
          if (paraText.trim()) {
            // Select the paragraph, then transform
            view.dispatch({
              selection: { anchor: paraStart, head: paraEnd },
            });

            const instruction = cmd.label === 'ai-rewrite'
              ? 'Rewrite this text to be clearer and more concise'
              : cmd.label === 'ai-summarize'
                ? 'Summarize this text into bullet points'
                : 'Translate this text to the other language (Chinese↔English)';

            triggerAiTransform(view, instruction, config, noteTitle, fileExt).catch(console.warn);
          }
        }
      },
    }));

  const allOptions = [...options, ...aiOptions];
  if (allOptions.length === 0) return null;

  return {
    from,
    options: allOptions,
    filter: false,
  };
}
