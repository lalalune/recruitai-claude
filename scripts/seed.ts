/**
 * Seed the dev database by running the REAL ingest pipeline against live sources.
 * Exercises the same code paths the Pipeline screen triggers.
 * Run: bun run seed
 */
import path from 'node:path';
import { initDb, getDb, all, get } from '../src/main/db/index.js';
import { ingestYc, ingestAtsSweep } from '../src/main/pipeline/ingest.js';
import { scoreAll } from '../src/main/pipeline/scoring.js';

async function main() {

  const dir = process.env.RECRUITAI_DATA ?? './data';
  initDb(path.join(dir, 'recruitai.db'));
  const db = getDb();

  function ctxFor(key: string) {
    return {
      key,
      log: (level: string, message: string) => console.log(`  [${level}] ${message}`),
      progress: (done: number, total: number) => {
        if (done % 25 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}   `);
      },
      cancelled: () => false,
    } as never;
  }

  console.log('→ ingestYc');
  console.log(' ', (await ingestYc(db, ctxFor('yc'))).message);

  console.log('\n→ ingestAtsSweep (this hits live ATS endpoints, be patient)');
  try {
    console.log('\n ', (await ingestAtsSweep(db, ctxFor('ats_sweep'))).message);
  } catch (err) {
    // A 429 is the host asking us to stop. Keep whatever was collected and move
    // on rather than retrying — the sweep is resumable on the next run.
    console.log(`\n  [warn] sweep halted: ${err instanceof Error ? err.message : err}`);
    console.log('  [warn] scoring what was collected; re-run to resume.');
  }

  console.log('\n→ scoreAll');
  console.log(' ', (await scoreAll(db, ctxFor('scoring'))).message);

  const c = get<{n:number}>(db, 'SELECT count(*) n FROM company')!.n;
  const withAts = get<{n:number}>(db, 'SELECT count(*) n FROM company WHERE ats_token IS NOT NULL')!.n;
  const reqs = get<{n:number}>(db, 'SELECT count(*) n FROM req')!.n;
  const scored = get<{n:number}>(db, 'SELECT count(*) n FROM company WHERE quality_score IS NOT NULL')!.n;
  console.log(`\n✓ companies=${c}  with ATS=${withAts}  reqs=${reqs}  scored=${scored}`);

  console.log('\nTop 12 by quality score:\n');
  for (const r of all<{name:string;quality_score:number;open_req_count:number;score_headline:string}>(
    db, `SELECT name, quality_score, open_req_count, score_headline FROM company
         WHERE quality_score IS NOT NULL AND disqualified IS NULL
         ORDER BY quality_score DESC, open_req_count DESC LIMIT 12`)) {
    console.log(`  [${String(r.quality_score).padStart(2)}] ${r.name.slice(0,26).padEnd(27)} ${(r.score_headline??'').slice(0,62)}`);
  }

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
