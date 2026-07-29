import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, FolderOpen, Rocket } from 'lucide-react';
import { api } from '../lib/api.js';
import { cn, safeLocalGet, safeLocalRemove, safeLocalSet, SETUP_COMPLETE_KEY } from '../lib/utils.js';
import { ProgressBar, ProgressPanel } from '../components/ProgressPanel.js';
import { Button } from '../components/ui/button.js';
import { GmailPanel, IcpFields, useSettings } from './Settings.js';

const STEP_KEY = 'recruitai.setup.step';

const STEPS = ['Welcome', 'Gmail', 'Your ICP', 'First run'] as const;

export interface SetupProps {
  /** Omit to let Setup decide from its own persisted first-run flag. */
  open?: boolean;
  onClose?(): void;
  onNavigate?(screen: string): void;
}

export function Setup({ open, onClose, onNavigate }: SetupProps = {}) {
  const qc = useQueryClient();
  // Controlled by default. An undefined `open` means "rendered as a screen", in
  // which case it is visible — a screen that renders null leaves the operator
  // staring at an empty window with no way to navigate out.
  const [visible, setVisible] = useState(() => open ?? true);
  const [step, setStep] = useState(() => {
    const n = Number(safeLocalGet(STEP_KEY));
    return Number.isFinite(n) && n >= 0 && n < STEPS.length ? n : 0;
  });

  useEffect(() => {
    if (open !== undefined) setVisible(open);
  }, [open]);

  useEffect(() => {
    safeLocalSet(STEP_KEY, String(step));
  }, [step]);

  const { data: settings } = useSettings();

  // Finishing (or skipping) is what marks setup done — App's transition check
  // agrees, but this explicit write means the flag is set even if the app
  // quits before another screen ever mounts.
  const finish = (goToReview: boolean) => {
    safeLocalRemove(STEP_KEY);
    safeLocalSet(SETUP_COMPLETE_KEY, '1');
    setVisible(false);
    onClose?.();
    if (goToReview) onNavigate?.('review');
  };

  const runFirstPass = useMutation({
    mutationFn: async () => {
      await api.runSource('yc');
      await api.runSource('ats_sweep');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipeline'] }),
    onError: (e: Error) => toast.error('Could not start discovery', { description: e.message }),
  });

  const pipeline = useQuery({
    queryKey: ['pipeline'],
    queryFn: () => api.getPipeline(),
    enabled: visible && step === 3,
    refetchInterval: (query) => (query.state.data?.running ? 750 : 3000),
  });

  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    enabled: visible && step === 3,
    refetchInterval: 2000,
  });

  if (!visible) return null;

  const discovery = (pipeline.data?.sources ?? []).filter((s) => s.key === 'yc' || s.key === 'ats_sweep');
  const found = stats.data?.companies ?? 0;
  const started = runFirstPass.isPending || Boolean(pipeline.data?.running) || found > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[11px] tabular-nums',
                    i < step && 'bg-primary/15 text-primary',
                    i === step && 'bg-primary text-primary-foreground',
                    i > step && 'bg-muted text-muted-foreground',
                  )}
                >
                  {i < step ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                {i < STEPS.length - 1 && <span className="h-px w-5 bg-border" />}
              </div>
            ))}
          </div>
          <div className="ml-auto text-sm font-medium">{STEPS[step]}</div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Everything stays on this machine.</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                recruitAI keeps its database, raw source documents and screenshots in a single folder. There is no
                account and no server — the only network traffic is to the sources you enable and, later, to Gmail
                when you send.
              </p>
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Data folder</div>
                <div className="mt-1 break-all font-mono text-xs">{settings?.dataDir ?? 'resolving…'}</div>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => void api.openDataDir()}>
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  Open folder
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The whole discovery layer is free and needs no API keys. You can be reviewing real companies in a
                few minutes.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Outreach sends from your own Gmail, at your own pace, one tailored message at a time. Connect it
                now or skip — discovery and review work without it.
              </p>
              <div className="divide-y divide-border">
                <GmailPanel />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted-foreground">
                These defaults describe a Bay Area startup that is hiring and has no recruiting team of its own.
                They are already good enough to start — tune them once you have seen real records.
              </p>
              <div className="divide-y divide-border">
                <IcpFields />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Fetch YC + ATS sources now?</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                The YC directory and the ATS sweep (Greenhouse, Ashby, Lever, SmartRecruiters, Workable, Workday)
                are free, public and unmetered. This pass usually turns up the first reviewable records within a
                minute or two, and keeps going in the background.
              </p>

              {!started ? (
                <Button onClick={() => runFirstPass.mutate()} disabled={runFirstPass.isPending}>
                  <Rocket className="mr-1.5 h-3.5 w-3.5" />
                  Run YC + ATS sweep
                </Button>
              ) : (
                <div className="space-y-3">
                  {discovery.map((s) => (
                    <div key={s.key} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">{s.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {s.running
                            ? s.progress
                              ? `${s.progress.done} / ${s.progress.total}`
                              : 'working…'
                            : `${s.recordsFound.toLocaleString()} found`}
                        </span>
                      </div>
                      <ProgressBar
                        done={s.progress?.done ?? (s.running ? 0 : 1)}
                        total={s.progress?.total ?? 1}
                        indeterminate={s.running && !s.progress}
                      />
                    </div>
                  ))}
                  <div className="text-sm">
                    <span className="font-medium tabular-nums">{found.toLocaleString()}</span>{' '}
                    <span className="text-muted-foreground">companies discovered so far</span>
                  </div>
                  <ProgressPanel
                    log={pipeline.data?.log ?? []}
                    sources={pipeline.data?.sources ?? []}
                    spend={[]}
                    className="h-40"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-6 py-4">
          <Button variant="ghost" size="sm" onClick={() => finish(false)}>
            Skip setup
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                Back
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                Next
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={() => finish(true)}>
                {found > 0 ? 'Start reviewing' : 'Finish'}
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export default Setup;
