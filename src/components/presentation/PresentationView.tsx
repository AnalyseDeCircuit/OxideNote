/**
 * PresentationView — Fullscreen slide presentation mode
 *
 * Splits the current note by `---` (horizontal rule) into slides,
 * renders each slide using the existing MarkdownPreview pipeline,
 * and provides arrow-key / click navigation.
 *
 * Features:
 *   · Reuses MarkdownPreview for full rendering (KaTeX, Mermaid, code highlight, etc.)
 *   · ESC to exit, ← → or click to navigate
 *   · Slide counter overlay (bottom-right)
 *   · Smooth transitions between slides
 */

import { useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '@/store/uiStore';
import { useNoteStore } from '@/store/noteStore';
import { MarkdownPreview } from '@/components/editor/MarkdownPreview';

// ── Slide separator: `---` on its own line ──────────────────
const SLIDE_SEPARATOR = /^---\s*$/m;

// ── Frontmatter: YAML block at the very start of the document ───
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

/**
 * Split markdown content into slide segments.
 * Strips frontmatter first, then each `---` horizontal rule becomes a slide boundary.
 */
function splitSlides(content: string): string[] {
  // Strip frontmatter if present
  const stripped = content.replace(FRONTMATTER_RE, '');
  const slides = stripped.split(SLIDE_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  return slides.length > 0 ? slides : [''];
}

interface PresentationViewProps {
  onClose: () => void;
}

export function PresentationView({ onClose }: PresentationViewProps) {
  const { t } = useTranslation();
  const currentSlide = useUIStore((s) => s.currentSlide);
  const setCurrentSlide = useUIStore((s) => s.setCurrentSlide);
  const content = useNoteStore((s) => s.activeContent);

  const slides = useMemo(() => splitSlides(content), [content]);
  const totalSlides = slides.length;
  const safeIndex = Math.min(currentSlide, totalSlides - 1);

  // Navigate between slides
  const goNext = useCallback(() => {
    setCurrentSlide(Math.min(safeIndex + 1, totalSlides - 1));
  }, [safeIndex, totalSlides, setCurrentSlide]);

  const goPrev = useCallback(() => {
    setCurrentSlide(Math.max(safeIndex - 1, 0));
  }, [safeIndex, setCurrentSlide]);

  // Keyboard navigation: ← → ↑ ↓ Space Enter ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
          e.preventDefault();
          goNext();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          goPrev();
          break;
        case 'Home':
          e.preventDefault();
          setCurrentSlide(0);
          break;
        case 'End':
          e.preventDefault();
          setCurrentSlide(totalSlides - 1);
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goNext, goPrev, onClose, setCurrentSlide, totalSlides]);

  // Click left/right halves for prev/next navigation
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      if (clickX < rect.width / 3) {
        goPrev();
      } else {
        goNext();
      }
    },
    [goNext, goPrev],
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-background flex flex-col items-center justify-center cursor-default"
      onClick={handleClick}
    >
      {/* ── Slide content ────────────────────────────────── */}
      <div className="w-full max-w-4xl flex-1 min-h-0 overflow-auto px-12 py-8 flex items-center">
        <div className="w-full presentation-slide">
          <MarkdownPreview content={slides[safeIndex]} className="text-lg" />
        </div>
      </div>

      {/* ── Bottom bar: slide counter + exit button ──────── */}
      <div className="absolute bottom-4 right-6 flex items-center gap-4 select-none">
        <span className="text-sm text-muted-foreground font-mono">
          {safeIndex + 1} / {totalSlides}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="px-3 py-1 text-xs rounded bg-theme-hover text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('presentation.exit', 'ESC')}
        </button>
      </div>

      {/* ── Navigation hints (fade on hover) ─────────────── */}
      {totalSlides > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-muted-foreground/50 select-none">
          ← → {t('presentation.navigate', '切换幻灯片')}
        </div>
      )}
    </div>
  );
}
