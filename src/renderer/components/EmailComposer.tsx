import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Eye, Pencil, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ContactRow, DraftRow } from '../../shared/ipc.js';
import { DEFAULT_OPT_OUT_LINE } from '../../shared/outreach.js';
import { api } from '../lib/api.js';
import { verdictLabel, verdictTone } from '../lib/format.js';
import { useSettings } from '../screens/Settings.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';
import { StatusChip } from './StatusChip.js';
import { cn } from '../lib/utils.js';

export const VARIABLE_KEYS = ['first_name', 'req_title', 'days_open', 'company'] as const;
export type VariableKey = (typeof VARIABLE_KEYS)[number];
export type DraftVariables = Partial<Record<VariableKey, string>> & Record<string, string | undefined>;

const VAR_RE = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;

export function resolveVariables(text: string, vars: DraftVariables): string {
  // An unresolved variable stays visible as `{{name}}` rather than collapsing to
  // an empty string, so a broken merge can never silently ship as normal prose.
  return text.replace(VAR_RE, (match, name: string) => vars[name] ?? match);
}

export function unresolvedVariables(text: string, vars: DraftVariables): string[] {
  const missing = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1];
    if (name && !vars[name]) missing.add(name);
  }
  return [...missing];
}

export interface EmailComposerProps {
  draft: DraftRow;
  /** Every decision-maker at the company, for the To dropdown. */
  contacts: ContactRow[];
  variables: DraftVariables;
  onChange(patch: { subject?: string; body?: string }): void;
  /**
   * Awaited before the test send fires — the host flushes its debounced edit
   * buffer here so the test mail carries the keystrokes of the last 600ms.
   */
  onBeforeTest?: () => Promise<void>;
  onSelectContact(contactId: string): void;
  onRegenerate(): void;
  regenerating?: boolean;
  switchingContact?: boolean;
  /** The draft as it was before the last Regenerate, kept so the two can be compared. */
  previous?: { subject: string; body: string } | null;
  onRestorePrevious?(): void;
  onDiscardPrevious?(): void;
  actions?: ReactNode;
}

export function EmailComposer({
  draft,
  contacts,
  variables,
  onChange,
  onBeforeTest,
  onSelectContact,
  onRegenerate,
  regenerating = false,
  switchingContact = false,
  previous = null,
  onRestorePrevious,
  onDiscardPrevious,
  actions,
}: EmailComposerProps) {
  const [subject, setSubject] = useState(draft.subject);
  const [testSending, setTestSending] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [preview, setPreview] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const server = useRef({ subject: draft.subject, body: draft.body });

  // Adopt server-side changes (regenerate, restore) without clobbering keystrokes
  // that have not been flushed yet.
  useEffect(() => {
    if (draft.subject !== server.current.subject) {
      const untouched = subject === server.current.subject;
      server.current.subject = draft.subject;
      if (untouched) setSubject(draft.subject);
    }
    if (draft.body !== server.current.body) {
      const untouched = body === server.current.body;
      server.current.body = draft.body;
      if (untouched) setBody(draft.body);
    }
  }, [draft.subject, draft.body, subject, body]);

  const contact = contacts.find((c) => c.id === draft.contactId);
  const toEmail = contact?.email ?? draft.toEmail;
  const verdict = contact?.emailVerdict ?? draft.emailVerdict;

  const missing = useMemo(
    () => [...new Set([...unresolvedVariables(subject, variables), ...unresolvedVariables(body, variables)])],
    [subject, body, variables],
  );

  // Footer divergence: the sender re-appends the opt-out line / postal address
  // main-side when settings require them (ensureCompliantFooter), so an edit
  // that removed them here makes the on-screen body diverge from what will
  // actually send. The detection mirrors the sender's newline-normalised,
  // line-anchored checks.
  const { data: settings } = useSettings();
  const missingFooter = useMemo(() => {
    const sending = settings?.sending;
    if (!sending) return [];
    const out: string[] = [];
    const normalised = body.replace(/\r\n/g, '\n');
    if (sending.includeOptOutLine && !normalised.includes(DEFAULT_OPT_OUT_LINE)) {
      out.push('opt-out line');
    }
    const postal = (sending.postalAddress ?? '').trim();
    if (postal) {
      const postalLines = postal
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const bodyLines = new Set(normalised.split('\n').map((l) => l.trim()));
      if (!postalLines.every((l) => bodyLines.has(l))) out.push('postal address');
    }
    return out;
  }, [settings, body]);

  const commitSubject = (value: string) => {
    setSubject(value);
    onChange({ subject: value });
  };

  const commitBody = (value: string) => {
    setBody(value);
    onChange({ body: value });
  };

  const insertVariable = (name: VariableKey) => {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    if (!el) {
      commitBody(`${body}${token}`);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    commitBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const syncScroll = () => {
    if (overlayRef.current && bodyRef.current) {
      overlayRef.current.scrollTop = bodyRef.current.scrollTop;
      overlayRef.current.scrollLeft = bodyRef.current.scrollLeft;
    }
  };

  const renderedSubject = resolveVariables(subject, variables);
  // The stored body is final — signature, opt-out line and postal address were
  // baked in at generation (and the sender re-appends the compliance footer if
  // an edit removed it). Appending anything here would preview a double footer.
  const renderedBody = resolveVariables(body, variables);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{draft.companyName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {draft.contactTitle ?? 'Decision maker'} · {draft.edited ? 'edited' : 'generated'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPreview((p) => !p)}>
              {preview ? <Pencil className="mr-1.5 h-3.5 w-3.5" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
              {preview ? 'Edit' : 'Preview'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={testSending}
              title="Send this draft to your own inbox with a [TEST] subject — no prospect is touched"
              onClick={() => {
                setTestSending(true);
                void (async () => {
                  // Flush the host's debounced edits first, or the test mail
                  // would be missing the last ~600ms of typing.
                  await onBeforeTest?.();
                  const address = await api.sendTestEmail(draft.id);
                  toast.success('Test sent', { description: `Check ${address}` });
                })()
                  .catch((e: unknown) =>
                    toast.error('Test send failed', { description: (e as Error).message }),
                  )
                  .finally(() => setTestSending(false));
              }}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Test to me
            </Button>
            <Button variant="outline" size="sm" onClick={onRegenerate} disabled={regenerating}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', regenerating && 'animate-spin')} />
              Regenerate
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">To</span>
          <Select
            value={draft.contactId}
            onValueChange={(id) => id !== draft.contactId && onSelectContact(id)}
            disabled={switchingContact}
          >
            <SelectTrigger className="h-8 min-w-0 flex-1 text-sm">
              <SelectValue placeholder="Select a decision maker" />
            </SelectTrigger>
            <SelectContent>
              {contacts.map((c) => (
                <SelectItem key={c.id} value={c.id} disabled={!c.email}>
                  <span className="truncate">
                    {c.fullName}
                    {c.title ? ` — ${c.title}` : ''}
                    {c.email ? ` · ${c.email}` : ' · no address'}
                  </span>
                </SelectItem>
              ))}
              {contacts.length === 0 && (
                <SelectItem value={draft.contactId}>{draft.contactName}</SelectItem>
              )}
            </SelectContent>
          </Select>
          <StatusChip label={verdictLabel(verdict)} tone={verdictTone(verdict)} />
        </div>
        {toEmail && (
          <div className="pl-16 text-xs text-muted-foreground">{toEmail}</div>
        )}
      </header>

      {previous && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-5 py-2 text-xs">
          <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Previous version kept</span>
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setShowPrevious((v) => !v)}>
            {showPrevious ? 'Hide' : 'Compare'}
          </Button>
          {onRestorePrevious && (
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={onRestorePrevious}>
              Restore
            </Button>
          )}
          {onDiscardPrevious && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 w-6 p-0"
              aria-label="Discard previous version"
              onClick={onDiscardPrevious}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <span className="w-14 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">Subject</span>
          {preview ? (
            <div className="flex-1 truncate text-sm font-medium">{renderedSubject}</div>
          ) : (
            <Input
              value={subject}
              onChange={(e) => commitSubject(e.target.value)}
              className="h-8 flex-1 text-sm"
              placeholder="Subject"
            />
          )}
        </div>

        {!preview && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
            <span className="mr-1 text-xs text-muted-foreground">Insert</span>
            {VARIABLE_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => insertVariable(k)}
                className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                title={variables[k] ? `resolves to “${variables[k]}”` : 'no value available for this record'}
              >
                {`{{${k}}}`}
              </button>
            ))}
          </div>
        )}

        {missing.length > 0 && !preview && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>
              No value for {missing.map((m) => `{{${m}}}`).join(', ')} — it will send literally.
            </span>
          </div>
        )}

        {missingFooter.length > 0 && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>
              The {missingFooter.join(' and ')} {missingFooter.length > 1 ? 'were' : 'was'} removed
              here — {missingFooter.length > 1 ? 'they' : 'it'} will be re-added automatically when
              this sends.
            </span>
          </div>
        )}

        {preview ? (
          <div className="whitespace-pre-wrap px-5 py-4 text-[13px] leading-[1.6]">{renderedBody}</div>
        ) : showPrevious && previous ? (
          <div className="grid grid-cols-2 divide-x divide-border">
            <div className="px-5 py-4">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Previous</div>
              <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-muted-foreground">
                {previous.body}
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Current</div>
              <div className="whitespace-pre-wrap text-[13px] leading-[1.6]">{body}</div>
            </div>
          </div>
        ) : (
          <div className="relative px-5 py-4">
            <div
              ref={overlayRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-5 py-4 text-[13px] leading-[1.6]"
            >
              {highlightVariables(body, variables)}
            </div>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => commitBody(e.target.value)}
              onScroll={syncScroll}
              spellCheck
              className="relative block h-[52vh] w-full resize-none bg-transparent text-[13px] leading-[1.6] text-transparent caret-foreground outline-none"
              placeholder="Body"
            />
          </div>
        )}
      </div>

      {actions && <div className="border-t border-border">{actions}</div>}
    </div>
  );
}

function highlightVariables(text: string, vars: DraftVariables): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const name = m[1] ?? '';
    const known = Boolean(vars[name]);
    out.push(
      <span
        key={`v${i++}`}
        className={cn(
          'rounded px-0.5',
          known ? 'bg-primary/15 text-primary' : 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
        )}
      >
        {m[0]}
      </span>,
    );
    last = start + m[0].length;
  }
  out.push(text.slice(last));
  // Trailing zero-width char keeps the mirrored overlay's height in step with the
  // textarea when the body ends in a newline.
  out.push('​');
  return out;
}

export default EmailComposer;
