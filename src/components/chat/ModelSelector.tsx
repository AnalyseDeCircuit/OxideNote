import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ChevronsUpDown, Check } from 'lucide-react';

import { useChatStore } from '@/store/chatStore';
import type { ModelInfo } from '@/lib/api';

/** Combobox model selector — searchable dropdown with manual input fallback */
export function ModelSelector() {
  const { t } = useTranslation();
  const config = useChatStore((s) => s.config);
  const availableModels = useChatStore((s) => s.availableModels);
  const isLoadingModels = useChatStore((s) => s.isLoadingModels);
  const fetchModels = useChatStore((s) => s.fetchModels);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Filter models by search term
  const filtered = availableModels.filter((m) =>
    m.id.toLowerCase().includes(search.toLowerCase())
  );

  const selectModel = useCallback((model: string) => {
    useChatStore.getState().updateConfig({ model });
    setSearch('');
    setOpen(false);
  }, []);

  const handleRefresh = useCallback(() => {
    fetchModels();
  }, [fetchModels]);

  // Handle manual input: pressing Enter with non-matching text
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && search.trim()) {
      e.preventDefault();
      selectModel(search.trim());
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center gap-1">
        {/* Combobox trigger / input */}
        <div
          className="flex-1 flex items-center gap-1 px-2 py-1.5 rounded-md border border-theme-border
            bg-background text-sm cursor-pointer hover:border-theme-accent/50 transition-colors"
          onClick={() => {
            setOpen(!open);
            if (!open) {
              // Focus and select input when opening
              setTimeout(() => inputRef.current?.focus(), 0);
            }
          }}
        >
          {open ? (
            <input
              ref={inputRef}
              className="flex-1 bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('chat.configModelManualInput')}
            />
          ) : (
            <span className="flex-1 truncate text-foreground">{config.model || '—'}</span>
          )}
          <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        </div>

        {/* Refresh button */}
        <button
          className="p-1.5 rounded-md border border-theme-border hover:bg-theme-hover
            transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={handleRefresh}
          disabled={isLoadingModels}
          title={t('chat.configModelRefresh')}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingModels ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50
          bg-background border border-theme-border rounded-lg shadow-lg
          max-h-48 overflow-y-auto">
          {isLoadingModels && (
            <div className="px-3 py-2 text-xs text-muted-foreground text-center">
              {t('chat.configModelLoading')}
            </div>
          )}

          {!isLoadingModels && filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground text-center">
              {search ? t('chat.noModels') : t('chat.configModelRefresh')}
            </div>
          )}

          {filtered.map((model) => (
            <ModelOption
              key={model.id}
              model={model}
              isSelected={model.id === config.model}
              onSelect={selectModel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Model option row ────────────────────────────────────────

function ModelOption({
  model,
  isSelected,
  onSelect,
}: {
  model: ModelInfo;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm
        hover:bg-theme-hover transition-colors ${isSelected ? 'text-theme-accent' : 'text-foreground'}`}
      onClick={() => onSelect(model.id)}
    >
      {isSelected ? (
        <Check className="w-3.5 h-3.5 text-theme-accent shrink-0" />
      ) : (
        <span className="w-3.5" />
      )}
      <span className="flex-1 truncate">{model.name}</span>
      {model.context_window && (
        <span className="text-[10px] text-muted-foreground shrink-0">
          {model.context_window >= 1_000_000
            ? `${(model.context_window / 1_000_000).toFixed(1)}M`
            : `${Math.round(model.context_window / 1000)}K`}
        </span>
      )}
    </button>
  );
}
