import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, KeyRound, Play, Square, X } from 'lucide-react';
import type { PipelineState, SourceKey, SourceStatus } from '../../shared/ipc.js';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { ProgressBar, ProgressPanel } from '../components/ProgressPanel.js';
import { StatusChip } from '../components/StatusChip.js';
import { Button } from '../components/ui/button.js';
import { Switch } from '../components/ui/switch.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { useSettings } from './Settings.js';

const PIPELINE_KEY = ['pipeline'] as const;

export function Pipeline({ onNavigate }: { onNavigate: (screen: string) => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<SourceStatus | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: PIPELINE_KEY,
    queryFn: () => api.getPipeline(),
    refetchInterval: (query) => (query.state.data?.running ? 750 : 4000),
  });

  const { data: settings } = useSettings();

  const setEnabled = useMutation({
    mutationFn: ({ key, enabled }: { key: SourceKey; enabled: boolean }) => api.setSourceEnabled(key, enabled),
    onMutate: async ({ key, enabled }) => {
      await qc.cancelQueries({ queryKey: PIPELINE_KEY });
      const prev = qc.getQueryData<PipelineState>(PIPELINE_KEY);
      if (prev) {
        qc.setQueryData<PipelineState>(PIPELINE_KEY, {
          ...prev,
          sources: prev.sources.map((s) => (s.key === key ? { ...s, enabled } : s)),
        });
      }
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(PIPELINE_KEY, ctx.prev);
      toast.error('Could not change source', { description: e.message });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: PIPELINE_KEY }),
  });

  const run = useMutation({
    mutationFn: (key: SourceKey) => api.runSource(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: PIPELINE_KEY }),
    onError: (e: Error) => toast.error('Source failed to start', { description: e.message }),
  });

  const runAll = useMutation({
    mutationFn: () => api.runAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: PIPELINE_KEY }),
    onError: (e: Error) => toast.error('Could not start run', { description: e.message }),
  });

  const stop = useMutation({
    mutationFn: () => api.stopPipeline(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PIPELINE_KEY });
      toast.success('Pipeline stopped', { description: 'Every source is resumable — nothing is re-charged.' });
    },
  });

  const sources = data?.sources ?? [];
  const running = Boolean(data?.running);

  const failures = useMemo(
    () =>
      sources
        .filter((s) => s.lastResult && /error|fail|block|429|403|captcha/i.test(s.lastResult))
        .map((s) => ({ key: s.key, label: s.label, message: s.lastResult as string }))
        .filter((f) => !dismissed.includes(`${f.key}:${f.message}`)),
    [sources, dismissed],
  );

  const keyMissing = (s: SourceStatus): boolean => {
    if (!s.requiresKey || !settings) return false;
    const r = s.requiresKey.toLowerCase();
    if (r.includes('anthropic') || r.includes('llm')) return !settings.keys.anthropicKeySet;
    if (r.includes('gmail')) return !settings.gmail.connected;
    return !settings.keys.verifierKeySet || settings.keys.verifierProvider === 'none';
  };

  const start = (s: SourceStatus) => {
    if (s.estimatedCostUsd != null) {
      setConfirm(s);
      return;
    }
    run.mutate(s.key);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Pipeline</h1>
          <p className="text-xs text-muted-foreground">
            Discovery is free and unattended. Paid steps ask first and stop at the spend cap.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {running && <StatusChip label="running" tone="good" />}
          <Button size="sm" onClick={() => runAll.mutate()} disabled={running || runAll.isPending}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Run all
          </Button>
          <Button variant="outline" size="sm" onClick={() => stop.mutate()} disabled={!running}>
            <Square className="mr-1.5 h-3.5 w-3.5" />
            Stop
          </Button>
        </div>
      </header>

      {failures.length > 0 && (
        <div className="space-y-1 border-b border-border px-6 py-2">
          {failures.map((f) => (
            <div
              key={`${f.key}:${f.message}`}
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="font-medium">{f.label}</span> — {f.message}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                className="shrink-0 opacity-70 hover:opacity-100"
                onClick={() => setDismissed((d) => [...d, `${f.key}:${f.message}`])}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-4 overflow-hidden px-6 py-4">
        <div className="min-h-0 overflow-y-auto">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading sources…</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {sources.map((s) => (
                <SourceCard
                  key={s.key}
                  source={s}
                  blocked={keyMissing(s)}
                  busy={run.isPending || runAll.isPending}
                  pipelineRunning={running}
                  onRun={() => start(s)}
                  onToggle={(enabled) => setEnabled.mutate({ key: s.key, enabled })}
                  onConfigureKey={() => onNavigate('settings')}
                />
              ))}
            </div>
          )}
        </div>

        <ProgressPanel
          log={data?.log ?? []}
          sources={sources}
          spend={data?.spend ?? []}
          className="h-64"
        />
      </div>

      <Dialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run {confirm?.label}?</DialogTitle>
            <DialogDescription>
              This step spends money. Estimated cost for the current backlog is{' '}
              <span className="font-medium text-foreground">${(confirm?.estimatedCostUsd ?? 0).toFixed(2)}</span>.
              Every call is written to the ledger before it is made, so stopping and restarting never charges
              twice.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (confirm) run.mutate(confirm.key);
                setConfirm(null);
              }}
            >
              Run and spend up to ${(confirm?.estimatedCostUsd ?? 0).toFixed(2)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SourceCard({
  source,
  blocked,
  busy,
  pipelineRunning,
  onRun,
  onToggle,
  onConfigureKey,
}: {
  source: SourceStatus;
  blocked: boolean;
  busy: boolean;
  pipelineRunning: boolean;
  onRun(): void;
  onToggle(enabled: boolean): void;
  onConfigureKey(): void;
}) {
  const { progress } = source;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-card p-4',
        source.running && 'border-primary/50',
        (blocked || !source.enabled) && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{source.label}</span>
            {source.estimatedCostUsd != null && (
              <StatusChip label={`~$${source.estimatedCostUsd.toFixed(2)}`} tone="warn" />
            )}
            {source.running && <StatusChip label="running" tone="good" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{source.description}</p>
        </div>
        <Switch
          checked={source.enabled}
          disabled={blocked}
          onCheckedChange={onToggle}
          aria-label={`Enable ${source.label}`}
        />
      </div>

      {source.running && (
        <ProgressBar
          done={progress?.done ?? 0}
          total={progress?.total ?? 0}
          indeterminate={!progress || progress.total <= 0}
        />
      )}

      <div className="flex items-end justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          <div>{source.lastRunAt ? `Last run ${ago(source.lastRunAt)}` : 'Never run'}</div>
          <div className="tabular-nums">
            {source.recordsFound.toLocaleString()} record{source.recordsFound === 1 ? '' : 's'} found
            {source.running && progress ? ` · ${progress.done}/${progress.total}` : ''}
          </div>
        </div>

        {blocked ? (
          <Button variant="outline" size="sm" onClick={onConfigureKey}>
            <KeyRound className="mr-1.5 h-3.5 w-3.5" />
            Add key
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!source.enabled || source.running || busy || pipelineRunning}
            onClick={onRun}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {source.running ? 'Running…' : 'Run'}
          </Button>
        )}
      </div>

      {blocked && (
        <div className="text-xs text-muted-foreground">
          Needs a {source.requiresKey} key — set one in Settings.
        </div>
      )}
    </div>
  );
}

export default Pipeline;
