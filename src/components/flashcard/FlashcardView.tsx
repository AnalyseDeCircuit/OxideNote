/**
 * FlashcardView — Main flashcard review interface
 *
 * Two modes:
 *   1. Deck list — scan vault for notes containing Q/A pairs
 *   2. Review session — flip cards, rate recall, apply SM-2 scheduling
 *
 * Opens as a full-screen modal overlay for immersive review.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, RotateCcw, ChevronLeft, PartyPopper } from 'lucide-react';
import {
  type CardWithState,
  type Deck,
  type Rating,
  loadDecks,
  loadReviewCards,
  submitReview,
} from '@/lib/flashcard';

interface FlashcardViewProps {
  onClose: () => void;
}

export function FlashcardView({ onClose }: FlashcardViewProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'decks' | 'review'>('decks');
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewCards, setReviewCards] = useState<CardWithState[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [completed, setCompleted] = useState(false);

  // Load decks on mount
  useEffect(() => {
    loadDecks()
      .then(setDecks)
      .catch(console.warn)
      .finally(() => setLoading(false));
  }, []);

  // Start review for a specific deck or all decks
  const startReview = useCallback(async (sourcePath?: string) => {
    setLoading(true);
    try {
      const cards = await loadReviewCards(sourcePath);
      if (cards.length === 0) {
        setCompleted(true);
        setMode('review');
      } else {
        setReviewCards(cards);
        setCurrentIndex(0);
        setShowAnswer(false);
        setCompleted(false);
        setMode('review');
      }
    } catch (err) {
      console.warn('Failed to load review cards:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Handle rating submission
  const handleRate = useCallback(async (rating: Rating) => {
    const card = reviewCards[currentIndex];
    if (!card) return;

    await submitReview(card.id, rating);

    const nextIndex = currentIndex + 1;
    if (nextIndex >= reviewCards.length) {
      setCompleted(true);
    } else {
      setCurrentIndex(nextIndex);
      setShowAnswer(false);
    }
  }, [reviewCards, currentIndex]);

  // Back to deck list
  const backToDecks = useCallback(() => {
    setMode('decks');
    setCompleted(false);
    setLoading(true);
    loadDecks()
      .then(setDecks)
      .catch(console.warn)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col items-center justify-center">
      {/* Header */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {mode === 'review' && (
            <button onClick={backToDecks} className="p-2 rounded hover:bg-theme-hover text-muted-foreground">
              <ChevronLeft size={20} />
            </button>
          )}
          <h2 className="text-lg font-semibold text-foreground">{t('flashcard.title')}</h2>
        </div>
        <button onClick={onClose} className="p-2 rounded hover:bg-theme-hover text-muted-foreground">
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="w-full max-w-2xl px-4">
        {loading ? (
          <div className="text-center text-muted-foreground">{t('sidebar.loading')}</div>
        ) : mode === 'decks' ? (
          <DeckListView decks={decks} onStartReview={startReview} t={t} />
        ) : completed ? (
          <CompletedView onBack={backToDecks} t={t} />
        ) : (
          <ReviewCardView
            card={reviewCards[currentIndex]}
            showAnswer={showAnswer}
            onFlip={() => setShowAnswer(true)}
            onRate={handleRate}
            progress={`${currentIndex + 1} / ${reviewCards.length}`}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

// ─── Sub-views ───────────────────────────────────────────────

function DeckListView({
  decks,
  onStartReview,
  t,
}: {
  decks: Deck[];
  onStartReview: (sourcePath?: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (decks.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        {t('flashcard.noDecks')}
      </div>
    );
  }

  const totalDue = decks.reduce((s, d) => s + d.dueCards + d.newCards, 0);

  return (
    <div className="space-y-3">
      {/* Review all button */}
      {totalDue > 0 && (
        <button
          onClick={() => onStartReview()}
          className="w-full p-4 rounded-lg bg-theme-accent/20 text-theme-accent font-medium hover:bg-theme-accent/30 transition-colors flex items-center justify-center gap-2"
        >
          <RotateCcw size={18} />
          {t('flashcard.review')} ({totalDue})
        </button>
      )}

      {/* Deck cards */}
      {decks.map((deck) => (
        <button
          key={deck.sourcePath}
          onClick={() => onStartReview(deck.sourcePath)}
          className="w-full text-left p-4 rounded-lg border border-theme-border hover:border-theme-accent/50 hover:bg-surface/50 transition-colors"
        >
          <div className="font-medium text-foreground">{deck.title}</div>
          <div className="text-sm text-muted-foreground mt-1 flex gap-4">
            <span>{t('flashcard.totalCards', { count: deck.totalCards })}</span>
            <span>{t('flashcard.dueToday', { count: deck.dueCards })}</span>
            <span>{t('flashcard.newCards', { count: deck.newCards })}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ReviewCardView({
  card,
  showAnswer,
  onFlip,
  onRate,
  progress,
  t,
}: {
  card: CardWithState;
  showAnswer: boolean;
  onFlip: () => void;
  onRate: (rating: Rating) => void;
  progress: string;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-6">
      {/* Progress */}
      <div className="text-center text-sm text-muted-foreground">{progress}</div>

      {/* Card */}
      <div
        className="min-h-[300px] p-8 rounded-xl border border-theme-border bg-surface flex flex-col items-center justify-center cursor-pointer select-none"
        onClick={() => !showAnswer && onFlip()}
      >
        <div className="text-lg text-foreground whitespace-pre-wrap text-center max-w-lg">
          {card.question}
        </div>

        {showAnswer && (
          <>
            <div className="w-24 h-px bg-theme-border my-6" />
            <div className="text-base text-muted-foreground whitespace-pre-wrap text-center max-w-lg">
              {card.answer}
            </div>
          </>
        )}

        {!showAnswer && (
          <div className="mt-6 text-sm text-muted-foreground">
            {t('flashcard.showAnswer')}
          </div>
        )}
      </div>

      {/* Rating buttons */}
      {showAnswer && (
        <div className="flex gap-3 justify-center">
          <RatingButton label={t('flashcard.again')} color="bg-red-500/20 text-red-400 hover:bg-red-500/30" onClick={() => onRate(0)} />
          <RatingButton label={t('flashcard.hard')} color="bg-orange-500/20 text-orange-400 hover:bg-orange-500/30" onClick={() => onRate(1)} />
          <RatingButton label={t('flashcard.good')} color="bg-green-500/20 text-green-400 hover:bg-green-500/30" onClick={() => onRate(2)} />
          <RatingButton label={t('flashcard.easy')} color="bg-blue-500/20 text-blue-400 hover:bg-blue-500/30" onClick={() => onRate(3)} />
        </div>
      )}
    </div>
  );
}

function RatingButton({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-6 py-2 rounded-lg font-medium transition-colors ${color}`}
    >
      {label}
    </button>
  );
}

function CompletedView({ onBack, t }: { onBack: () => void; t: (key: string) => string }) {
  return (
    <div className="text-center py-16 space-y-4">
      <PartyPopper size={36} className="mx-auto text-theme-accent" />
      <div className="text-lg text-foreground">{t('flashcard.completed')}</div>
      <button
        onClick={onBack}
        className="px-4 py-2 rounded-lg border border-theme-border hover:bg-surface transition-colors text-muted-foreground"
      >
        {t('flashcard.decks')}
      </button>
    </div>
  );
}
