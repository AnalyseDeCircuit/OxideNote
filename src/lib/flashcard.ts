/**
 * Flashcard Module — SM-2 Spaced Repetition System
 *
 * Parses Q/A pairs from Markdown notes and manages review scheduling
 * using the SM-2 algorithm. Card state is persisted in
 * `<vault>/.oxidenote/flashcards.json`.
 *
 * Markdown syntax for flashcards:
 *   Q: What is Rust?
 *   A: A systems programming language focused on safety and performance.
 */

import { readNote, writeNote, listTree, type TreeNode } from '@/lib/api';
import { stripNoteExtension } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────

export interface FlashCard {
  id: string;             // hash of source + question
  sourcePath: string;     // vault-relative path of the note
  question: string;
  answer: string;
}

export interface SM2State {
  ease: number;           // easiness factor (>= 1.3)
  interval: number;       // days until next review
  repetitions: number;    // consecutive correct answers
  due: string;            // ISO date string (YYYY-MM-DD)
}

export interface CardWithState extends FlashCard {
  sm2: SM2State;
}

/** Rating scale: 0=Again, 1=Hard, 2=Good, 3=Easy */
export type Rating = 0 | 1 | 2 | 3;

// Persistent data structure stored in .oxidenote/flashcards.json
interface FlashcardData {
  // Map from card ID to SM2 state
  cards: Record<string, SM2State>;
}

// ─── SM-2 Algorithm ──────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function defaultSM2State(): SM2State {
  return {
    ease: 2.5,
    interval: 0,
    repetitions: 0,
    due: todayStr(),
  };
}

/**
 * SM-2 algorithm: calculate next review state based on rating.
 *
 * Rating mapping:
 *   0 (Again) — Complete failure, reset
 *   1 (Hard)  — Difficult recall, reduce ease
 *   2 (Good)  — Correct recall with effort
 *   3 (Easy)  — Effortless recall, bonus interval
 */
export function calculateNextReview(state: SM2State, rating: Rating): SM2State {
  const today = todayStr();

  if (rating < 2) {
    // Failed: reset repetitions, review tomorrow
    return {
      ease: Math.max(1.3, state.ease - 0.2),
      interval: 1,
      repetitions: 0,
      due: addDays(today, 1),
    };
  }

  // Successful recall — increase interval
  let interval: number;
  if (state.repetitions === 0) {
    interval = 1;
  } else if (state.repetitions === 1) {
    interval = 6;
  } else {
    interval = Math.round(state.interval * state.ease);
  }

  // Easy bonus: extend interval by 30%
  if (rating === 3) {
    interval = Math.round(interval * 1.3);
  }

  // Adjust ease factor based on performance
  // EF' = EF + (0.1 - (3-rating) * (0.08 + (3-rating) * 0.02))
  const easeAdj = 0.1 - (3 - rating) * (0.08 + (3 - rating) * 0.02);
  const newEase = Math.max(1.3, state.ease + easeAdj);

  return {
    ease: newEase,
    interval,
    repetitions: state.repetitions + 1,
    due: addDays(today, interval),
  };
}

// ─── Markdown QA Parser ──────────────────────────────────────

/**
 * Extract Q/A pairs from Markdown content.
 * Supports format:
 *   Q: question text (can span multiple lines until A:)
 *   A: answer text (can span multiple lines until next Q: or EOF)
 */
export function parseFlashcards(content: string, sourcePath: string): FlashCard[] {
  const cards: FlashCard[] = [];
  const lines = content.split('\n');

  let currentQ = '';
  let currentA = '';
  let inQuestion = false;
  let inAnswer = false;

  for (const line of lines) {
    const qMatch = line.match(/^Q:\s*(.*)/i);
    const aMatch = line.match(/^A:\s*(.*)/i);

    if (qMatch) {
      // If we were building a previous card, save it
      if (inAnswer && currentQ && currentA) {
        cards.push(makeCard(currentQ.trim(), currentA.trim(), sourcePath));
      }
      currentQ = qMatch[1];
      currentA = '';
      inQuestion = true;
      inAnswer = false;
    } else if (aMatch) {
      currentA = aMatch[1];
      inQuestion = false;
      inAnswer = true;
    } else if (inQuestion) {
      currentQ += '\n' + line;
    } else if (inAnswer) {
      currentA += '\n' + line;
    }
  }

  // Don't forget the last card
  if (currentQ && currentA) {
    cards.push(makeCard(currentQ.trim(), currentA.trim(), sourcePath));
  }

  return cards;
}

function makeCard(question: string, answer: string, sourcePath: string): FlashCard {
  return {
    id: simpleHash(`${sourcePath}::${question}`),
    sourcePath,
    question,
    answer,
  };
}

/** Simple string hash for card ID generation */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// ─── Persistence ─────────────────────────────────────────────

const FLASHCARD_PATH = '.oxidenote/flashcards.json';

/** Load flashcard state from vault storage */
async function loadFlashcardData(): Promise<FlashcardData> {
  try {
    const note = await readNote(FLASHCARD_PATH);
    return JSON.parse(note.content) as FlashcardData;
  } catch {
    return { cards: {} };
  }
}

/** Save flashcard state to vault storage */
async function saveFlashcardData(data: FlashcardData): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  await writeNote(FLASHCARD_PATH, json);
}

// ─── Public API ──────────────────────────────────────────────

/** Recursively collect all .md file paths from a tree */
function collectMdPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) paths.push(...collectMdPaths(node.children));
    } else if (/\.(md|typ|tex)$/i.test(node.path) && !node.path.startsWith('.oxidenote')) {
      paths.push(node.path);
    }
  }
  return paths;
}

export interface Deck {
  sourcePath: string;
  title: string;
  totalCards: number;
  dueCards: number;
  newCards: number;
}

/**
 * Scan all Markdown files in the vault and collect flashcard decks.
 * Returns deck summaries (without loading full card content).
 */
export async function loadDecks(): Promise<Deck[]> {
  const tree = await listTree();
  const mdPaths = collectMdPaths(tree);
  const data = await loadFlashcardData();
  const today = todayStr();
  const decks: Deck[] = [];

  for (const path of mdPaths) {
    try {
      const note = await readNote(path);
      const cards = parseFlashcards(note.content, path);
      if (cards.length === 0) continue;

      let dueCards = 0;
      let newCards = 0;
      for (const card of cards) {
        const state = data.cards[card.id];
        if (!state) {
          newCards++;
        } else if (state.due <= today) {
          dueCards++;
        }
      }

      decks.push({
        sourcePath: path,
        title: stripNoteExtension(path).split('/').pop() || path,
        totalCards: cards.length,
        dueCards,
        newCards,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return decks;
}

/**
 * Load all due and new cards for review from a specific deck (note path).
 * If sourcePath is undefined, load from all decks.
 */
export async function loadReviewCards(sourcePath?: string): Promise<CardWithState[]> {
  const data = await loadFlashcardData();
  const today = todayStr();
  const result: CardWithState[] = [];

  const paths = sourcePath ? [sourcePath] : await getAllMdPaths();

  for (const path of paths) {
    try {
      const note = await readNote(path);
      const cards = parseFlashcards(note.content, path);

      for (const card of cards) {
        const sm2 = data.cards[card.id] || defaultSM2State();
        if (sm2.due <= today) {
          result.push({ ...card, sm2 });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Shuffle cards for variety
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

async function getAllMdPaths(): Promise<string[]> {
  const tree = await listTree();
  return collectMdPaths(tree);
}

/**
 * Submit a review rating for a card, updating its SM-2 state.
 */
export async function submitReview(cardId: string, rating: Rating): Promise<SM2State> {
  const data = await loadFlashcardData();
  const currentState = data.cards[cardId] || defaultSM2State();
  const newState = calculateNextReview(currentState, rating);
  data.cards[cardId] = newState;
  await saveFlashcardData(data);
  return newState;
}
