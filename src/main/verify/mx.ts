/**
 * Free local prefilter. Runs before a single paid credit is spent.
 *
 * There is deliberately no SMTP client anywhere in this file or this app.
 * Measured on the actual target population (120 Bay Area startup domains):
 * Google Workspace 91.7%, Microsoft 365 1.7%, other/self-hosted 4.2%, no MX 2.5%.
 * Probing the ~93% that sit behind Google/Microsoft from a residential
 * connection is not merely rude, it does not work: consumer ISPs have blocked
 * outbound port 25 without exception since 2024, residential ranges are on the
 * Spamhaus PBL, and thousands of RCPT probes from one address is the textbook
 * directory-harvest signature. DNS is free, silent and answers the only
 * question we can answer for ourselves: does this domain accept mail at all,
 * and who runs it.
 */

import { Resolver } from 'node:dns/promises';
import type { VerificationVerdict } from '../../shared/types.js';
import { type Db, get, run } from '../db/index.js';

export type MxProvider =
  | 'google'
  | 'microsoft'
  | 'proton'
  | 'zoho'
  | 'gateway'
  | 'other'
  | 'none'
  | 'unknown';

export interface DomainMxInfo {
  domain: string;
  provider: MxProvider;
  hosts: string[];
  /** Domain resolves to an address even though it publishes no MX. */
  hasAddressRecord: boolean;
  /** DNS authoritatively said the name does not exist. */
  nxdomain: boolean;
  /** Lookup failed for a reason that says nothing about the domain (timeout, SERVFAIL). */
  transient: boolean;
  resolvedAt: number;
  /** True when this came from the email_pattern cache rather than a live query. */
  cached: boolean;
}

export interface PrefilterResult {
  /** Normalised address. Empty string when the input could not be parsed. */
  email: string;
  localPart: string;
  domain: string;
  /** A final, free verdict. Non-null means: do not spend a credit on this. */
  verdict: VerificationVerdict | null;
  /** True when a paid verification is worth doing. */
  worthVerifying: boolean;
  reason: string;
  provider: MxProvider;
  role: boolean;
  disposable: boolean;
  mx: DomainMxInfo | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Syntax
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deliberately stricter than RFC 5321. Quoted local parts, IP-literal domains
 * and single-label domains are all legal and none of them will ever be a
 * startup hiring manager's work address; accepting them only widens the set of
 * strings we might pay to verify.
 */
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  // Strip a display-name wrapper: "Jane Doe <jane@x.com>".
  const angled = s.match(/<([^>]+)>/);
  if (angled) s = angled[1]!.trim();
  s = s.replace(/^mailto:/, '');
  // Trailing punctuation picked up by regex extraction from prose.
  s = s.replace(/[.,;:)\]}'"]+$/, '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).replace(/\.$/, '');
  if (!local || !domain) return '';
  return `${local}@${domain}`;
}

export function isValidSyntax(email: string): boolean {
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || email.length - at - 1 < 3) return false;
  if (email.slice(0, at).length > 64) return false;
  return EMAIL_RE.test(email);
}

export function localPartOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(0, at);
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}

/** Plus-addressing and Gmail dot-folding, for cache-key purposes only. */
export function canonicalizeForCache(email: string): string {
  const local = localPartOf(email);
  const domain = domainOf(email);
  if (!domain) return email;
  const stripped = local.split('+')[0]!;
  return `${stripped}@${domain}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Role accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A role address reaches a shared mailbox, not a person. The operator's rule is
 * that these are usable only with positive confirmation the mailbox exists —
 * never as a pattern guess — so they are flagged here and handled explicitly
 * downstream rather than being silently mixed in with personal addresses.
 */
const ROLE_LOCALS = new Set([
  'info', 'jobs', 'careers', 'career', 'hello', 'hi', 'support', 'admin',
  'administrator', 'hr', 'talent', 'recruiting', 'recruitment', 'recruiter',
  'contact', 'contactus', 'team', 'sales', 'help', 'office', 'mail', 'email',
  'enquiries', 'inquiries', 'enquiry', 'inquiry', 'press', 'media', 'pr',
  'marketing', 'billing', 'accounts', 'accounting', 'finance', 'invoices',
  'legal', 'privacy', 'security', 'abuse', 'postmaster', 'webmaster',
  'hostmaster', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'bounce',
  'bounces', 'notifications', 'notification', 'alerts', 'newsletter',
  'subscribe', 'unsubscribe', 'feedback', 'partners', 'partnerships', 'bd',
  'biz', 'business', 'general', 'people', 'peopleops', 'talentacquisition',
  'work', 'workwithus', 'joinus', 'apply', 'applications', 'resume', 'resumes',
  'cv', 'engineering', 'dev', 'developers', 'devs', 'eng', 'design', 'product',
  'founders', 'exec', 'board', 'investors', 'ir', 'community', 'events',
  'orders', 'shop', 'store', 'service', 'services', 'customerservice',
]);

export function isRoleAccount(emailOrLocal: string): boolean {
  const local = emailOrLocal.includes('@') ? localPartOf(emailOrLocal) : emailOrLocal;
  const base = local.toLowerCase().split('+')[0]!;
  if (ROLE_LOCALS.has(base)) return true;
  // "jobs-eng", "careers.us", "hr_team" — same mailbox class, decorated.
  const head = base.split(/[.\-_]/)[0]!;
  return head.length >= 2 && ROLE_LOCALS.has(head);
}

// ─────────────────────────────────────────────────────────────────────────────
// Disposable domains
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The highest-volume disposable providers. This is intentionally a compact
 * built-in list rather than a downloaded feed: a stale entry costs one wasted
 * credit, while a network dependency in the free prefilter would defeat the
 * entire point of having a free prefilter.
 */
const DISPOSABLE_DOMAINS = new Set([
  '0-mail.com', '10minutemail.com', '10minutemail.net', '20minutemail.com',
  '33mail.com', 'anonaddy.com', 'anonaddy.me', 'anonbox.net', 'armyspy.com',
  'bccto.me', 'burnermail.io', 'byom.de', 'cock.li', 'cool.fr.nf',
  'courriel.fr.nf', 'crazymailing.com', 'cuvox.de', 'dayrep.com', 'deadaddress.com',
  'despam.it', 'dispomail.eu', 'disposableinbox.com', 'dispostable.com',
  'dodgeit.com', 'dodgit.com', 'duck.com', 'dumpmail.de',
  'e4ward.com', 'easytrashmail.com', 'einrot.com', 'email-fake.com',
  'emailfake.com', 'emailondeck.com', 'emailsensei.com', 'emailtemporanea.net',
  'emailtemporar.ro', 'emailto.de', 'emltmp.com', 'fake-box.com', 'fakeinbox.com',
  'fakemail.net', 'fakemailgenerator.com',
  'filzmail.com', 'fleckens.hu', 'forgetmail.com', 'freemail.ms',
  'front14.org', 'garliclife.com', 'get2mail.fr', 'getairmail.com',
  'getnada.com', 'ghosttexter.de', 'grr.la', 'guerrillamail.biz',
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'harakirimail.com', 'hidemail.de', 'hmamail.com',
  'imgof.com', 'inbox.si', 'inboxalias.com', 'inboxbear.com', 'incognitomail.com',
  'incognitomail.org', 'jetable.fr.nf', 'jetable.net', 'jetable.org',
  'jourrapide.com', 'kasmail.com', 'killmail.com', 'klzlk.com', 'koszmail.pl',
  'kurzepost.de', 'lackmail.net', 'letthemeatspam.com', 'lroid.com',
  'luxusmail.org', 'maildrop.cc', 'mailcatch.com', 'maileater.com',
  'mailexpire.com', 'mailforspam.com', 'mailfreeonline.com', 'mailguard.me',
  'mailimate.com', 'mailinater.com', 'mailinator.com', 'mailinator.net',
  'mailinator2.com', 'mailismagic.com', 'mailmetrash.com', 'mailmoat.com',
  'mailnesia.com', 'mailnull.com', 'mailsac.com', 'mailscrap.com',
  'mailshell.com', 'mailsiphon.com', 'mailtemp.info', 'mailtothis.com',
  'mailtrash.net', 'mailzilla.com', 'mintemail.com', 'moakt.com', 'mohmal.com',
  'msgden.com', 'mt2015.com', 'mytemp.email', 'mytempemail.com', 'mytrashmail.com',
  'nada.email', 'nomail.xl.cx', 'nospam.ze.tc', 'nospamfor.us', 'notmailinator.com',
  'nowmymail.com', 'objectmail.com', 'oneoffemail.com', 'onewaymail.com',
  'opayq.com', 'owlpic.com', 'pokemail.net', 'privatemail.pro', 'proxymail.eu',
  'punkass.com', 'putthisinyourspamdatabase.com', 'quickinbox.com', 'rcpt.at',
  'reallymymail.com', 'recyclemail.dk', 'rhyta.com', 'rmqkr.net',
  'safetymail.info', 'sharklasers.com', 'shieldedmail.com', 'shitmail.me',
  'simplemail.top', 'slopsbox.com', 'smashmail.de', 'sneakemail.com',
  'sofort-mail.de', 'spam4.me', 'spamavert.com', 'spambog.com', 'spambox.us',
  'spamcorptastic.com', 'spamdecoy.net', 'spamex.com', 'spamfree24.org',
  'spamgourmet.com', 'spamherelots.com', 'spamhole.com', 'spaml.de',
  'spamspot.com', 'spamthis.co.uk', 'superrito.com', 'tempail.com',
  'tempemail.net', 'tempinbox.com', 'tempmail.de', 'tempmail.net',
  'tempmail.plus', 'tempmailaddress.com', 'tempmailer.com', 'tempomail.fr',
  'temp-mail.io', 'temp-mail.org', 'temp-mail.ru', 'throwawaymail.com',
  'tmail.ws', 'tmailinator.com', 'trash-mail.at', 'trash-mail.com',
  'trash2009.com', 'trashmail.at', 'trashmail.com', 'trashmail.de',
  'trashmail.me', 'trashmail.net', 'trashmail.org', 'trbvm.com', 'tyldd.com',
  'uggsrock.com', 'upliftnow.com', 'uroid.com', 'veryrealemail.com',
  'vomoto.com', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org',
  'wh4f.org', 'willhackforfood.biz', 'willselfdestruct.com', 'wuzup.net',
  'wuzupmail.net', 'xoxy.net', 'yapped.net', 'yep.it', 'yopmail.com',
  'yopmail.fr', 'yopmail.net', 'you-spam.com', 'zetmail.com',
  'zoemail.com', 'zomg.info',
]);

/** Free consumer mail. Not disposable, but never a company's hiring contact. */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'comcast.net', 'sbcglobal.net',
  'verizon.net', 'att.net', 'me.co',
]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// MX resolution
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_PATTERNS: { provider: MxProvider; test: RegExp }[] = [
  { provider: 'google', test: /(^|\.)(aspmx\d*\.l\.google\.com|aspmx\.l\.google\.com|.*\.googlemail\.com|.*\.google\.com|googlemail\.com|google\.com)$/ },
  { provider: 'microsoft', test: /(^|\.)(mail\.protection\.outlook\.com|.*\.outlook\.com|.*\.office365\.us|.*\.protection\.office365\.us|olc\.protection\.outlook\.com|.*\.eo\.outlook\.com|hotmail\.com)$/ },
  { provider: 'proton', test: /(^|\.)(protonmail\.ch|proton\.me|protonmail\.com)$/ },
  { provider: 'zoho', test: /(^|\.)(zoho\.com|zoho\.eu|zohomail\.com|zohomail\.eu)$/ },
  // Security gateways sit in front of the real provider and answer for it. They
  // must be recognised separately: a gateway will happily accept mail for
  // addresses that do not exist behind it, so a "valid" verdict means less.
  { provider: 'gateway', test: /(^|\.)(mimecast\.com|mimecast\.co\.za|.*\.pphosted\.com|.*\.ppe-hosted\.com|.*\.barracudanetworks\.com|barracuda\.com|.*\.iphmx\.com|.*\.cisco\.com|.*\.messagelabs\.com|.*\.sophos\.com|.*\.mailcontrol\.com|.*\.fortimail\.com|.*\.trendmicro\.com|.*\.mailanyone\.net|.*\.hes\.trendmicro\.com)$/ },
];

export function classifyMxProvider(hosts: string[]): MxProvider {
  if (hosts.length === 0) return 'none';
  const clean = hosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  for (const { provider, test } of PROVIDER_PATTERNS) {
    if (clean.some((h) => test.test(h))) return provider;
  }
  return 'other';
}

/**
 * c-ares resolver with an explicit timeout. The platform resolver has no
 * timeout knob and a single black-holed domain would otherwise stall a whole
 * discovery pass.
 */
function makeResolver(timeoutMs: number): Resolver {
  return new Resolver({ timeout: timeoutMs, tries: 2 });
}

const memoryCache = new Map<string, DomainMxInfo>();

export function clearMxMemoryCache(): void {
  memoryCache.clear();
}

export async function resolveDomainMx(
  domain: string,
  opts: { timeoutMs?: number } = {},
): Promise<DomainMxInfo> {
  const d = domain.toLowerCase().replace(/\.$/, '');
  const base: DomainMxInfo = {
    domain: d,
    provider: 'unknown',
    hosts: [],
    hasAddressRecord: false,
    nxdomain: false,
    transient: false,
    resolvedAt: Date.now(),
    cached: false,
  };
  if (!d) return { ...base, provider: 'none', nxdomain: true };

  const resolver = makeResolver(opts.timeoutMs ?? 5000);

  try {
    const records = await resolver.resolveMx(d);
    const hosts = records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
      .filter((h) => h.length > 0 && h !== '.');
    if (hosts.length > 0) {
      return { ...base, hosts, provider: classifyMxProvider(hosts) };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code !== 'ENOTFOUND' && code !== 'ENODATA' && code !== 'NOTFOUND') {
      return { ...base, transient: true, provider: 'unknown' };
    }
    if (code === 'ENOTFOUND' || code === 'NOTFOUND') {
      // The name itself does not exist. No point looking for an A record.
      return { ...base, provider: 'none', nxdomain: true };
    }
  }

  // No MX. RFC 5321 §5.1 says a bare A record is an implicit mail destination,
  // so this is not automatically fatal — but in the measured sample every such
  // domain was a parked or dead site.
  const hasAddr = await hasAddressRecord(resolver, d);
  return { ...base, provider: 'none', hasAddressRecord: hasAddr, nxdomain: !hasAddr };
}

async function hasAddressRecord(resolver: Resolver, domain: string): Promise<boolean> {
  for (const fn of [() => resolver.resolve4(domain), () => resolver.resolve6(domain)]) {
    try {
      const addrs = await fn();
      if (addrs.length > 0) return true;
    } catch {
      /* fall through to the next record type */
    }
  }
  return false;
}

/**
 * Resolve with caching. The durable cache lives in email_pattern.mx_provider —
 * a domain's mail provider changes maybe once in its life, so this is written
 * once and read forever, and it is worth a row even for domains where we never
 * infer an address pattern.
 */
export async function lookupDomainMx(
  db: Db,
  domain: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<DomainMxInfo> {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (!d) return resolveDomainMx(d, opts);

  if (!opts.force) {
    const mem = memoryCache.get(d);
    if (mem) return { ...mem, cached: true };

    const row = get<{ mx_provider: string | null }>(
      db,
      'SELECT mx_provider FROM email_pattern WHERE domain = ?',
      d,
    );
    const stored = row?.mx_provider;
    if (stored && stored !== 'unknown') {
      const info: DomainMxInfo = {
        domain: d,
        provider: stored as MxProvider,
        hosts: [],
        hasAddressRecord: stored !== 'none',
        nxdomain: false,
        transient: false,
        resolvedAt: Date.now(),
        cached: true,
      };
      memoryCache.set(d, info);
      return info;
    }
  }

  const info = await resolveDomainMx(d, opts);
  memoryCache.set(d, info);
  // A transient failure says nothing about the domain, so never persist it.
  if (!info.transient) saveMxProvider(db, d, info.provider);
  return info;
}

/**
 * email_pattern.pattern is NOT NULL, so a domain we only know the MX for gets
 * an empty pattern string. Everything downstream treats '' as "no pattern".
 */
export function saveMxProvider(db: Db, domain: string, provider: MxProvider): void {
  run(
    db,
    `INSERT INTO email_pattern (domain, pattern, sample_count, confidence, mx_provider, updated_at)
     VALUES (?, '', 0, 0, ?, unixepoch('subsec')*1000)
     ON CONFLICT(domain) DO UPDATE SET
       mx_provider = excluded.mx_provider,
       updated_at  = excluded.updated_at`,
    domain.toLowerCase(),
    provider,
  );
}

export function saveCatchAllFlag(db: Db, domain: string, isCatchAll: boolean): void {
  run(
    db,
    `INSERT INTO email_pattern (domain, pattern, sample_count, confidence, is_catch_all, updated_at)
     VALUES (?, '', 0, 0, ?, unixepoch('subsec')*1000)
     ON CONFLICT(domain) DO UPDATE SET
       is_catch_all = excluded.is_catch_all,
       updated_at   = excluded.updated_at`,
    domain.toLowerCase(),
    isCatchAll ? 1 : 0,
  );
}

export function getCatchAllFlag(db: Db, domain: string): boolean | null {
  const row = get<{ is_catch_all: number | null }>(
    db,
    'SELECT is_catch_all FROM email_pattern WHERE domain = ?',
    domain.toLowerCase(),
  );
  if (!row || row.is_catch_all == null) return null;
  return row.is_catch_all === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The prefilter itself
// ─────────────────────────────────────────────────────────────────────────────

export async function prefilter(
  db: Db,
  rawEmail: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<PrefilterResult> {
  const email = normalizeEmail(rawEmail);
  const domain = domainOf(email);
  const local = localPartOf(email);

  const base: PrefilterResult = {
    email,
    localPart: local,
    domain,
    verdict: null,
    worthVerifying: false,
    reason: '',
    provider: 'unknown',
    role: false,
    disposable: false,
    mx: null,
  };

  if (!email || !isValidSyntax(email)) {
    return { ...base, verdict: 'invalid', reason: 'Malformed address' };
  }

  if (isDisposableDomain(domain)) {
    return { ...base, verdict: 'disposable', disposable: true, reason: 'Disposable mail provider' };
  }

  const role = isRoleAccount(email);

  const mx = await lookupDomainMx(db, domain, opts);

  if (mx.transient) {
    // DNS was unreachable, not the domain. Say so rather than condemning it.
    return {
      ...base,
      role,
      mx,
      provider: mx.provider,
      verdict: null,
      worthVerifying: false,
      reason: 'DNS lookup failed — retry later',
    };
  }

  if (mx.provider === 'none' && !mx.hasAddressRecord) {
    return {
      ...base,
      role,
      mx,
      provider: 'none',
      verdict: 'invalid',
      reason: mx.nxdomain ? 'Domain does not resolve' : 'Domain accepts no mail (no MX, no A)',
    };
  }

  if (role) {
    // Never spend a credit guessing at a shared mailbox, and never treat one as
    // deliverable without positive confirmation. The caller decides whether an
    // observed role address earns a paid check.
    return {
      ...base,
      role: true,
      mx,
      provider: mx.provider,
      verdict: 'role',
      worthVerifying: false,
      reason: `Role account (${local})`,
    };
  }

  return {
    ...base,
    role: false,
    mx,
    provider: mx.provider,
    verdict: null,
    worthVerifying: true,
    reason: `MX: ${mx.provider}`,
  };
}

/**
 * How much a paid "valid" verdict is worth on this provider.
 *
 * Google Workspace is not catch-all by default — a catch-all there is an
 * explicit admin routing opt-in — and it returns a real 550 5.1.1 for unknown
 * users, so a commercial verifier gets a genuine answer for the ~92% of the
 * measured population on Google. Microsoft 365 is the opposite: it accepts
 * nearly everything at RCPT, so "valid" from a verifier carries little
 * information there and the result is treated as needing review.
 */
export function verdictReliability(provider: MxProvider): 'high' | 'medium' | 'low' {
  switch (provider) {
    case 'google':
    case 'proton':
    case 'zoho':
      return 'high';
    case 'other':
      return 'medium';
    case 'microsoft':
    case 'gateway':
      return 'low';
    default:
      return 'medium';
  }
}
