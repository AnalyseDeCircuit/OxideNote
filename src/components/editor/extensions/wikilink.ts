import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Creates a WikiLink click handler that calls the provided callback */
export function wikilinkExtension(onNavigate: (target: string) => void) {
  const wikilinkMark = Decoration.mark({
    class: 'cm-wikilink',
    attributes: { 'data-wikilink': 'true' },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          let match;
          WIKILINK_RE.lastIndex = 0;
          while ((match = WIKILINK_RE.exec(text)) !== null) {
            const start = from + match.index;
            const end = start + match[0].length;
            builder.add(start, end, wikilinkMark);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );

  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      // Find the line and check for wikilinks
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      WIKILINK_RE.lastIndex = 0;
      let match;
      while ((match = WIKILINK_RE.exec(lineText)) !== null) {
        const start = line.from + match.index;
        const end = start + match[0].length;
        if (pos >= start && pos <= end) {
          const target = match[1].trim();
          event.preventDefault();
          onNavigate(target);
          return true;
        }
      }
      return false;
    },
  });

  const cursorStyle = EditorView.theme({
    '.cm-wikilink': {
      color: 'var(--theme-accent)',
      textDecoration: 'underline',
      textDecorationStyle: 'dotted',
      textUnderlineOffset: '3px',
      cursor: 'pointer',
    },
  });

  return [plugin, clickHandler, cursorStyle];
}
