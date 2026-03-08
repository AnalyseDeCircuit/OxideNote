import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { getBlockContent } from '@/lib/api';

const BLOCK_REF_RE = /\[\[([^\]|#]+)?#\^([\w-]+)(?:\|([^\]]+))?\]\]/g;

const blockContentCache = new Map<string, string | null>();
const pendingLoads = new Map<string, Promise<void>>();
export const refreshBlockRefEffect = StateEffect.define<void>();

class BlockEmbedWidget extends WidgetType {
  constructor(
    private readonly notePath: string,
    private readonly blockId: string,
    private readonly content: string | null | undefined,
  ) {
    super();
  }

  eq(other: BlockEmbedWidget) {
    return this.notePath === other.notePath
      && this.blockId === other.blockId
      && this.content === other.content;
  }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-block-embed';
    wrap.dataset.notePath = this.notePath;
    wrap.dataset.blockId = this.blockId;

    if (this.content === undefined) {
      wrap.classList.add('cm-block-embed-loading');
      wrap.textContent = `Loading block ^${this.blockId}...`;
      return wrap;
    }

    if (this.content === null) {
      wrap.classList.add('cm-block-embed-error');
      wrap.textContent = `Block not found: ^${this.blockId}`;
      return wrap;
    }

    wrap.classList.add('cm-block-embed-loaded');
    wrap.textContent = this.content;
    return wrap;
  }
}

function buildCacheKey(notePath: string, blockId: string): string {
  return `${notePath}#^${blockId}`;
}

export function clearBlockRefCache(notePath?: string) {
  if (!notePath) {
    blockContentCache.clear();
    pendingLoads.clear();
    return;
  }

  for (const key of blockContentCache.keys()) {
    if (key.startsWith(`${notePath}#^`)) {
      blockContentCache.delete(key);
    }
  }
  for (const key of pendingLoads.keys()) {
    if (key.startsWith(`${notePath}#^`)) {
      pendingLoads.delete(key);
    }
  }
}

export function blockRefExtension(getCurrentNotePath: () => string) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged
          || update.viewportChanged
          || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshBlockRefEffect)))
        ) {
          this.decorations = this.build(update.view);
        }
      }

      private queueLoad(view: EditorView, notePath: string, blockId: string) {
        const cacheKey = buildCacheKey(notePath, blockId);
        if (blockContentCache.has(cacheKey) || pendingLoads.has(cacheKey)) {
          return;
        }

        const load = getBlockContent(notePath, blockId)
          .then((content) => {
            blockContentCache.set(cacheKey, content);
          })
          .catch(() => {
            blockContentCache.set(cacheKey, null);
          })
          .finally(() => {
            pendingLoads.delete(cacheKey);
            requestAnimationFrame(() => {
              if (!view.dom.isConnected) return;
              view.dispatch({ effects: [] });
            });
          });

        pendingLoads.set(cacheKey, load.then(() => undefined));
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          let match: RegExpExecArray | null;
          BLOCK_REF_RE.lastIndex = 0;

          while ((match = BLOCK_REF_RE.exec(text)) !== null) {
            const start = from + match.index;
            const end = start + match[0].length;
            const targetNote = match[1]?.trim() || getCurrentNotePath();
            const blockId = match[2];
            const cacheKey = buildCacheKey(targetNote, blockId);
            const content = blockContentCache.get(cacheKey);

            this.queueLoad(view, targetNote, blockId);

            builder.add(
              start,
              end,
              Decoration.replace({
                widget: new BlockEmbedWidget(targetNote, blockId, content),
                block: true,
              }),
            );
          }
        }

        return builder.finish();
      }
    },
    { decorations: (value) => value.decorations },
  );

  return plugin;
}
