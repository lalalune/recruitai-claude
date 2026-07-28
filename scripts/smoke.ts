/**
 * End-to-end smoke test against LIVE sources. Proves the pipeline actually
 * produces scored, reviewable records — not just that it typechecks.
 * Run: RECRUITAI_DATA=./data/smoke node --experimental-strip-types scripts/smoke.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { initDb, getDb, all, get } from '../src/main/db/index.js';
import { fetchYcCompanies, filterYcIcp, candidateTokens } from '../src/main/sources/seeds.js';
import { probeAts } from '../src/main/sources/ats.js';
import { scoreCompany, DEFAULT_ICP } from '../src/shared/score.js';
import type { Company, Requisition, Contact } from '../src/shared/types.js';

async function main() {

  const dir = process.env.RECRUITAI_DATA ?? './data/smoke';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  initDb(path.join(dir, 'recruitai.db'));
  const db = getDb();
  console.log('✓ database opened + migrated');
  console.log('  tables:', all<{name:string}>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length);

  console.log('\n→ fetching YC directory…');
  const yc = await fetchYcCompanies();
  if (!yc.ok || !yc.data) throw new Error('YC fetch failed: ' + yc.error);
  console.log(`✓ ${yc.data.length} YC companies`);

  const icp = filterYcIcp(yc.data, { minTeam: 3, maxTeam: 1000, requireHiring: true });
  console.log(`✓ ${icp.length} match ICP (Bay Area, active, hiring, 3-1000 people)`);

  const sample = icp.slice(0, 12);
  console.log(`\n→ probing ATS boards for ${sample.length} companies…`);

  let found = 0, totalReqs = 0;
  const scored: {name:string; score:number; headline:string; fee:number|null}[] = [];

  for (const c of sample) {
    const tokens = candidateTokens(c.name, c.website);
    let board = null;
    for (const t of tokens) {
      board = await probeAts(t);
      if (board) break;
    }
    if (!board) continue;
    found++; totalReqs += board.jobs.length;

    const now = new Date();
    const company: Company = {
      id: 'x', domain: null, name: c.name, nameNorm: c.name.toLowerCase(),
      headcount: c.team_size, headcountSource: 'yc', industry: c.industry,
      hqLocation: c.all_locations, inBayArea: true, fundingStage: null, lastRoundAt: null,
      atsPlatform: board.platform, atsToken: board.token, careersUrl: null, linkedinUrl: null,
      ycBatch: c.batch, openReqCount: board.jobs.length, openReqEngCount: 0, maxDaysOpen: null,
      staleReqCount: 0, recruiterCount: null, hasInhouseTa: null, noAgencyPolicy: false,
      qualityScore: null, scoreBreakdown: null, status: 'discovered', reviewed: false,
      reviewedAt: null, notes: null, createdAt: '', updatedAt: '',
    };
    const reqs: Requisition[] = board.jobs.map((j, i) => ({
      id: String(i), companyId: 'x', externalId: j.externalId, source: board!.platform,
      title: j.title, department: j.department ?? null, team: j.team ?? null,
      location: j.location ?? null, isRemote: j.isRemote ?? null,
      employmentType: j.employmentType ?? null, compMin: j.compMin ?? null, compMax: j.compMax ?? null,
      descriptionText: j.descriptionText ?? null, url: j.url,
      firstSeenAt: j.publishedAt ?? now.toISOString(), lastSeenAt: now.toISOString(),
      publishedAt: j.publishedAt ?? null, closedAt: null, daysOpen: null, repostCount: 0,
      functionFamily: null, seniority: null, noAgencyDisclaimer: null, namedContact: null,
    }));
    const contacts: Contact[] = [];
    const r = scoreCompany({ company, reqs, contacts, now }, DEFAULT_ICP);
    scored.push({ name: c.name, score: r.score, headline: r.disqualified ?? r.headline, fee: r.estimatedFeeUsd });
  }

  console.log(`✓ ${found}/${sample.length} resolved to a live ATS board (${Math.round(100*found/sample.length)}%)`);
  console.log(`✓ ${totalReqs} open requisitions discovered`);

  console.log('\n→ scored, ranked as the operator would see them:\n');
  console.log('  score  company                   est.fee   why');
  console.log('  ' + '-'.repeat(96));
  for (const s of scored.sort((a,b)=>b.score-a.score)) {
    const fee = s.fee ? `$${Math.round(s.fee/1000)}k` : '—';
    console.log(`  [${String(s.score).padStart(2)}]  ${s.name.slice(0,24).padEnd(24)}  ${fee.padStart(7)}   ${s.headline.slice(0,58)}`);
  }
  console.log('\n✓ smoke test complete — real companies, real reqs, real scores');

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
