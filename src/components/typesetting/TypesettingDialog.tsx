/**
 * TypesettingDialog — Advanced PDF export with typesetting controls
 *
 * Provides configurable page layout:
 *   · Page size (A4 / Letter / A3)
 *   · Margins (top / bottom / left / right)
 *   · Header & footer text with template variables
 *   · Cover page (title / author / date)
 *   · Table of contents generation
 *   · Font family selection
 *   · Presets for quick configuration
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNoteStore } from '@/store/noteStore';
import { toast } from '@/hooks/useToast';
import { exportToPdfWithSettings, type TypesettingSettings } from '@/lib/exportPdf';
import { X } from 'lucide-react';

interface TypesettingDialogProps {
  open: boolean;
  onClose: () => void;
  content: string;
}

// ── Typesetting presets ─────────────────────────────────────
const PRESETS: Record<string, Partial<TypesettingSettings>> = {
  academic: {
    pageSize: 'A4',
    marginTop: 25,
    marginBottom: 25,
    marginLeft: 30,
    marginRight: 30,
    fontFamily: 'serif',
    header: '',
    footer: '— {{page}} —',
    tableOfContents: true,
    coverPage: false,
  },
  report: {
    pageSize: 'A4',
    marginTop: 20,
    marginBottom: 20,
    marginLeft: 25,
    marginRight: 25,
    fontFamily: 'sans-serif',
    header: '{{title}}',
    footer: 'Page {{page}} / {{pages}}',
    tableOfContents: true,
    coverPage: true,
  },
  minimal: {
    pageSize: 'A4',
    marginTop: 15,
    marginBottom: 15,
    marginLeft: 15,
    marginRight: 15,
    fontFamily: 'sans-serif',
    header: '',
    footer: '',
    tableOfContents: false,
    coverPage: false,
  },
};

export function TypesettingDialog({ open, onClose, content }: TypesettingDialogProps) {
  const { t } = useTranslation();
  const activeTabPath = useNoteStore((s) => s.activeTabPath);
  const title = activeTabPath?.replace(/\.md$/, '').split('/').pop() || 'export';

  const [settings, setSettings] = useState<TypesettingSettings>({
    pageSize: 'A4',
    marginTop: 20,
    marginBottom: 20,
    marginLeft: 25,
    marginRight: 25,
    fontFamily: 'sans-serif',
    header: '',
    footer: '— {{page}} —',
    coverPage: false,
    coverTitle: title,
    coverAuthor: '',
    coverDate: new Date().toISOString().split('T')[0],
    tableOfContents: false,
  });

  const [exporting, setExporting] = useState(false);

  // Apply a preset
  const applyPreset = useCallback((presetName: string) => {
    const preset = PRESETS[presetName];
    if (preset) {
      setSettings((prev) => ({ ...prev, ...preset, coverTitle: title }));
    }
  }, [title]);

  // Update a single setting
  const updateField = useCallback(<K extends keyof TypesettingSettings>(key: K, value: TypesettingSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Export with current settings
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      await exportToPdfWithSettings(content, title, settings);
      toast({ title: t('pdf.exportSuccess') });
      onClose();
    } catch (err) {
      toast({ title: t('pdf.exportFailed'), description: String(err), variant: 'error' });
    } finally {
      setExporting(false);
    }
  }, [content, title, settings, t, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface border border-theme-border rounded-lg shadow-2xl w-[520px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-theme-border">
          <h2 className="text-sm font-semibold text-foreground">{t('typesetting.title')}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs"><X size={14} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Presets */}
          <SettingRow label={t('typesetting.preset')}>
            <div className="flex gap-1">
              {Object.keys(PRESETS).map((name) => (
                <button
                  key={name}
                  onClick={() => applyPreset(name)}
                  className="px-2 py-0.5 text-xs rounded border border-theme-border hover:bg-theme-hover text-muted-foreground capitalize"
                >
                  {name}
                </button>
              ))}
            </div>
          </SettingRow>

          {/* Page Size */}
          <SettingRow label={t('typesetting.pageSize')}>
            <select
              value={settings.pageSize}
              onChange={(e) => updateField('pageSize', e.target.value)}
              className="px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
            >
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
              <option value="A3">A3</option>
            </select>
          </SettingRow>

          {/* Margins */}
          <SettingRow label={t('typesetting.margins')}>
            <div className="grid grid-cols-4 gap-2">
              {(['marginTop', 'marginBottom', 'marginLeft', 'marginRight'] as const).map((key) => {
                const labels: Record<string, string> = {
                  marginTop: t('typesetting.marginTop'),
                  marginBottom: t('typesetting.marginBottom'),
                  marginLeft: t('typesetting.marginLeft'),
                  marginRight: t('typesetting.marginRight'),
                };
                return (
                  <div key={key}>
                    <label className="text-[10px] text-muted-foreground">{labels[key]}</label>
                    <input
                      type="number"
                      value={settings[key]}
                      onChange={(e) => updateField(key, Number(e.target.value))}
                      min={5}
                      max={50}
                      className="w-full px-1 py-0.5 text-xs rounded border border-theme-border bg-background text-foreground"
                    />
                  </div>
                );
              })}
            </div>
          </SettingRow>

          {/* Font Family */}
          <SettingRow label={t('typesetting.fontFamily')}>
            <select
              value={settings.fontFamily}
              onChange={(e) => updateField('fontFamily', e.target.value)}
              className="px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
            >
              <option value="sans-serif">Sans-serif</option>
              <option value="serif">Serif</option>
              <option value="monospace">Monospace</option>
            </select>
          </SettingRow>

          {/* Header & Footer */}
          <SettingRow label={t('typesetting.header')}>
            <input
              type="text"
              value={settings.header}
              onChange={(e) => updateField('header', e.target.value)}
              placeholder="{{title}}, {{page}}, {{pages}}"
              className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
            />
          </SettingRow>

          <SettingRow label={t('typesetting.footer')}>
            <input
              type="text"
              value={settings.footer}
              onChange={(e) => updateField('footer', e.target.value)}
              placeholder="{{title}}, {{page}}, {{pages}}"
              className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
            />
          </SettingRow>

          {/* Table of Contents */}
          <SettingRow label={t('typesetting.tableOfContents')}>
            <input
              type="checkbox"
              checked={settings.tableOfContents}
              onChange={(e) => updateField('tableOfContents', e.target.checked)}
              className="accent-theme-accent"
            />
          </SettingRow>

          {/* Cover Page */}
          <SettingRow label={t('typesetting.coverPage')}>
            <input
              type="checkbox"
              checked={settings.coverPage}
              onChange={(e) => updateField('coverPage', e.target.checked)}
              className="accent-theme-accent"
            />
          </SettingRow>

          {settings.coverPage && (
            <div className="ml-4 space-y-2 border-l-2 border-theme-border pl-3">
              <div>
                <label className="text-[10px] text-muted-foreground">{t('typesetting.coverTitle')}</label>
                <input
                  type="text"
                  value={settings.coverTitle}
                  onChange={(e) => updateField('coverTitle', e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">{t('typesetting.coverAuthor')}</label>
                <input
                  type="text"
                  value={settings.coverAuthor}
                  onChange={(e) => updateField('coverAuthor', e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">{t('typesetting.coverDate')}</label>
                <input
                  type="date"
                  value={settings.coverDate}
                  onChange={(e) => updateField('coverDate', e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-theme-border bg-background text-foreground"
                />
              </div>
            </div>
          )}
        </div>

        {/* Dialog footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-theme-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-theme-border hover:bg-theme-hover text-muted-foreground"
          >
            {t('actions.cancel')}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-3 py-1.5 text-xs rounded bg-theme-accent text-white hover:opacity-90 disabled:opacity-50"
          >
            {exporting ? t('pdf.exporting') : t('typesetting.exportWithSettings')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Setting row layout component ────────────────────────────

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-muted-foreground min-w-[80px] pt-1 shrink-0">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
