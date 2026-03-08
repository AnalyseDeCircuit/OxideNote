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

  if (options.length === 0) return null;

  return {
    from,
    options,
    filter: false,
  };
}
