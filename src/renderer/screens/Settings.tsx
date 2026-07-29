import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Download,
  FolderOpen,
  LogIn,
  Mail,
  Plus,
  Save,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  Settings as SettingsShape,
  SettingsPatch,
  SuppressionRow,
  LinkedInStatus,
} from '../../shared/ipc.js';
import {
  assembleEmail,
  BAND_LABELS,
  DEFAULT_OPT_OUT_LINE,
  HEADCOUNT_BANDS,
  renderTemplate,
  TEMPLATE_VARIABLES,
  unknownTemplateVariables,
  type HeadcountBand,
  type TemplateVars,
} from '../../shared/outreach.js';
import { DEFAULT_ICP } from '../../shared/score.js';
import {
  api,
  linkedInBlockedUntil,
  useConnectLinkedIn,
  useDisconnectLinkedIn,
  useLinkedInStatus,
} from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { EmptyState } from '../components/EmptyState.js';
import { Section } from '../components/Section.js';
import { StatusChip } from '../components/StatusChip.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Switch } from '../components/ui/switch.js';
import { Textarea } from '../components/ui/textarea.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared settings data access — Outreach and Setup reuse these.
// ─────────────────────────────────────────────────────────────────────────────

export const SETTINGS_KEY = ['settings'] as const;

export function useSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.getSettings() });
}

function mergeSettings(prev: SettingsShape, patch: SettingsPatch): SettingsShape {
  return {
    ...prev,
    icp: { ...prev.icp, ...(patch.icp ?? {}) },
    sending: { ...prev.sending, ...(patch.sending ?? {}) },
    crawl: { ...prev.crawl, ...(patch.crawl ?? {}) },
    spendCapUsd: patch.spendCapUsd ?? prev.spendCapUsd,
    templates: { ...prev.templates, ...(patch.templates ?? {}) },
  };
}

/** Optimistic settings writer. Toggles must feel instant; the disk write is a detail. */
export function useSettingsPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.patchSettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: SETTINGS_KEY });
      const prev = qc.getQueryData<SettingsShape>(SETTINGS_KEY);
      if (prev) qc.setQueryData(SETTINGS_KEY, mergeSettings(prev, patch));
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(SETTINGS_KEY, ctx.prev);
      toast.error('Could not save setting', { description: String((err as Error)?.message ?? err) });
    },
    onSuccess: (next) => qc.setQueryData(SETTINGS_KEY, next),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates render from src/shared/outreach.ts — the same code the generator
// and sender run — and persist in Settings via patchSettings({ templates }).
// ─────────────────────────────────────────────────────────────────────────────

const BAND_HINTS: Record<HeadcountBand, string> = {
  under_20: 'Founder decides directly',
  '20_75': 'Founder or VP Eng; TA may be a blocker',
  '75_300': 'Head of Talent owns the vendor list',
  over_300: 'Expect procurement or a PSL',
};

/** Plausible values so the live preview reads like a real message. */
const PREVIEW_VARS: TemplateVars = {
  firstName: 'Dana',
  companyName: 'Ramp',
  reqTitle: 'Senior Backend Engineer',
  reqDaysOpen: 62,
  reqLocation: 'San Francisco',
  openReqCount: 7,
  openEngCount: 4,
  staleReqCount: 2,
  fee: '$36,000',
  fundingStage: 'Series B',
  ycBatch: 'W21',
};

// ─────────────────────────────────────────────────────────────────────────────
// Small local primitives
// ─────────────────────────────────────────────────────────────────────────────

function Row({
  label,
  help,
  children,
  className,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-6 py-2.5', className)}>
      <div className="min-w-0 max-w-md">
        <div className="text-sm">{label}</div>
        {help && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{help}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Commit-on-blur numeric input. Exported: Outreach's pacing panel reuses it. */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  className,
}: {
  value: number;
  onCommit(n: number): void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    let clamped = n;
    if (min != null) clamped = Math.max(min, clamped);
    if (max != null) clamped = Math.min(max, clamped);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        className={cn('h-8 w-28 text-sm', className)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(String(value));
        }}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function TagInput({ values, onChange }: { values: string[]; onChange(next: string[]): void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!v) return;
    if (!values.some((x) => x.toLowerCase() === v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="w-80">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {values.length === 0 && <span className="text-xs text-muted-foreground">No exclusions</span>}
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder="Add keyword and press Enter"
          className="h-8 text-sm"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail — exported because Setup step 2 is exactly this panel
// ─────────────────────────────────────────────────────────────────────────────

export function GmailPanel({ onConnected }: { onConnected?: (address: string | null) => void }) {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connect = useMutation({
    mutationFn: () => api.connectGmail(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      if (r.ok) {
        toast.success(r.address ? `Connected ${r.address}` : 'Gmail connected');
        onConnected?.(r.address ?? null);
      } else {
        toast.error('Gmail not connected', { description: r.message });
      }
    },
    onError: (e: Error) => toast.error('Gmail connection failed', { description: e.message }),
  });

  const disconnect = useMutation({
    mutationFn: () => api.disconnectGmail(),
    onSuccess: () => {
      setConfirmDisconnect(false);
      qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      toast.success('Gmail disconnected');
    },
  });

  const test = useMutation({
    mutationFn: () => api.testGmail(),
    onSuccess: (r) =>
      r.ok ? toast.success('Test email sent', { description: r.message }) : toast.error('Test send failed', { description: r.message }),
    onError: (e: Error) => toast.error('Test send failed', { description: e.message }),
  });

  const gmail = settings?.gmail;
  const connected = Boolean(gmail?.connected);

  return (
    <>
      <Row
        label="Account"
        help={
          connected
            ? 'Sends go out from this mailbox, through your own account, at your own pace.'
            : 'Outreach sends from your personal Gmail. Nothing sends until you connect it.'
        }
      >
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <span className="text-sm">{gmail?.address ?? 'connected'}</span>
              {gmail?.needsReauth ? (
                <StatusChip label="needs reauth" tone="warn" />
              ) : (
                <StatusChip label="connected" tone="good" />
              )}
            </>
          ) : (
            <StatusChip label="not connected" tone="muted" />
          )}
        </div>
      </Row>
      <Row label="Connection" help="OAuth opens in a real browser window. Tokens stay in your OS keychain.">
        {connected ? (
          <>
            <Button variant="outline" size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
              <Mail className="mr-1.5 h-3.5 w-3.5" />
              {gmail?.needsReauth ? 'Reauthorize' : 'Reconnect'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
            <Mail className="mr-1.5 h-3.5 w-3.5" />
            {connect.isPending ? 'Waiting for browser…' : 'Connect Gmail'}
          </Button>
        )}
      </Row>
      <Row label="Test send" help="Sends one message to yourself so you can see exactly what lands.">
        <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={!connected || test.isPending}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {test.isPending ? 'Sending…' : 'Send test to myself'}
        </Button>
      </Row>

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Gmail?</DialogTitle>
            <DialogDescription>
              The send queue stops immediately. Drafts, replies and history are kept — you can reconnect at any
              time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ICP — exported because Setup step 3 is exactly these fields
// ─────────────────────────────────────────────────────────────────────────────

export function IcpFields() {
  const { data: settings } = useSettings();
  const patch = useSettingsPatch();
  const icp = settings?.icp ?? DEFAULT_ICP;

  return (
    <>
      <Row label="Headcount range" help="Companies outside this band are disqualified before scoring.">
        <NumberInput
          value={icp.minHeadcount}
          min={1}
          max={icp.maxHeadcount}
          onCommit={(minHeadcount) => patch.mutate({ icp: { minHeadcount } })}
        />
        <span className="text-xs text-muted-foreground">to</span>
        <NumberInput
          value={icp.maxHeadcount}
          min={icp.minHeadcount}
          max={100000}
          onCommit={(maxHeadcount) => patch.mutate({ icp: { maxHeadcount } })}
        />
      </Row>
      <Row label="Bay Area only" help="Off widens discovery well beyond what one operator can work.">
        <Switch
          checked={icp.requireBayArea}
          onCheckedChange={(requireBayArea) => patch.mutate({ icp: { requireBayArea } })}
        />
      </Row>
      <Row
        label="Stale after"
        help="A req open longer than this is the strongest pitch hook you have, and it drives the score."
      >
        <NumberInput
          value={icp.staleDays}
          min={7}
          max={365}
          suffix="days"
          onCommit={(staleDays) => patch.mutate({ icp: { staleDays } })}
        />
      </Row>
      <Row
        label="Max in-house recruiters"
        help="Above this, the company is deprioritised — an established TA team competes with the pitch rather than buying it."
      >
        <NumberInput
          value={icp.maxInhouseRecruiters}
          min={0}
          max={50}
          onCommit={(maxInhouseRecruiters) => patch.mutate({ icp: { maxInhouseRecruiters } })}
        />
      </Row>
      <Row label="Excluded keywords" help="Matched against company name and industry. Case-insensitive.">
        <TagInput
          values={icp.excludedKeywords}
          onChange={(excludedKeywords) => patch.mutate({ icp: { excludedKeywords } })}
        />
      </Row>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn
// ─────────────────────────────────────────────────────────────────────────────

/** What to do instead. Every one of these is free and carries no account risk. */
const LINKEDIN_FALLBACKS: { label: string; detail: string }[] = [
  {
    label: 'Company team or about page',
    detail:
      'A startup with an in-house recruiter almost always lists them there, alongside the founders and the CTO.',
  },
  {
    label: 'Job descriptions',
    detail:
      'An open “Recruiter” or “Talent Partner” req is definitive, and many descriptions name the hiring manager outright.',
  },
  {
    label: 'HN “Who is hiring” posts',
    detail: 'Usually signed by a founder or an engineering lead, with a direct reply address.',
  },
  {
    label: 'SEC Form D filings',
    detail: 'Officer and director names plus the funding date — free, authoritative, and current.',
  },
];

function untilLabel(ms: number): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString() ? time : `${time} tomorrow`;
}

function linkedInChip(
  status: LinkedInStatus | undefined,
  blockedUntil: number | null,
): { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  if (!status) return { label: 'checking…', tone: 'muted' };
  switch (status.state) {
    case 'ready':
      return { label: 'signed in', tone: 'good' };
    case 'disabled':
      return { label: 'disabled', tone: 'muted' };
    case 'unsupported':
      return { label: 'unavailable', tone: 'muted' };
    case 'logged_out':
      return { label: 'not signed in', tone: 'warn' };
    case 'checkpoint':
      return { label: 'checkpoint needs you', tone: 'bad' };
    case 'blocked':
      return {
        label: blockedUntil ? `rate-limited until ${untilLabel(blockedUntil)}` : 'rate-limited',
        tone: 'bad',
      };
    case 'budget_exhausted':
      return { label: 'budget used for today', tone: 'warn' };
    case 'outside_window':
      return { label: 'outside active window', tone: 'muted' };
    default:
      return { label: status.loggedIn ? 'signed in' : 'not signed in', tone: 'muted' };
  }
}

function LinkedInPanel({ settings }: { settings: SettingsShape }) {
  const patch = useSettingsPatch();
  const { data: status } = useLinkedInStatus();
  const connect = useConnectLinkedIn();
  const disconnect = useDisconnectLinkedIn();

  const blockedUntil = linkedInBlockedUntil(status);
  const chip = linkedInChip(status, blockedUntil);
  const signedIn = Boolean(status?.loggedIn);
  const checkpoint = status?.state === 'checkpoint';
  const busy = connect.isPending || disconnect.isPending;

  // Falls back to the configured budget so the readout is not blank on first paint.
  const perDay = status?.budgetPerDay ?? settings.crawl.linkedinPerDay;
  const used = status?.budgetUsed ?? 0;
  const remaining = status?.budgetRemaining ?? Math.max(0, perDay - used);

  return (
    <div className="space-y-3 py-1">
      {status?.needsOperator && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">{status.message}</div>
            <div className="mt-0.5">
              {checkpoint
                ? 'LinkedIn is holding this session at a security checkpoint. Open the window and clear it yourself — the app will not try to solve or bypass it, and it stays stopped until you do.'
                : 'Sign in below. A real LinkedIn window opens and you log in there.'}
            </div>
          </div>
        </div>
      )}

      <div className="divide-y divide-border">
        <Row label="Status" help={status?.message}>
          <StatusChip label={chip.label} tone={chip.tone} />
        </Row>

        <Row
          label="Session"
          help="Opens a real LinkedIn window inside the app. You type your own credentials into LinkedIn's own page — the app never sees your password, and keeps only the session cookie."
        >
          {signedIn ? (
            <>
              {status?.needsOperator && (
                <Button size="sm" onClick={() => connect.mutate()} disabled={busy}>
                  <LogIn className="mr-1.5 h-3.5 w-3.5" />
                  {connect.isPending ? 'Opening window…' : 'Open LinkedIn window'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnect.mutate()}
                disabled={busy}
              >
                {disconnect.isPending ? 'Signing out…' : 'Sign out'}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => connect.mutate()} disabled={busy}>
              <LogIn className="mr-1.5 h-3.5 w-3.5" />
              {connect.isPending ? 'Waiting for the window…' : 'Sign in to LinkedIn'}
            </Button>
          )}
        </Row>

        <Row
          label="Today's budget"
          help="Counted per calendar day and persisted, so restarting the app does not hand back a fresh allowance."
        >
          <span className="font-mono text-sm tabular-nums">
            {used} / {perDay}
          </span>
          <span className="text-xs text-muted-foreground">
            today, {remaining} remaining
          </span>
        </Row>

        <Row label="Enabled" help="Off by default. Nothing touches LinkedIn while this is off.">
          <Switch
            checked={settings.crawl.linkedinEnabled}
            onCheckedChange={(linkedinEnabled) => patch.mutate({ crawl: { linkedinEnabled } })}
          />
        </Row>

        <Row
          label="Requests per day"
          help="The hard daily ceiling. Requests are also spaced randomly, so a low number here is genuinely low traffic."
        >
          <NumberInput
            value={settings.crawl.linkedinPerDay}
            min={0}
            max={200}
            suffix="/ day"
            onCommit={(linkedinPerDay) => patch.mutate({ crawl: { linkedinPerDay } })}
          />
        </Row>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        LinkedIn rate-limits aggressively. When it blocks or challenges this session the app stops
        for the rest of the day rather than working around it. Sign in with an account you can
        afford to lose, not the one your business depends on.
      </p>

      {/* -mx-3 cancels the parent Section's body padding so this nested header
          lines up with the rows above it rather than stepping in. */}
      <Section
        title="If LinkedIn is unavailable"
        storageKey="settings.linkedin.fallbacks"
        defaultOpen={false}
        className="-mx-3 border-b-0"
      >
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
          LinkedIn is the precision layer, not the foundation. These cover most of the same signal
          at no account risk, and the pipeline already reads all four.
        </p>
        <ul className="space-y-2">
          {LINKEDIN_FALLBACKS.map((f) => (
            <li key={f.label}>
              <div className="text-sm">{f.label}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{f.detail}</div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export function Settings() {
  const { data: settings, isLoading, isError, error, refetch } = useSettings();
  const patch = useSettingsPatch();

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading settings…</div>;
  }

  // Without this branch a failed getSettings left the screen on "Loading
  // settings…" for good: the query is no longer loading and `settings` is still
  // undefined, so the operator gets no error, no retry, and no way to reconnect
  // Gmail or fix a key.
  if (isError || !settings) {
    return (
      <EmptyState
        icon={<AlertTriangle />}
        title="Could not load settings"
        description={String((error as Error)?.message ?? 'The main process returned nothing.')}
        action={{ label: 'Try again', onClick: () => void refetch() }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="mb-1 text-xl font-semibold">Settings</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Everything is stored locally in {settings.dataDir}. Nothing leaves this machine except the API calls
          you configure below.
        </p>

        <div className="space-y-4">
          <Section title="Gmail" defaultOpen>
            <div className="divide-y divide-border">
              <GmailPanel />
            </div>
          </Section>

          <Section title="API keys" defaultOpen>
            <div className="divide-y divide-border">
              <KeysPanel settings={settings} />
            </div>
          </Section>

          <Section title="Rate limits" defaultOpen>
            <div className="divide-y divide-border">
              <Row label="Sends per hour" help="20 is the safe ceiling for a personal Gmail account.">
                <NumberInput
                  value={settings.sending.perHour}
                  min={1}
                  max={200}
                  onCommit={(perHour) => patch.mutate({ sending: { perHour } })}
                />
              </Row>
              <Row
                label="Sends per day"
                help="150 is the recommended ceiling for a personal Gmail. Google's own hard limit is 500 a day, and sustained volume near it is what gets an account flagged."
              >
                <NumberInput
                  value={settings.sending.perDay}
                  min={1}
                  max={500}
                  onCommit={(perDay) => patch.mutate({ sending: { perDay } })}
                />
              </Row>
              <Row label="Active window" help="Local time. Sends outside the window wait for the next opening.">
                <Input
                  type="time"
                  value={settings.sending.windowStart}
                  className="h-8 w-28 text-sm"
                  onChange={(e) => patch.mutate({ sending: { windowStart: e.target.value } })}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="time"
                  value={settings.sending.windowEnd}
                  className="h-8 w-28 text-sm"
                  onChange={(e) => patch.mutate({ sending: { windowEnd: e.target.value } })}
                />
              </Row>
              <Row label="Jitter" help="Randomises each interval so the cadence never looks machine-generated.">
                <NumberInput
                  value={settings.sending.jitterPct}
                  min={0}
                  max={90}
                  suffix="%"
                  onCommit={(jitterPct) => patch.mutate({ sending: { jitterPct } })}
                />
              </Row>
              <Row label="Send on weekends">
                <Switch
                  checked={settings.sending.weekends}
                  onCheckedChange={(weekends) => patch.mutate({ sending: { weekends } })}
                />
              </Row>
              <Row label="Crawl concurrency" help="Parallel HTTP requests during discovery. Higher is faster and ruder.">
                <NumberInput
                  value={settings.crawl.concurrency}
                  min={1}
                  max={32}
                  onCommit={(concurrency) => patch.mutate({ crawl: { concurrency } })}
                />
              </Row>
            </div>
          </Section>

          <Section title="LinkedIn" defaultOpen>
            <LinkedInPanel settings={settings} />
          </Section>

          <Section title="Ideal customer profile" defaultOpen>
            <div className="divide-y divide-border">
              <IcpFields />
            </div>
          </Section>

          <Section title="Templates" defaultOpen>
            <TemplatesPanel settings={settings} />
          </Section>

          <Section title="Suppression" defaultOpen>
            <SuppressionPanel />
          </Section>

          <Section title="Data" defaultOpen>
            <div className="divide-y divide-border">
              <DataPanel settings={settings} />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function KeysPanel({ settings }: { settings: SettingsShape }) {
  const qc = useQueryClient();
  const patch = useSettingsPatch();
  const [verifierKey, setVerifierKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.setSecret(key, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      toast.success('Key saved to the OS keychain');
    },
    onError: (e: Error) => toast.error('Could not save key', { description: e.message }),
  });

  const test = useMutation({
    mutationFn: (which: 'verifier' | 'anthropic') => api.testKey(which),
    onSuccess: (r) =>
      r.ok ? toast.success('Key works', { description: r.message }) : toast.error('Key rejected', { description: r.message }),
    onError: (e: Error) => toast.error('Test failed', { description: e.message }),
  });

  return (
    <>
      <Row
        label="Email verification provider"
        help="Verification is the only paid step in discovery. 'None' keeps the whole pipeline free; addresses stay 'unverified' and score lower."
      >
        <Select
          value={settings.keys.verifierProvider}
          // SettingsPatch carries no keys branch, so the provider choice rides the
          // same secret channel as the key it selects.
          onValueChange={(v) => save.mutate({ key: 'verifier_provider', value: v })}
        >
          <SelectTrigger className="h-8 w-48 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="reoon">Reoon</SelectItem>
            <SelectItem value="bouncer">Bouncer</SelectItem>
            <SelectItem value="millionverifier">MillionVerifier</SelectItem>
            <SelectItem value="none">None (free)</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <Row label="Verifier API key" help={settings.keys.verifierKeySet ? 'A key is stored.' : 'No key stored.'}>
        <Input
          type="password"
          value={verifierKey}
          placeholder={settings.keys.verifierKeySet ? '••••••••••••' : 'paste key'}
          className="h-8 w-56 text-sm"
          onChange={(e) => setVerifierKey(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!verifierKey.trim() || save.isPending}
          onClick={() => {
            save.mutate({ key: 'verifier', value: verifierKey.trim() });
            setVerifierKey('');
          }}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!settings.keys.verifierKeySet || test.isPending}
          onClick={() => test.mutate('verifier')}
        >
          Test
        </Button>
      </Row>

      <Row label="Anthropic API key" help={settings.keys.anthropicKeySet ? 'A key is stored.' : 'Optional. Used for classification and draft generation.'}>
        <Input
          type="password"
          value={anthropicKey}
          placeholder={settings.keys.anthropicKeySet ? '••••••••••••' : 'paste key'}
          className="h-8 w-56 text-sm"
          onChange={(e) => setAnthropicKey(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!anthropicKey.trim() || save.isPending}
          onClick={() => {
            save.mutate({ key: 'anthropic', value: anthropicKey.trim() });
            setAnthropicKey('');
          }}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!settings.keys.anthropicKeySet || test.isPending}
          onClick={() => test.mutate('anthropic')}
        >
          Test
        </Button>
      </Row>

      <Row
        label="Hard spend cap"
        help="Every paid call is ledgered before it is made. When the cap is reached the pipeline stops rather than continuing to charge."
      >
        <NumberInput
          value={settings.spendCapUsd}
          min={0}
          max={10000}
          step={5}
          suffix="USD"
          onCommit={(spendCapUsd) => patch.mutate({ spendCapUsd })}
        />
      </Row>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function TemplatesPanel({ settings }: { settings: SettingsShape }) {
  const patch = useSettingsPatch();
  const generateDrafts = useMutation({
    mutationFn: () => api.runSource('draft_generation'),
    onSuccess: () =>
      toast.success('Draft generation started', {
        description: 'Watch it in the pipeline panel. Finished drafts appear in Outreach.',
      }),
    onError: (e: Error) => toast.error('Could not start draft generation', { description: e.message }),
  });
  const [band, setBand] = useState<HeadcountBand>('20_75');
  const [signature, setSignature] = useState(settings.sending.signature);
  const sigRef = useRef(settings.sending.signature);
  const [postal, setPostal] = useState(settings.sending.postalAddress ?? '');
  const postalRef = useRef(settings.sending.postalAddress ?? '');

  useEffect(() => {
    if (settings.sending.signature !== sigRef.current) {
      sigRef.current = settings.sending.signature;
      setSignature(settings.sending.signature);
    }
  }, [settings.sending.signature]);

  useEffect(() => {
    const next = settings.sending.postalAddress ?? '';
    if (next !== postalRef.current) {
      postalRef.current = next;
      setPostal(next);
    }
  }, [settings.sending.postalAddress]);

  const templates = settings.templates;
  const isBuiltIn = (b: HeadcountBand) =>
    !(templates?.[b]?.subject?.trim() || templates?.[b]?.body?.trim());

  return (
    <div className="space-y-4 py-1">
      <div className="flex flex-wrap gap-1.5">
        {HEADCOUNT_BANDS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBand(b)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              band === b
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {BAND_LABELS[b]}
            {isBuiltIn(b) && <span className="ml-1.5 opacity-60">built-in</span>}
          </button>
        ))}
      </div>

      <BandTemplateEditor
        key={band}
        band={band}
        value={templates?.[band] ?? { subject: '', body: '' }}
        settings={settings}
        onSave={(subject, body) => patch.mutate({ templates: { [band]: { subject, body } } })}
      />

      <div className="divide-y divide-border">
        <Row label="Signature" help="Baked into every draft at generation time, below the body.">
          <Textarea
            value={signature}
            className="h-20 w-80 text-sm"
            onChange={(e) => setSignature(e.target.value)}
            onBlur={() => {
              if (signature !== sigRef.current) {
                sigRef.current = signature;
                patch.mutate({ sending: { signature } });
              }
            }}
          />
        </Row>
        <Row
          label="Postal address"
          help="CAN-SPAM requires a valid physical postal address in every commercial email. It is appended to every message — the sender re-adds it if an edit removed it."
        >
          <Textarea
            value={postal}
            placeholder={'123 Market St, Suite 400\nSan Francisco, CA 94105'}
            className="h-20 w-80 text-sm"
            onChange={(e) => setPostal(e.target.value)}
            onBlur={() => {
              if (postal !== postalRef.current) {
                postalRef.current = postal;
                patch.mutate({ sending: { postalAddress: postal } });
              }
            }}
          />
        </Row>
        <Row
          label="Include opt-out line"
          help={`One line — “${DEFAULT_OPT_OUT_LINE}” — appended above your signature. It costs nothing, materially reduces complaint risk, and reduces California B&P §17529.5 exposure on unsolicited commercial email. You can turn it off.`}
        >
          <Switch
            checked={settings.sending.includeOptOutLine}
            onCheckedChange={(includeOptOutLine) => patch.mutate({ sending: { includeOptOutLine } })}
          />
        </Row>
        <Row
          label="Generate drafts for approved companies"
          help="Approving a company in Review already queues its first draft automatically. Run this to backfill a draft for any approved company that does not have one yet — each gets a draft you can still edit before it queues."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => generateDrafts.mutate()}
            disabled={generateDrafts.isPending}
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {generateDrafts.isPending ? 'Starting…' : 'Generate drafts'}
          </Button>
        </Row>
      </div>
    </div>
  );
}

/**
 * Buffered editor for one band. Remounted per band (key) so local state always
 * initialises from the stored template; edits commit on blur.
 */
function BandTemplateEditor({
  band,
  value,
  settings,
  onSave,
}: {
  band: HeadcountBand;
  value: { subject: string; body: string };
  settings: SettingsShape;
  onSave(subject: string, body: string): void;
}) {
  const [subject, setSubject] = useState(value.subject);
  const [body, setBody] = useState(value.body);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const savedRef = useRef(value);

  const commit = () => {
    if (subject !== savedRef.current.subject || body !== savedRef.current.body) {
      savedRef.current = { subject, body };
      onSave(subject, body);
    }
  };

  const insertVariable = (name: string) => {
    const token = `{${name}}`;
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => `${b}${token}`);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    setBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const unknown = useMemo(
    () => unknownTemplateVariables(`${subject}\n${body}`),
    [subject, body],
  );

  // The preview runs the exact shared pipeline the generator runs: render the
  // template, then assemble the compliance footer.
  const previewSubject = renderTemplate(subject, PREVIEW_VARS);
  const previewBody = body.trim()
    ? assembleEmail(renderTemplate(body, PREVIEW_VARS), {
        includeOptOutLine: settings.sending.includeOptOutLine,
        signature: settings.sending.signature ?? '',
        postalAddress: settings.sending.postalAddress ?? '',
      })
    : '';

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {BAND_HINTS[band]} · Leave subject and body empty to use the built-in template for this
        band.
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Insert</span>
        {TEMPLATE_VARIABLES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => insertVariable(v)}
            className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
            title="A line whose variable has no value for a record is dropped whole."
          >
            {`{${v}}`}
          </button>
        ))}
      </div>

      {unknown.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Unknown variable{unknown.length === 1 ? '' : 's'}:{' '}
            {unknown.map((u) => `{${u}}`).join(', ')} — lines containing them will be dropped from
            every message.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={commit}
            spellCheck
            className="h-8 text-sm"
            placeholder="Subject — empty uses the built-in"
          />
          <Textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={commit}
            spellCheck
            className="min-h-56 font-sans text-[13px] leading-[1.6]"
            placeholder={`Hi {firstName},\n\nI noticed {companyName} has had {reqTitle} open for {reqDaysOpen} days…\n\nEmpty uses the built-in body.`}
          />
        </div>
        <div className="min-h-56 rounded-md border border-border bg-muted/30 p-3 text-[13px] leading-[1.6]">
          {body.trim() ? (
            <>
              {previewSubject && (
                <div className="mb-2 border-b border-border pb-2 font-medium">{previewSubject}</div>
              )}
              <div className="whitespace-pre-wrap">{previewBody}</div>
            </>
          ) : (
            <span className="text-muted-foreground">
              Using the built-in template for this band — write a body on the left to override it.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const SUPPRESSION_REASONS = [
  { value: 'existing_client', label: 'Existing client' },
  { value: 'active_contract', label: 'Active contract' },
  { value: 'past_rejection', label: 'Said no before' },
  { value: 'placed_candidate_employer', label: 'Employs someone we placed' },
  { value: 'competitor', label: 'Competitor agency' },
  { value: 'no_agency_policy', label: 'No-agency policy' },
  { value: 'replied_no', label: 'Replied no' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'opt_out', label: 'Opted out' },
  { value: 'manual', label: 'Manual' },
];

function SuppressionPanel() {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({ queryKey: ['suppressions'], queryFn: () => api.listSuppressions() });
  const [kind, setKind] = useState('domain');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('manual');
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['suppressions'] });

  const add = useMutation({
    mutationFn: () => api.addSuppression(kind, value.trim(), reason, note.trim() || undefined),
    onSuccess: () => {
      setValue('');
      setNote('');
      invalidate();
      toast.success('Suppressed');
    },
    onError: (e: Error) => toast.error('Could not suppress', { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.removeSuppression(id),
    onSuccess: invalidate,
  });

  const importCsv = useMutation({
    mutationFn: (csv: string) => api.importSuppressionsCsv(csv),
    onSuccess: (n) => {
      invalidate();
      toast.success(`Imported ${n} suppression${n === 1 ? '' : 's'}`);
    },
    onError: (e: Error) => toast.error('Import failed', { description: e.message }),
  });

  return (
    <div className="space-y-3 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-8 w-32 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="domain">Domain</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="company">Company</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={value}
          placeholder={kind === 'domain' ? 'example.com' : kind === 'email' ? 'someone@example.com' : 'Company name'}
          className="h-8 w-56 text-sm"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) add.mutate();
          }}
        />
        <Select value={reason} onValueChange={setReason}>
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPRESSION_REASONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={note}
          placeholder="Note (optional)"
          className="h-8 w-44 text-sm"
          onChange={(e) => setNote(e.target.value)}
        />
        <Button size="sm" disabled={!value.trim() || add.isPending} onClick={() => add.mutate()}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={importCsv.isPending}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Import CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            importCsv.mutate(await file.text());
          }}
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing suppressed. Bounces and “no” replies land here automatically.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Kind</th>
                <th className="px-3 py-2 text-left font-medium">Value</th>
                <th className="px-3 py-2 text-left font-medium">Reason</th>
                <th className="px-3 py-2 text-left font-medium">Added</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r: SuppressionRow) => (
                <tr key={r.id} className="hover:bg-muted/30">
                  <td className="px-3 py-1.5 text-muted-foreground">{r.kind}</td>
                  <td className="px-3 py-1.5">
                    <div className="truncate">{r.value}</div>
                    {r.note && <div className="truncate text-xs text-muted-foreground">{r.note}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {SUPPRESSION_REASONS.find((x) => x.value === r.reason)?.label ?? r.reason}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      aria-label={`Remove ${r.value}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => remove.mutate(r.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function DataPanel({ settings }: { settings: SettingsShape }) {
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.getStats() });

  const backup = useMutation({
    mutationFn: () => api.backupNow(),
    onSuccess: (path) =>
      toast.success('Backup written', {
        description: path,
        action: { label: 'Open folder', onClick: () => void api.openDataDir() },
      }),
    onError: (e: Error) => toast.error('Backup failed', { description: e.message }),
  });

  const exportCsv = useMutation({
    mutationFn: (what: 'companies' | 'contacts' | 'drafts') => api.exportCsv(what),
    // exportCsv always writes a file and returns its path.
    onSuccess: (path, what) => {
      toast.success(`Exported ${what}`, {
        description: path,
        action: { label: 'Open folder', onClick: () => void api.openDataDir() },
      });
    },
    onError: (e: Error) => toast.error('Export failed', { description: e.message }),
  });

  return (
    <>
      <Row label="Data folder" help={settings.dataDir}>
        <Button variant="outline" size="sm" onClick={() => void api.openDataDir()}>
          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
          Open
        </Button>
      </Row>
      <Row
        label="Database"
        help={
          stats
            ? `${stats.companies.toLocaleString()} companies · ${stats.contacts.toLocaleString()} contacts · ${stats.openReqs.toLocaleString()} open reqs · ${stats.sent.toLocaleString()} sent`
            : 'Counting…'
        }
      >
        <Button variant="outline" size="sm" onClick={() => backup.mutate()} disabled={backup.isPending}>
          {backup.isPending ? 'Backing up…' : 'Backup now'}
        </Button>
      </Row>
      <Row label="Export CSV" help="A snapshot you can open in a spreadsheet. Raw evidence stays in the database.">
        {(['companies', 'contacts', 'drafts'] as const).map((what) => (
          <Button
            key={what}
            variant="ghost"
            size="sm"
            disabled={exportCsv.isPending}
            onClick={() => exportCsv.mutate(what)}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {what}
          </Button>
        ))}
      </Row>
    </>
  );
}

export default Settings;
