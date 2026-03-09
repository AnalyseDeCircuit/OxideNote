import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, FileEdit, ChevronDown, ChevronRight } from 'lucide-react';

import { useChatStore, type EditSuggestion } from '@/store/chatStore';
import { getEditorView } from '@/lib/editorViewRef';
import { toast } from '@/hooks/useToast';

interface Props {
  edit: EditSuggestion;
  index: number;
}

/** Inline diff preview card for AI-suggested edits */
export function EditCard({ edit, index }: Props) {
  const { t } = useTranslation();
  const applyEdit = useChatStore((s) => s.applyEdit);
  const rejectEdit = useChatStore((s) => s.rejectEdit);
  const [expanded, setExpanded] = useState(true);

  // Compute inline diff (line-level)
  const diffLines = useMemo(() => computeLineDiff(edit.originalContent, edit.newContent), [edit.originalContent, edit.newContent]);

  const handleApply = () => {
    const view = getEditorView();
    if (!view) return;

    const content = view.state.doc.toString();

    // Strategy 1: Exact match
    const idx = content.indexOf(edit.originalContent);
    if (idx >= 0) {
      view.dispatch({
        changes: { from: idx, to: idx + edit.originalContent.length, insert: edit.newContent },
      });
      applyEdit(index);
      return;
    }

    // Strategy 2: Flexible whitespace match
    const escaped = edit.originalContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped.replace(/\s+/g, '\\s+'));
    const match = content.match(pattern);
    if (match?.index !== undefined) {
      view.dispatch({
        changes: { from: match.index, to: match.index + match[0].length, insert: edit.newContent },
      });
      applyEdit(index);
      return;
    }

    // Both strategies failed — content may have changed
    toast({ title: t('chat.error'), description: edit.description, variant: 'warning' });
  };

  const handleReject = () => {
    rejectEdit(index);
  };

  const isResolved = edit.status !== 'pending';

  return (
    <div className={`rounded-lg border overflow-hidden text-xs ${
      edit.status === 'applied'
        ? 'border-green-500/50 opacity-60'
        : edit.status === 'rejected'
          ? 'border-red-500/50 opacity-60'
          : 'border-theme-border'
    }`}>
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-background hover:bg-theme-hover transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
        <FileEdit className="w-3 h-3 text-theme-accent shrink-0" />
        <span className="flex-1 truncate text-foreground">{edit.description}</span>
        <span className="text-muted-foreground truncate max-w-[120px]">{edit.file}</span>
      </button>

      {/* Diff content */}
      {expanded && (
        <div className="border-t border-theme-border">
          <div className="overflow-x-auto">
            {diffLines.map((line, i) => (
              <div
                key={i}
                className={`px-2.5 py-0.5 font-mono whitespace-pre-wrap ${
                  line.type === 'removed'
                    ? 'bg-red-500/10 text-red-400 line-through'
                    : line.type === 'added'
                      ? 'bg-green-500/10 text-green-400'
                      : 'text-muted-foreground'
                }`}
              >
                <span className="select-none mr-2">
                  {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
                </span>
                {line.text}
              </div>
            ))}
          </div>

          {/* Action buttons */}
          {!isResolved && (
            <div className="flex items-center justify-end gap-1 px-2.5 py-1.5 border-t border-theme-border bg-background">
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs
                  bg-green-500/15 text-green-400 hover:bg-green-500/25 transition-colors"
                onClick={handleApply}
              >
                <Check className="w-3 h-3" />
                {t('chat.applyEdit')}
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs
                  bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                onClick={handleReject}
              >
                <X className="w-3 h-3" />
                {t('chat.rejectEdit')}
              </button>
            </div>
          )}

          {/* Status indicator for resolved edits */}
          {isResolved && (
            <div className={`px-2.5 py-1 text-center text-xs ${
              edit.status === 'applied' ? 'text-green-400' : 'text-red-400'
            }`}>
              {edit.status === 'applied' ? t('chat.applyEdit') : t('chat.rejectEdit')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Simple line diff without external dependency ───────────

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

/** Compute a simple line-level diff between two strings */
function computeLineDiff(original: string, modified: string): DiffLine[] {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff for small texts
  const lcs = computeLCS(origLines, modLines);

  let oi = 0;
  let mi = 0;
  let li = 0;

  while (oi < origLines.length || mi < modLines.length) {
    if (li < lcs.length && oi < origLines.length && mi < modLines.length && origLines[oi] === lcs[li] && modLines[mi] === lcs[li]) {
      result.push({ type: 'unchanged', text: origLines[oi] });
      oi++;
      mi++;
      li++;
    } else if (oi < origLines.length && (li >= lcs.length || origLines[oi] !== lcs[li])) {
      result.push({ type: 'removed', text: origLines[oi] });
      oi++;
    } else if (mi < modLines.length && (li >= lcs.length || modLines[mi] !== lcs[li])) {
      result.push({ type: 'added', text: modLines[mi] });
      mi++;
    }
  }

  return result;
}

/** Compute LCS (Longest Common Subsequence) of two string arrays */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}
