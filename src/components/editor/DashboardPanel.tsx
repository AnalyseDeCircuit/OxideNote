import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Link2, Tag, Unlink, BarChart3, TrendingUp } from 'lucide-react';
import { getVaultStats, type VaultStats } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

// ── Relative time helper ────────────────────────────────────

function relativeTime(iso: string): string {
  if (!iso) return '';
  const delta = Date.now() - new Date(iso).getTime();
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

// ── Main component ──────────────────────────────────────────

export function DashboardPanel() {
  const { t } = useTranslation();
  const vaultPath = useWorkspaceStore((s) => s.vaultPath);
  const openNote = useNoteStore((s) => s.openNote);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStats = useCallback(() => {
    if (!vaultPath) return;
    setLoading(true);
    getVaultStats()
      .then(setStats)
      .catch((err) => console.warn('[dashboard] stats load failed', err))
      .finally(() => setLoading(false));
  }, [vaultPath]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  if (!vaultPath) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('dashboard.noData')}
      </div>
    );
  }

  if (loading || !stats) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('sidebar.loading')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={<FileText size={14} />} label={t('dashboard.notes')} value={stats.total_notes} />
        <StatCard icon={<Link2 size={14} />} label={t('dashboard.links')} value={stats.total_links} />
        <StatCard icon={<Tag size={14} />} label={t('dashboard.tags')} value={stats.total_tags} />
        <StatCard icon={<Unlink size={14} />} label={t('dashboard.orphans')} value={stats.orphan_notes} />
      </div>

      {/* Activity chart (30 days) */}
      {stats.daily_activity.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            <BarChart3 size={12} />
            {t('dashboard.activity')}
          </h3>
          <ActivityChart data={stats.daily_activity} />
        </section>
      )}

      {/* Top tags */}
      {stats.top_tags.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            <Tag size={12} />
            {t('dashboard.topTags')}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {stats.top_tags.map((tag) => (
              <span
                key={tag.tag}
                className="px-2 py-0.5 text-xs rounded-full bg-theme-accent/10 text-theme-accent border border-theme-accent/20"
              >
                #{tag.tag}
                <span className="ml-1 text-muted-foreground">{tag.count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Recent notes */}
      {stats.recent_notes.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            <TrendingUp size={12} />
            {t('dashboard.recentNotes')}
          </h3>
          <ul className="space-y-0.5">
            {stats.recent_notes.map((note) => (
              <li key={note.path}>
                <button
                  className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-theme-hover transition-colors flex items-center justify-between"
                  onClick={() => openNote(note.path, note.title || note.path)}
                >
                  <span className="truncate text-foreground">{note.title || note.path}</span>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">
                    {relativeTime(note.modified_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── Stat card ───────────────────────────────────────────────

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-theme-border bg-background p-3 flex flex-col items-center gap-1">
      <span className="text-xl font-bold text-foreground">{value.toLocaleString()}</span>
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
        {icon}
        {label}
      </span>
    </div>
  );
}

// ── Activity bar chart ──────────────────────────────────────

function ActivityChart({ data }: { data: { date: string; count: number }[] }) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="flex items-end gap-px h-16 rounded bg-background border border-theme-border p-1.5">
      {data.map((day) => {
        const height = Math.max((day.count / maxCount) * 100, 4);
        return (
          <div
            key={day.date}
            className="flex-1 bg-theme-accent/60 rounded-sm transition-all hover:bg-theme-accent"
            style={{ height: `${height}%` }}
            title={`${day.date}: ${day.count}`}
          />
        );
      })}
    </div>
  );
}
