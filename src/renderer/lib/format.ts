/** Presentation-only formatting. No business rules live here. */

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

export function compBand(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${usd(min)}–${usd(max)}`;
  return usd(min ?? max);
}

export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Epoch ms (or ISO string) → "3d ago". Compact by design: it sits in dense rows. */
export function ago(at: number | string | null | undefined, now = Date.now()): string {
  const t = toMillis(at);
  if (t == null) return '—';
  const secs = Math.round((now - t) / 1000);
  if (secs < 0) return inFuture(-secs);
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  const days = Math.round(secs / 86_400);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30.44)}mo ago`;
  return `${(days / 365.25).toFixed(1)}y ago`;
}

function inFuture(secs: number): string {
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86_400)}d`;
}

export function dateShort(at: number | string | null | undefined): string {
  const t = toMillis(at);
  if (t == null) return '—';
  return new Date(t).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function dateTime(at: number | string | null | undefined): string {
  const t = toMillis(at);
  if (t == null) return '—';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function countdown(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function toMillis(at: number | string | null | undefined): number | null {
  if (at == null) return null;
  if (typeof at === 'number') {
    if (!Number.isFinite(at) || at === 0) return null;
    // Tolerate seconds-precision timestamps from any source that stores them.
    return at < 1e11 ? at * 1000 : at;
  }
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

const PERSONA_LABELS: Record<string, string> = {
  founder_ceo: 'Founder / CEO',
  cto_vpe: 'CTO / VP Eng',
  head_of_talent: 'Head of Talent',
  recruiter: 'Recruiter',
  hiring_manager: 'Hiring Manager',
  coo_ops: 'COO / Ops',
  other: 'Other',
};

export function personaLabel(p: string | null | undefined): string {
  if (!p) return '—';
  return PERSONA_LABELS[p] ?? titleCase(p);
}

export const PERSONA_OPTIONS = Object.entries(PERSONA_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const VERDICT_LABELS: Record<string, string> = {
  valid: 'valid',
  invalid: 'invalid',
  catch_all: 'catch-all',
  unknown: 'unknown',
  role: 'role address',
  disposable: 'disposable',
  unverified: 'unverified',
};

export function verdictLabel(v: string | null | undefined): string {
  if (!v) return 'unverified';
  return VERDICT_LABELS[v] ?? v;
}

export type Tone = 'default' | 'green' | 'amber' | 'red' | 'blue';

export function verdictTone(v: string | null | undefined): Tone {
  switch (v) {
    case 'valid':
      return 'green';
    case 'catch_all':
      return 'amber';
    case 'invalid':
    case 'disposable':
      return 'red';
    case 'role':
      return 'blue';
    default:
      return 'default';
  }
}

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'approved':
    case 'replied':
    case 'sent':
      return 'green';
    case 'rejected':
    case 'suppressed':
    case 'bounced':
      return 'red';
    case 'scored':
    case 'enriched':
    case 'queued':
      return 'blue';
    case 'contacted':
      return 'amber';
    default:
      return 'default';
  }
}

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const SOURCE_LABELS: Record<string, string> = {
  yc: 'YC directory',
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  workday: 'Workday',
  careers_page: 'Careers page',
  hn_whoishiring: "HN Who's Hiring",
  sec_formd: 'SEC Form D',
  linkedin: 'LinkedIn',
  dns: 'DNS',
  verifier: 'Email verifier',
  pattern_inference: 'Pattern inference',
  human: 'You',
};

export function sourceLabel(s: string | null | undefined): string {
  if (!s) return 'unknown';
  return SOURCE_LABELS[s] ?? titleCase(s);
}

export function fieldLabel(field: string): string {
  const special: Record<string, string> = {
    domain: 'Domain',
    hqLocation: 'HQ location',
    hq_location: 'HQ location',
    linkedinUrl: 'LinkedIn URL',
    careersUrl: 'Careers URL',
    atsPlatform: 'ATS platform',
    ycBatch: 'YC batch',
    recruiterCount: 'In-house recruiters',
    hasInhouseTa: 'Has in-house TA',
    fundingStage: 'Funding stage',
    lastRoundAt: 'Last round',
  };
  if (special[field]) return special[field];
  return titleCase(field.replace(/([a-z])([A-Z])/g, '$1 $2'));
}
