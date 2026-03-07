import { create } from 'zustand';
import { searchNotes, searchByFilename, type SearchResult } from '@/lib/api';

interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;

  setQuery: (q: string) => void;
  searchFTS: (q: string) => Promise<void>;
  searchFilename: (q: string) => Promise<void>;
  clear: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  results: [],
  loading: false,

  setQuery: (q) => {
    set({ query: q });
  },

  searchFTS: async (q) => {
    if (!q.trim()) {
      set({ results: [], loading: false });
      return;
    }
    set({ loading: true });
    try {
      const results = await searchNotes(q);
      set({ results, loading: false });
    } catch {
      set({ results: [], loading: false });
    }
  },

  searchFilename: async (q) => {
    if (!q.trim()) {
      set({ results: [], loading: false });
      return;
    }
    set({ loading: true });
    try {
      const results = await searchByFilename(q);
      set({ results, loading: false });
    } catch {
      set({ results: [], loading: false });
    }
  },

  clear: () => set({ query: '', results: [], loading: false }),
}));
