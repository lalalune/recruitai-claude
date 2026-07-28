import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Download,
  FolderOpen,
  Mail,
  Plus,
  Save,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Settings as SettingsShape, SettingsPatch, SuppressionRow } from '../../shared/ipc.js';
import { DEFAULT_ICP } from '../../shared/score.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';
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
import { resolveVariables, VARIABLE_KEYS } from '../components/EmailComposer.js';

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
// Templates. The IPC Settings shape has no template field, so these live in
// renderer storage and are read back by the composer; nothing else depends on
// them being on the main side.
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATE_BANDS = [
  { key: 'lt20', label: 'Under 20 people', hint: 'Founder decides directly' },
  { key: 'band20_75', label: '20–75 people', hint: 'Founder or VP Eng; TA may be a blocker' },
  { key: 'band75_300', label: '75–300 people', hint: 'Head of Talent owns the vendor list' },
  { key: 'gt300', label: '300+ people', hint: 'Expect procurement or a PSL' },
] as const;

export type TemplateBand = (typeof TEMPLATE_BANDS)[number]['key'];

const TEMPLATE_STORE = 'recruitai.templates.v1';

export function readTemplates(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORE);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeTemplates(next: Record<string, string>) {
  localStorage.setItem(TEMPLATE_STORE, JSON.stringify(next));
}

export const DEFAULT_OPT_OUT_LINE = 'If this is not useful, reply "stop" and I will not contact you again.';

const PREVIEW_VARS = {
  first_name: 'Dana',
  req_title: 'Senior Backend Engineer',
  days_open: '62',
  company: 'Ramp',
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

function NumberInput({
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
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export function Settings() {
  const { data: settings, isLoading } = useSettings();
  const patch = useSettingsPatch();

  if (isLoading || !settings) {
    return <div className="p-8 text-sm text-muted-foreground">Loading settings…</div>;
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
                  max={100}
                  onCommit={(perHour) => patch.mutate({ sending: { perHour } })}
                />
              </Row>
              <Row label="Sends per day" help="Gmail's own hard limit is 500; staying under it protects the account.">
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
              <Row
                label="LinkedIn"
                help="Off by default. LinkedIn is rate-limited aggressively and a block is surfaced to you rather than worked around."
              >
                <NumberInput
                  value={settings.crawl.linkedinPerDay}
                  min={0}
                  max={200}
                  suffix="/ day"
                  onCommit={(linkedinPerDay) => patch.mutate({ crawl: { linkedinPerDay } })}
                />
                <Switch
                  checked={settings.crawl.linkedinEnabled}
                  onCheckedChange={(linkedinEnabled) => patch.mutate({ crawl: { linkedinEnabled } })}
                />
              </Row>
            </div>
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
  const [templates, setTemplates] = useState<Record<string, string>>(() => readTemplates());
  const [band, setBand] = useState<TemplateBand>('band20_75');
  const [signature, setSignature] = useState(settings.sending.signature);
  const sigRef = useRef(settings.sending.signature);

  useEffect(() => {
    if (settings.sending.signature !== sigRef.current) {
      sigRef.current = settings.sending.signature;
      setSignature(settings.sending.signature);
    }
  }, [settings.sending.signature]);

  const setTemplate = (value: string) => {
    const next = { ...templates, [band]: value };
    setTemplates(next);
    writeTemplates(next);
  };

  const current = templates[band] ?? '';
  const optOut = settings.sending.includeOptOutLine;
  const preview = useMemo(() => {
    const parts = [resolveVariables(current, PREVIEW_VARS), signature || null];
    if (optOut) parts.push(DEFAULT_OPT_OUT_LINE);
    return parts.filter(Boolean).join('\n\n');
  }, [current, signature, optOut]);

  return (
    <div className="space-y-4 py-1">
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATE_BANDS.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setBand(b.key)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              band === b.key
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="text-xs text-muted-foreground">
        {TEMPLATE_BANDS.find((b) => b.key === band)?.hint} · Variables:{' '}
        {VARIABLE_KEYS.map((v) => `{{${v}}}`).join(' ')}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Textarea
          value={current}
          onChange={(e) => setTemplate(e.target.value)}
          spellCheck
          className="min-h-56 font-sans text-[13px] leading-[1.6]"
          placeholder={`Hi {{first_name}},\n\nI noticed {{company}} has had {{req_title}} open for {{days_open}} days…`}
        />
        <div className="min-h-56 whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-[13px] leading-[1.6]">
          {preview || <span className="text-muted-foreground">Live preview appears here.</span>}
        </div>
      </div>

      <div className="divide-y divide-border">
        <Row label="Signature" help="Appended to every send, below the body.">
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
          label="Include opt-out line"
          help={`One line — “${DEFAULT_OPT_OUT_LINE}” — appended above your signature. It costs nothing, materially reduces complaint risk, and reduces California B&P §17529.5 exposure on unsolicited commercial email. You can turn it off.`}
        >
          <Switch
            checked={settings.sending.includeOptOutLine}
            onCheckedChange={(includeOptOutLine) => patch.mutate({ sending: { includeOptOutLine } })}
          />
        </Row>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const SUPPRESSION_REASONS = [
  { value: 'existing_client', label: 'Existing client' },
  { value: 'competitor', label: 'Competitor' },
  { value: 'no_agency', label: 'No-agency policy' },
  { value: 'replied_no', label: 'Replied no' },
  { value: 'bounced', label: 'Bounced' },
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
    onSuccess: (result, what) => {
      // exportCsv returns either a written path or the CSV body itself; a body
      // is saved locally rather than dropped on the floor.
      if (result.includes('\n')) {
        const url = URL.createObjectURL(new Blob([result], { type: 'text/csv' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${what}-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${what}`);
      } else {
        toast.success(`Exported ${what}`, {
          description: result,
          action: { label: 'Open folder', onClick: () => void api.openDataDir() },
        });
      }
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
