import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';
import {
  ExternalLink,
  Inbox,
  Mail,
  MailX,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Trash2,
} from 'lucide-react';
import type { CompanyDetail, ContactRow, DraftRow, InboundRow } from '../../shared/ipc.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { SplitView } from '../components/SplitView.js';
import { RankedList } from '../components/RankedList.js';
import { ListRow } from '../components/ListRow.js';
import { DetailPane } from '../components/DetailPane.js';
import { Section } from '../components/Section.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { StatusChip } from '../components/StatusChip.js';
import { ActionBar } from '../components/ActionBar.js';
import { EmptyState } from '../components/EmptyState.js';
import { EmailComposer, verdictLabel, verdictTone, type DraftVariables } from '../components/EmailComposer.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Switch } from '../components/ui/switch.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { DEFAULT_OPT_OUT_LINE, useSettings, useSettingsPatch } from './Settings.js';

export type OutreachTab = 'drafts' | 'queue' | 'replies';

const TAB_STORE = 'recruitai.outreach.tab';
const DRAFTS_KEY = ['drafts', 'draft'] as const;
const QUEUE_KEY = ['drafts', 'queued'] as const;
const STATS_KEY = ['sendStats'] as const;

/** RankedList may hand back the row object or just its id; both are accepted. */
function idOf(x: unknown): string | null {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && 'id' in x) return String((x as { id: unknown }).id);
  return null;
}

export function Outreach({ initialTab }: { initialTab?: OutreachTab } = {}) {
  const [tab, setTab] = useState<OutreachTab>(
    () => initialTab ?? ((localStorage.getItem(TAB_STORE) as OutreachTab | null) ?? 'drafts'),
  );

  useEffect(() => {
    localStorage.setItem(TAB_STORE, tab);
  }, [tab]);

  const { data: stats } = useQuery({ queryKey: STATS_KEY, queryFn: () => api.getSendStats(), refetchInterval: 1000 });
  const { data: drafts } = useQuery({ queryKey: DRAFTS_KEY, queryFn: () => api.listDrafts('draft') });
  const { data: inbound } = useQuery({ queryKey: ['inbound', false], queryFn: () => api.listInbound(false) });

  const counts: Record<OutreachTab, number> = {
    drafts: drafts?.length ?? 0,
    queue: stats?.queued ?? 0,
    replies: inbound?.length ?? 0,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-4">
        {(['drafts', 'queue', 'replies'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'relative px-3 py-2.5 text-sm capitalize transition-colors',
              tab === t ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
            {counts[t] > 0 && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {counts[t]}
              </span>
            )}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
          </button>
        ))}
        {stats && (
          <div className="ml-auto pr-2 text-xs tabular-nums text-muted-foreground">
            {stats.today} / {stats.dailyLimit} today · {stats.thisHour} / {stats.hourlyLimit} this hour
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'drafts' && <DraftsTab active />}
        {tab === 'queue' && <QueueTab />}
        {tab === 'replies' && <RepliesTab active onOpenDrafts={() => setTab('drafts')} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────

function DraftsTab({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: drafts = [], isLoading } = useQuery({ queryKey: DRAFTS_KEY, queryFn: () => api.listDrafts('draft') });

  const items = useMemo(
    () =>
      [...drafts].sort(
        (a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0) || a.companyName.localeCompare(b.companyName),
      ),
    [drafts],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Record<string, { subject: string; body: string }>>({});
  const [busy, setBusy] = useState(false);

  const index = items.findIndex((d) => d.id === selectedId);
  const selected = index >= 0 ? items[index] : null;

  useEffect(() => {
    const first = items[0];
    if (!selected && first) setSelectedId(first.id);
  }, [items, selected]);

  const company = useQuery({
    queryKey: ['company', selected?.companyId],
    queryFn: () => api.getCompany(selected!.companyId),
    enabled: Boolean(selected?.companyId),
  });

  const contacts: ContactRow[] = useMemo(() => {
    const list = company.data?.contacts ?? [];
    if (selected && !list.some((c) => c.id === selected.contactId)) {
      // Keep the To field populated while the company record is still loading.
      const stub: ContactRow = {
        id: selected.contactId,
        companyId: selected.companyId,
        fullName: selected.contactName,
        firstName: null,
        lastName: null,
        title: selected.contactTitle,
        persona: null,
        email: selected.toEmail,
        emailVerdict: selected.emailVerdict,
        emailVerifiedAt: null,
        emailSource: null,
        phone: null,
        linkedinUrl: null,
        isPrimary: true,
        contactScore: null,
        status: 'candidate',
        reviewed: false,
        notes: null,
      };
      return [stub, ...list];
    }
    return list;
  }, [company.data, selected]);

  const variables: DraftVariables = useMemo(() => {
    if (!selected) return {};
    const c = contacts.find((x) => x.id === selected.contactId);
    const name = c?.fullName ?? selected.contactName;
    const first = c?.firstName || name.trim().split(/\s+/)[0] || '';
    const reqs = company.data?.reqs ?? [];
    const req =
      reqs.find((r) => selected.reqIds.includes(r.id)) ??
      [...reqs].sort((a, b) => (b.daysOpen ?? 0) - (a.daysOpen ?? 0))[0];
    return {
      first_name: first,
      company: selected.companyName,
      req_title: req?.title ?? '',
      days_open: req?.daysOpen != null ? String(req.daysOpen) : '',
    };
  }, [selected, contacts, company.data]);

  // ── edit buffering ────────────────────────────────────────────────────────
  const pending = useRef<{ id: string; patch: { subject?: string; body?: string } } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try {
      const row = await api.patchDraft(p.id, p.patch);
      qc.setQueryData<DraftRow[]>(DRAFTS_KEY, (old) => old?.map((d) => (d.id === row.id ? row : d)));
    } catch (e) {
      toast.error('Edit not saved', { description: (e as Error).message });
    }
  }, [qc]);

  useEffect(() => () => void flush(), [flush]);

  const onChange = (patch: { subject?: string; body?: string }) => {
    if (!selected) return;
    const id = selected.id;
    qc.setQueryData<DraftRow[]>(DRAFTS_KEY, (old) =>
      old?.map((d) => (d.id === id ? { ...d, ...patch, edited: true } : d)),
    );
    pending.current = {
      id,
      patch: { ...(pending.current?.id === id ? pending.current.patch : {}), ...patch },
    };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };

  // ── actions ───────────────────────────────────────────────────────────────
  const advance = useCallback(() => {
    if (index < 0) return;
    const next = items[index + 1] ?? items[index - 1] ?? null;
    setSelectedId(next?.id ?? null);
  }, [index, items]);

  const act = useCallback(
    async (kind: 'queue' | 'skip' | 'reject') => {
      if (!selected || busy) return;
      const target = selected;
      const next = items[index + 1] ?? items[index - 1] ?? null;
      setBusy(true);
      try {
        await flush();
        if (kind === 'queue') {
          if (!target.toEmail) {
            toast.error('No address to send to', { description: 'Pick another decision maker first.' });
            return;
          }
          await api.queueDraft(target.id);
          toast.success(`Queued for ${target.companyName}`);
        } else if (kind === 'skip') {
          await api.skipDraft(target.id);
          toast.success('Skipped');
        } else {
          await api.skipDraft(target.id);
          await api.patchCompany(target.companyId, { status: 'rejected', reviewed: true });
          toast.success(`Rejected ${target.companyName}`);
        }
        setSelectedId(next?.id ?? null);
        qc.invalidateQueries({ queryKey: ['drafts'] });
        qc.invalidateQueries({ queryKey: STATS_KEY });
      } catch (e) {
        toast.error('Action failed', { description: (e as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [selected, busy, items, index, flush, qc],
  );

  const regenerate = useMutation({
    mutationFn: async (d: DraftRow) => {
      await flush();
      return api.generateDraft(d.companyId, d.contactId);
    },
    onSuccess: (row, d) => {
      setPrevious((p) => {
        const next = { ...p, [row.id]: { subject: d.subject, body: d.body } };
        if (row.id !== d.id) delete next[d.id];
        return next;
      });
      qc.invalidateQueries({ queryKey: DRAFTS_KEY });
      setSelectedId(row.id);
      toast.success('Regenerated', { description: 'The previous version is kept for comparison.' });
    },
    onError: (e: Error) => toast.error('Could not regenerate', { description: e.message }),
  });

  const restore = useMutation({
    mutationFn: async ({ id, prev }: { id: string; prev: { subject: string; body: string } }) => {
      await flush();
      return api.patchDraft(id, prev);
    },
    onSuccess: (row) => {
      qc.setQueryData<DraftRow[]>(DRAFTS_KEY, (old) => old?.map((d) => (d.id === row.id ? row : d)));
      setPrevious((p) => {
        const next = { ...p };
        delete next[row.id];
        return next;
      });
      toast.success('Previous version restored');
    },
    onError: (e: Error) => toast.error('Could not restore', { description: e.message }),
  });

  const switchContact = useMutation({
    mutationFn: async ({ draft, contactId }: { draft: DraftRow; contactId: string }) => {
      await flush();
      // One live draft per contact, so the outgoing one is retired before the
      // replacement is generated.
      await api.skipDraft(draft.id);
      return api.generateDraft(draft.companyId, contactId);
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: DRAFTS_KEY });
      setSelectedId(row.id);
      toast.success(`Now addressed to ${row.contactName}`);
    },
    onError: (e: Error) => toast.error('Could not switch recipient', { description: e.message }),
  });

  const enabled = active && Boolean(selected);
  useHotkeys('mod+enter', () => void act('queue'), { enabled, enableOnFormTags: ['input', 'textarea'] }, [act, enabled]);
  useHotkeys('s', () => void act('skip'), { enabled }, [act, enabled]);
  useHotkeys('x', () => void act('reject'), { enabled }, [act, enabled]);
  useHotkeys('n', () => advance(), { enabled }, [advance, enabled]);

  const left = (
    <RankedList
      items={items}
      selectedId={selectedId}
      focusedIndex={Math.max(0, index)}
      onFocus={(i: number) => {
        const row = items[i];
        if (row) setSelectedId(row.id);
      }}
      onSelect={(x: DraftRow | string) => setSelectedId(idOf(x))}
      renderRow={(d: DraftRow, i: number) => (
        <ListRow
          key={d.id}
          score={d.qualityScore ?? undefined}
          title={d.companyName}
          subtitle={`${d.contactName}${d.contactTitle ? ` · ${d.contactTitle}` : ''}`}
          chips={[
            { label: verdictLabel(d.emailVerdict), tone: verdictTone(d.emailVerdict) },
            ...(d.edited ? [{ label: 'edited', tone: 'neutral' as const }] : []),
          ]}
          selected={d.id === selectedId}
          focused={i === index}
          onClick={() => setSelectedId(d.id)}
        />
      )}
      emptyState={
        <EmptyState
          icon={<Mail className="h-6 w-6" />}
          title={isLoading ? 'Loading drafts…' : 'No drafts waiting'}
          description="Drafts are generated in the background as soon as you approve a company in Review."
        />
      }
    />
  );

  const right = selected ? (
    <EmailComposer
      key={selected.id}
      draft={selected}
      contacts={contacts}
      variables={variables}
      onChange={onChange}
      onSelectContact={(contactId) => switchContact.mutate({ draft: selected, contactId })}
      onRegenerate={() => regenerate.mutate(selected)}
      regenerating={regenerate.isPending}
      switchingContact={switchContact.isPending}
      previous={previous[selected.id] ?? null}
      onRestorePrevious={() => {
        const prev = previous[selected.id];
        if (prev) restore.mutate({ id: selected.id, prev });
      }}
      onDiscardPrevious={() =>
        setPrevious((p) => {
          const next = { ...p };
          delete next[selected.id];
          return next;
        })
      }
      signature={settings?.sending.signature ?? null}
      optOutLine={settings?.sending.includeOptOutLine ? DEFAULT_OPT_OUT_LINE : null}
      actions={
        <ActionBar
          actions={[
            {
              label: 'Queue for sending',
              hint: '⌘↵',
              variant: 'default',
              disabled: busy || !selected.toEmail,
              onClick: () => void act('queue'),
            },
            { label: 'Skip', hint: 's', variant: 'outline', disabled: busy, onClick: () => void act('skip') },
            {
              label: 'Reject',
              hint: 'x',
              variant: 'ghost',
              disabled: busy,
              onClick: () => void act('reject'),
            },
            { label: 'Next', hint: 'n', variant: 'ghost', onClick: advance },
          ]}
        />
      }
    />
  ) : (
    <DetailPane>
      <EmptyState
        icon={<Mail className="h-6 w-6" />}
        title="Nothing to draft"
        description="Approve companies in Review and their first email will be waiting here."
      />
    </DetailPane>
  );

  return <SplitView storageKey="outreach.drafts" left={left} right={right} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────────────

function QueueTab() {
  const qc = useQueryClient();
  const patch = useSettingsPatch();
  const { data: settings } = useSettings();
  const { data: stats } = useQuery({ queryKey: STATS_KEY, queryFn: () => api.getSendStats(), refetchInterval: 1000 });
  const { data: queue = [] } = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => api.listDrafts('queued'),
    refetchInterval: 5000,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: STATS_KEY });
    qc.invalidateQueries({ queryKey: ['drafts'] });
  };

  const start = useMutation({
    mutationFn: () => api.startSending(),
    onSuccess: () => {
      invalidate();
      toast.success('Sending started');
    },
    onError: (e: Error) => toast.error('Could not start', { description: e.message }),
  });

  const pause = useMutation({
    mutationFn: () => api.pauseSending(),
    onSuccess: () => {
      invalidate();
      toast.success('Sending paused');
    },
  });

  const sendNow = useMutation({
    mutationFn: (id: string) => api.sendNow(id),
    onSuccess: () => {
      invalidate();
      toast.success('Sent');
    },
    onError: (e: Error) => toast.error('Send failed', { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.skipDraft(id),
    onSuccess: () => {
      invalidate();
      toast.success('Removed from queue');
    },
  });

  const ordered = useMemo(
    () => [...queue].sort((a, b) => (a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity)),
    [queue],
  );

  const countdown = stats?.nextSendAt ? Math.max(0, stats.nextSendAt - now) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
        <div className="text-sm tabular-nums">
          {stats ? (
            <>
              <span className="font-medium">
                {stats.today} / {stats.dailyLimit}
              </span>{' '}
              <span className="text-muted-foreground">today</span>
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="font-medium">
                {stats.thisHour} / {stats.hourlyLimit}
              </span>{' '}
              <span className="text-muted-foreground">this hour</span>
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {!stats.running
                  ? 'paused'
                  : !stats.inWindow
                    ? `outside window (${stats.windowStart}–${stats.windowEnd})`
                    : countdown == null
                      ? 'no send scheduled'
                      : `next send in ${duration(countdown)}`}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Loading governor…</span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {stats?.running ? (
            <Button variant="outline" size="sm" onClick={() => pause.mutate()}>
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          ) : (
            <Button size="sm" onClick={() => start.mutate()} disabled={!settings?.gmail.connected}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Start
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={ordered.length === 0 || sendNow.isPending}
            onClick={() => ordered[0] && sendNow.mutate(ordered[0].id)}
          >
            <SkipForward className="mr-1.5 h-3.5 w-3.5" />
            Send next now
          </Button>
        </div>
      </header>

      {!settings?.gmail.connected && (
        <div className="border-b border-border bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
          Gmail is not connected — nothing will send until you connect it in Settings.
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_20rem] overflow-hidden">
        <div className="min-h-0 overflow-y-auto">
          {ordered.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={<Inbox className="h-6 w-6" />}
                title="The queue is empty"
                description="Queue drafts from the Drafts tab and they will send on the paced timer."
              />
            </div>
          ) : (
            <ol className="divide-y divide-border">
              {ordered.map((d, i) => (
                <li key={d.id} className="flex items-center gap-3 px-6 py-2.5">
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {d.companyName}
                      <span className="ml-2 text-xs text-muted-foreground">{d.subject}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {d.contactName} · {d.toEmail ?? 'no address'}
                    </div>
                  </div>
                  <StatusChip label={verdictLabel(d.emailVerdict)} tone={verdictTone(d.emailVerdict)} />
                  <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {d.scheduledAt ? clock(d.scheduledAt) : 'unscheduled'}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${d.companyName} from queue`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate(d.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <aside className="min-h-0 overflow-y-auto border-l border-border px-4 py-4">
          <Section title="Pacing" defaultOpen>
            <div className="space-y-3 py-1">
              <QueueSetting label="Sends per hour">
                <NumberBox
                  value={settings?.sending.perHour ?? 20}
                  min={1}
                  max={100}
                  onCommit={(perHour) => patch.mutate({ sending: { perHour } })}
                />
              </QueueSetting>
              <QueueSetting label="Sends per day">
                <NumberBox
                  value={settings?.sending.perDay ?? 400}
                  min={1}
                  max={500}
                  onCommit={(perDay) => patch.mutate({ sending: { perDay } })}
                />
              </QueueSetting>
              <QueueSetting label="Active window">
                <div className="flex items-center gap-1">
                  <Input
                    type="time"
                    value={settings?.sending.windowStart ?? '09:00'}
                    className="h-7 w-24 text-xs"
                    onChange={(e) => patch.mutate({ sending: { windowStart: e.target.value } })}
                  />
                  <Input
                    type="time"
                    value={settings?.sending.windowEnd ?? '17:00'}
                    className="h-7 w-24 text-xs"
                    onChange={(e) => patch.mutate({ sending: { windowEnd: e.target.value } })}
                  />
                </div>
              </QueueSetting>
              <QueueSetting label="Jitter">
                <NumberBox
                  value={settings?.sending.jitterPct ?? 40}
                  min={0}
                  max={90}
                  suffix="%"
                  onCommit={(jitterPct) => patch.mutate({ sending: { jitterPct } })}
                />
              </QueueSetting>
              <QueueSetting label="Send on weekends">
                <Switch
                  checked={settings?.sending.weekends ?? false}
                  onCheckedChange={(weekends) => patch.mutate({ sending: { weekends } })}
                />
              </QueueSetting>
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                Closing the app pauses the queue. Reopening resumes it; every send carries an idempotency key, so
                nothing goes out twice.
              </p>
            </div>
          </Section>
        </aside>
      </div>
    </div>
  );
}

function QueueSetting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function NumberBox({
  value,
  onCommit,
  min,
  max,
  suffix,
}: {
  value: number;
  onCommit(n: number): void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        value={text}
        min={min}
        max={max}
        className="h-7 w-20 text-xs"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Replies
// ─────────────────────────────────────────────────────────────────────────────

const KIND_TONE: Record<InboundRow['kind'], 'good' | 'bad' | 'warn' | 'neutral'> = {
  reply: 'good',
  bounce: 'bad',
  auto_reply: 'warn',
  unmatched: 'neutral',
};

function RepliesTab({ active, onOpenDrafts }: { active: boolean; onOpenDrafts(): void }) {
  const qc = useQueryClient();
  const [showHandled, setShowHandled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bounceOffer, setBounceOffer] = useState<{ company: CompanyDetail; contact: ContactRow } | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['inbound', showHandled],
    queryFn: () => (showHandled ? api.listInbound() : api.listInbound(false)),
    refetchInterval: 30_000,
  });

  const items = useMemo(() => [...rows].sort((a, b) => b.receivedAt - a.receivedAt), [rows]);
  const index = items.findIndex((r) => r.id === selectedId);
  const selected = index >= 0 ? items[index] : null;

  useEffect(() => {
    const first = items[0];
    if (!selected && first) setSelectedId(first.id);
  }, [items, selected]);

  const company = useQuery({
    queryKey: ['company', selected?.companyId],
    queryFn: () => api.getCompany(selected!.companyId!),
    enabled: Boolean(selected?.companyId),
  });

  const sync = useMutation({
    mutationFn: () => api.syncInbox(),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ['inbound'] });
      toast.success(n > 0 ? `${n} new message${n === 1 ? '' : 's'}` : 'Inbox up to date');
    },
    onError: (e: Error) => toast.error('Inbox sync failed', { description: e.message }),
  });

  const advance = useCallback(() => {
    const next = items[index + 1] ?? items[index - 1] ?? null;
    setSelectedId(next?.id ?? null);
  }, [items, index]);

  const mark = useCallback(
    async (action: 'positive' | 'negative' | 'bounce' | 'ignore') => {
      if (!selected) return;
      const row = selected;
      const next = items[index + 1] ?? items[index - 1] ?? null;
      try {
        await api.markInbound(row.id, action);
        if (action === 'positive') {
          toast.success(`Marked positive — ${row.companyName ?? row.fromEmail}`, {
            description: 'Follow up from here; the company is flagged as replied.',
          });
        } else if (action === 'negative') {
          toast.success('Marked negative', { description: 'The domain is suppressed — no further outreach.' });
        } else if (action === 'bounce') {
          toast.success('Bounce confirmed', { description: 'The address is marked invalid.' });
          if (row.companyId) {
            const detail = await api.getCompany(row.companyId);
            const alt = detail?.contacts.find(
              (c) =>
                c.id !== row.contactId &&
                c.email &&
                c.emailVerdict !== 'invalid' &&
                c.status !== 'bounced' &&
                c.status !== 'rejected',
            );
            if (detail && alt) setBounceOffer({ company: detail, contact: alt });
          }
        }
        qc.invalidateQueries({ queryKey: ['inbound'] });
        qc.invalidateQueries({ queryKey: ['company', row.companyId] });
        if (!showHandled) setSelectedId(next?.id ?? null);
      } catch (e) {
        toast.error('Could not update', { description: (e as Error).message });
      }
    },
    [selected, items, index, qc, showHandled],
  );

  const draftNext = useMutation({
    mutationFn: ({ companyId, contactId }: { companyId: string; contactId: string }) =>
      api.generateDraft(companyId, contactId),
    onSuccess: (row) => {
      setBounceOffer(null);
      qc.invalidateQueries({ queryKey: ['drafts'] });
      toast.success(`Drafted to ${row.contactName}`, { description: 'Waiting for you in Drafts.' });
      onOpenDrafts();
    },
    onError: (e: Error) => toast.error('Could not draft', { description: e.message }),
  });

  const enabled = active && Boolean(selected);
  useHotkeys('p', () => void mark('positive'), { enabled }, [mark, enabled]);
  useHotkeys('n', () => void mark('negative'), { enabled }, [mark, enabled]);
  useHotkeys('b', () => void mark('bounce'), { enabled }, [mark, enabled]);
  useHotkeys(
    'o',
    () => {
      if (selected?.fromEmail) {
        void api.openExternal(
          `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(selected.fromEmail)}`,
        );
      }
    },
    { enabled },
    [selected, enabled],
  );

  const left = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', sync.isPending && 'animate-spin')} />
          Sync inbox
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Handled
          <Switch checked={showHandled} onCheckedChange={setShowHandled} />
        </label>
      </div>
      <div className="min-h-0 flex-1">
        <RankedList
          items={items}
          selectedId={selectedId}
          focusedIndex={Math.max(0, index)}
          onFocus={(i: number) => {
            const row = items[i];
            if (row) setSelectedId(row.id);
          }}
          onSelect={(x: InboundRow | string) => setSelectedId(idOf(x))}
          renderRow={(r: InboundRow, i: number) => (
            <ListRow
              key={r.id}
              title={r.companyName ?? r.fromEmail ?? 'Unknown sender'}
              subtitle={r.subject ?? r.snippet ?? ''}
              chips={[
                { label: r.kind.replace('_', '-'), tone: KIND_TONE[r.kind] },
                ...(r.handled ? [{ label: 'handled', tone: 'muted' as const }] : []),
              ]}
              selected={r.id === selectedId}
              focused={i === index}
              onClick={() => setSelectedId(r.id)}
            />
          )}
          emptyState={
            <EmptyState
              icon={<Inbox className="h-6 w-6" />}
              title={isLoading ? 'Loading…' : showHandled ? 'Nothing here yet' : 'No unhandled replies'}
              description="Replies, bounces and auto-responses land here once the inbox is synced."
              action={{ label: 'Sync inbox', onClick: () => sync.mutate() }}
            />
          }
        />
      </div>
    </div>
  );

  const right = selected ? (
    <div className="flex h-full min-h-0 flex-col">
      <DetailPane>
        <div className="px-5 py-4">
          <div className="flex items-center gap-2">
            <StatusChip label={selected.kind.replace('_', '-')} tone={KIND_TONE[selected.kind]} />
            <span className="text-xs text-muted-foreground">{full(selected.receivedAt)}</span>
            {selected.fromEmail && (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  void api.openExternal(
                    `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(selected.fromEmail!)}`,
                  )
                }
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open in Gmail
              </button>
            )}
          </div>
          <h2 className="mt-2 text-base font-medium">{selected.subject ?? '(no subject)'}</h2>
          <div className="mt-0.5 text-xs text-muted-foreground">{selected.fromEmail ?? 'unknown sender'}</div>
        </div>

        <Section title="Message" defaultOpen>
          <div className="whitespace-pre-wrap px-1 py-2 text-[13px] leading-[1.6]">
            {selected.snippet ?? 'No content captured for this message.'}
          </div>
        </Section>

        {selected.kind === 'bounce' && (
          <Section title="Bounce detail" defaultOpen>
            <div className="space-y-1 py-2 text-sm">
              <div>
                <span className="text-muted-foreground">Recipient: </span>
                {selected.bounceRecipient ?? 'unknown'}
              </div>
              <div>
                <span className="text-muted-foreground">Status: </span>
                {selected.bounceStatus ?? 'unknown'}
              </div>
            </div>
          </Section>
        )}

        {company.data && (
          <Section title="Company" count={company.data.contacts.length} defaultOpen>
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2">
                {company.data.qualityScore != null && (
                  <ScoreBadge score={company.data.qualityScore} breakdown={company.data.scoreBreakdown} />
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{company.data.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[company.data.domain, company.data.headcount ? `${company.data.headcount} people` : null,
                      `${company.data.openReqCount} open reqs`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              </div>
              {company.data.scoreHeadline && (
                <p className="text-xs leading-relaxed text-muted-foreground">{company.data.scoreHeadline}</p>
              )}
              <div className="space-y-1">
                {company.data.contacts.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 text-xs">
                    <span className="truncate">{c.fullName}</span>
                    <span className="truncate text-muted-foreground">{c.title ?? ''}</span>
                    <span className="ml-auto truncate text-muted-foreground">{c.email ?? 'no address'}</span>
                    <StatusChip label={verdictLabel(c.emailVerdict)} tone={verdictTone(c.emailVerdict)} />
                  </div>
                ))}
              </div>
            </div>
          </Section>
        )}
      </DetailPane>

      <ActionBar
        actions={[
          { label: 'Positive', hint: 'p', variant: 'default', onClick: () => void mark('positive') },
          { label: 'Negative', hint: 'n', variant: 'outline', onClick: () => void mark('negative') },
          { label: 'Confirm bounce', hint: 'b', variant: 'outline', onClick: () => void mark('bounce') },
          { label: 'Ignore', hint: '', variant: 'ghost', onClick: () => void mark('ignore') },
          { label: 'Next', hint: '↓', variant: 'ghost', onClick: advance },
        ]}
      />
    </div>
  ) : (
    <DetailPane>
      <EmptyState
        icon={<MailX className="h-6 w-6" />}
        title="No message selected"
        description="Pick a reply on the left, or sync the inbox to pull new mail."
      />
    </DetailPane>
  );

  return (
    <>
      <SplitView storageKey="outreach.replies" left={left} right={right} />
      <Dialog open={Boolean(bounceOffer)} onOpenChange={(o) => !o && setBounceOffer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Try the next decision maker?</DialogTitle>
            <DialogDescription>
              {bounceOffer?.contact.fullName}
              {bounceOffer?.contact.title ? ` (${bounceOffer.contact.title})` : ''} at{' '}
              {bounceOffer?.company.name} still has a usable address —{' '}
              {bounceOffer?.contact.email}. Draft to them instead?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setBounceOffer(null)}>
              Not now
            </Button>
            <Button
              disabled={draftNext.isPending}
              onClick={() =>
                bounceOffer &&
                draftNext.mutate({ companyId: bounceOffer.company.id, contactId: bounceOffer.contact.id })
              }
            >
              Draft to {bounceOffer?.contact.firstName ?? bounceOffer?.contact.fullName}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function full(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default Outreach;
