import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '@/store/uiStore';
import { vaultHealthCheck, repairVault } from '@/lib/api';
import type { HealthReport } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react';

export function VaultHealthDialog() {
  const { t } = useTranslation();
  const open = useUIStore((s) => s.healthOpen);
  const setOpen = useUIStore((s) => s.setHealthOpen);

  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await vaultHealthCheck();
      setReport(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const runRepair = useCallback(async () => {
    setRepairing(true);
    setError(null);
    try {
      const r = await repairVault();
      setReport(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setRepairing(false);
    }
  }, []);

  const handleOpenChange = useCallback(
    (v: boolean) => {
      setOpen(v);
      if (v) {
        setReport(null);
        setError(null);
        runCheck();
      }
    },
    [setOpen, runCheck],
  );

  const isHealthy =
    report &&
    report.orphaned_entries.length === 0 &&
    report.unindexed_files.length === 0 &&
    report.broken_links.length === 0 &&
    report.fts_consistent;

  const needsRepair =
    report &&
    (report.orphaned_entries.length > 0 ||
      report.unindexed_files.length > 0 ||
      !report.fts_consistent);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isHealthy ? (
              <ShieldCheck className="h-4 w-4 text-green-500" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-yellow-500" />
            )}
            {t('health.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3 text-sm">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('health.checking')}
            </div>
          )}

          {error && (
            <div className="text-red-400 text-xs">{error}</div>
          )}

          {report && !loading && (
            <>
              {/* Summary */}
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>{t('health.totalFiles', { count: report.total_files })}</span>
                <span>{t('health.totalIndexed', { count: report.total_indexed })}</span>
              </div>

              {/* FTS status */}
              <StatusRow
                ok={report.fts_consistent}
                label={t('health.fts')}
                detail={report.fts_consistent ? t('health.ftsOk') : t('health.ftsInconsistent')}
              />

              {/* Orphaned entries */}
              <StatusRow
                ok={report.orphaned_entries.length === 0}
                label={t('health.orphaned')}
                detail={
                  report.orphaned_entries.length === 0
                    ? t('health.none')
                    : t('health.orphanedCount', { count: report.orphaned_entries.length })
                }
              />
              {report.orphaned_entries.length > 0 && (
                <FileList files={report.orphaned_entries} />
              )}

              {/* Unindexed files */}
              <StatusRow
                ok={report.unindexed_files.length === 0}
                label={t('health.unindexed')}
                detail={
                  report.unindexed_files.length === 0
                    ? t('health.none')
                    : t('health.unindexedCount', { count: report.unindexed_files.length })
                }
              />
              {report.unindexed_files.length > 0 && (
                <FileList files={report.unindexed_files} />
              )}

              {/* Broken links */}
              <StatusRow
                ok={report.broken_links.length === 0}
                label={t('health.brokenLinks')}
                detail={
                  report.broken_links.length === 0
                    ? t('health.none')
                    : t('health.brokenLinksCount', { count: report.broken_links.length })
                }
              />
              {report.broken_links.length > 0 && (
                <div className="pl-4 space-y-0.5 text-xs max-h-32 overflow-y-auto">
                  {report.broken_links.slice(0, 50).map((bl, i) => (
                    <div key={i} className="text-muted-foreground">
                      <span className="text-foreground">{bl.source}</span>
                      {' → '}
                      <span className="text-red-400">{bl.target}</span>
                    </div>
                  ))}
                </div>
              )}

              {isHealthy && (
                <div className="text-green-500 text-xs font-medium pt-1">
                  {t('health.allGood')}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('actions.close')}
          </Button>
          {needsRepair && (
            <Button variant="default" onClick={runRepair} disabled={repairing}>
              {repairing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              {t('health.repair')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={ok ? 'text-green-500' : 'text-yellow-500'}>
        {ok ? '✓' : '⚠'}
      </span>
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground">{detail}</span>
    </div>
  );
}

function FileList({ files }: { files: string[] }) {
  return (
    <div className="pl-4 space-y-0.5 text-xs text-muted-foreground max-h-32 overflow-y-auto">
      {files.slice(0, 50).map((f) => (
        <div key={f}>{f}</div>
      ))}
      {files.length > 50 && <div>…{files.length - 50} more</div>}
    </div>
  );
}
