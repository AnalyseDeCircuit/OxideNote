import { useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import type { DiffChunk, HistoryEntry } from '@/lib/api';

// ── Types ───────────────────────────────────────────────────

interface DiffLine {
  text: string;
  type: 'equal' | 'insert' | 'delete';
}

interface Props {
  entry: HistoryEntry;
  diff: DiffChunk[];
  onBack: () => void;
  onRestore: (entry: HistoryEntry) => void;
}

// ── Helpers ─────────────────────────────────────────────────

/** Split diff chunks into individual lines with type annotations */
function splitChunksToLines(chunks: DiffChunk[]): DiffLine[] {
  const result: DiffLine[] = [];
  for (const chunk of chunks) {
    const type = chunk.tag as DiffLine['type'];
    // Split by newline, preserving empty trailing lines
    const lines = chunk.value.split('\n');
    // Last element after split on trailing \n is empty — skip it
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1 && lines[i] === '') continue;
      result.push({ text: lines[i], type });
    }
  }
  return result;
}

/** Build left (old) and right (new) column lines for side-by-side view */
function buildSideBySide(lines: DiffLine[]) {
  const left: (DiffLine & { lineNo: number })[] = [];
  const right: (DiffLine & { lineNo: number })[] = [];
  let leftNo = 0;
  let rightNo = 0;

  for (const line of lines) {
    if (line.type === 'equal') {
      leftNo++;
      rightNo++;
      left.push({ ...line, lineNo: leftNo });
      right.push({ ...line, lineNo: rightNo });
    } else if (line.type === 'delete') {
      leftNo++;
      left.push({ ...line, lineNo: leftNo });
      // Placeholder on right side
      right.push({ text: '', type: 'delete', lineNo: -1 });
    } else if (line.type === 'insert') {
      rightNo++;
      // Placeholder on left side
      left.push({ text: '', type: 'insert', lineNo: -1 });
      right.push({ ...line, lineNo: rightNo });
    }
  }

  return { left, right };
}

// ── Component ───────────────────────────────────────────────

export function DiffView({ entry, diff, onBack, onRestore }: Props) {
  const { t } = useTranslation();
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  const allLines = useMemo(() => splitChunksToLines(diff), [diff]);
  const { left, right } = useMemo(() => buildSideBySide(allLines), [allLines]);

  // Count changed lines
  const changedCount = useMemo(
    () => allLines.filter((l) => l.type !== 'equal').length,
    [allLines],
  );

  // Synchronized scrolling between left and right panels
  useEffect(() => {
    const leftEl = leftRef.current;
    const rightEl = rightRef.current;
    if (!leftEl || !rightEl) return;

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      target.scrollTop = source.scrollTop;
      syncingRef.current = false;
    };

    const handleLeftScroll = syncScroll(leftEl, rightEl);
    const handleRightScroll = syncScroll(rightEl, leftEl);

    leftEl.addEventListener('scroll', handleLeftScroll);
    rightEl.addEventListener('scroll', handleRightScroll);
    return () => {
      leftEl.removeEventListener('scroll', handleLeftScroll);
      rightEl.removeEventListener('scroll', handleRightScroll);
    };
  }, []);

  const timestamp = new Date(entry.timestamp).toLocaleString();

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-theme-border bg-surface shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
          aria-label={t('graph.close')}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-xs text-muted-foreground flex-1 truncate">
          {timestamp}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('diffView.linesChanged', { count: changedCount })}
        </span>
        <button
          onClick={() => onRestore(entry)}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-theme-hover hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors"
        >
          <RotateCcw size={12} />
          {t('history.restore')}
        </button>
      </div>

      {/* Side-by-side columns */}
      <div className="flex-1 min-h-0 flex">
        {/* Left: old version (deletions shown) */}
        <div className="flex-1 flex flex-col border-r border-theme-border">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-background border-b border-theme-border">
            {t('diffView.oldVersion')}
          </div>
          <div ref={leftRef} className="flex-1 overflow-y-auto">
            {left.map((line, i) => (
              <DiffLineRow key={i} line={line} side="left" />
            ))}
          </div>
        </div>

        {/* Right: current version (insertions shown) */}
        <div className="flex-1 flex flex-col">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-background border-b border-theme-border">
            {t('diffView.currentVersion')}
          </div>
          <div ref={rightRef} className="flex-1 overflow-y-auto">
            {right.map((line, i) => (
              <DiffLineRow key={i} line={line} side="right" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Line renderer ───────────────────────────────────────────

function DiffLineRow({ line, side }: { line: DiffLine & { lineNo: number }; side: 'left' | 'right' }) {
  const isEmpty = line.lineNo === -1;

  // Styling per line type
  let bgClass = '';
  let textClass = 'text-muted-foreground';

  if (!isEmpty) {
    if (line.type === 'delete' && side === 'left') {
      bgClass = 'bg-red-500/10';
      textClass = 'text-red-400';
    } else if (line.type === 'insert' && side === 'right') {
      bgClass = 'bg-green-500/10';
      textClass = 'text-green-400';
    }
  }

  return (
    <div className={`flex font-mono text-xs leading-5 min-h-[20px] ${bgClass}`}>
      {/* Line number gutter */}
      <span className="w-8 shrink-0 text-right pr-2 text-[10px] text-muted-foreground/50 select-none">
        {isEmpty ? '' : line.lineNo}
      </span>
      {/* Content */}
      <span className={`flex-1 whitespace-pre-wrap break-all px-1 ${textClass}`}>
        {isEmpty ? '\u00A0' : (line.text || '\u00A0')}
      </span>
    </div>
  );
}
