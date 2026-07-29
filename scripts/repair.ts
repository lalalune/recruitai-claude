/**
 * One-off repair for databases written before the entity-resolution and
 * ATS-token fixes.
 *
 * Two defects corrupted rows rather than merely producing bad output, so fixing
 * the code does not fix the data:
 *
 *  1. `findCompany` fell back to a name match even when the seed carried a
 *     domain that contradicted the matched row, so several same-named YC
 *     companies fused into one. One row was three different companies; its
 *     batch, industry, headcount and domain are whichever was ingested last.
 *
 *  2. `candidateTokens` used the first DNS label rather than the registrable
 *     one, so `us.memebox.com` probed the ATS token "us" and adopted a
 *     stranger's job board. Those requisitions are another company's.
 *
 * Both are repaired by removing the corrupted identity and letting the fixed
 * resolver rediscover it: YC ingest is idempotent and the ATS sweep re-probes
 * anything whose token is NULL. Nothing here invents data.
 *
 * Run:  bun run repair          (report only)
 *       bun run repair --apply  (make the changes)
 */

import path from 'node:path';
import { initDb, getDb, all, get, run, tx } from '../src/main/db/index.js';

interface Chimera {
  id: string;
  name: string;
  domains: number;
  domain_list: string;
}

const APPLY = process.argv.includes('--apply');
const dir = process.env.RECRUITAI_DATA ?? './data';

async function main() {
  initDb(path.join(dir, 'recruitai.db'));
  const db = getDb();

  console.log(`recruitAI repair — ${APPLY ? 'APPLYING' : 'dry run (pass --apply to make changes)'}`);
  console.log(`database: ${path.join(dir, 'recruitai.db')}\n`);

  // ── 1. Companies fused from several distinct identities ───────────────────
  // A single company legitimately has one domain. More than one *distinct*
  // domain observation means separate companies were collapsed into this row.
  const chimeras = all<Chimera>(
    db,
    `SELECT c.id,
            c.name,
            count(DISTINCT fo.value) AS domains,
            group_concat(DISTINCT fo.value) AS domain_list
       FROM company c
       JOIN field_observation fo
         ON fo.entity = 'company' AND fo.entity_id = c.id
        AND fo.field = 'domain' AND fo.value IS NOT NULL
      GROUP BY c.id
     HAVING domains > 1
      ORDER BY domains DESC, c.name`,
  );

  const withOutreach = new Set(
    all<{ company_id: string }>(
      db,
      `SELECT company_id FROM send UNION SELECT company_id FROM draft`,
    ).map((r) => r.company_id),
  );
  const deletable = chimeras.filter((c) => !withOutreach.has(c.id));
  const skipped = chimeras.filter((c) => withOutreach.has(c.id));

  console.log(`Fused company rows: ${chimeras.length}`);
  for (const c of chimeras) {
    const reqs = get<{ n: number }>(db, 'SELECT count(*) n FROM req WHERE company_id = ?', c.id)?.n ?? 0;
    const contacts = get<{ n: number }>(db, 'SELECT count(*) n FROM contact WHERE company_id = ?', c.id)?.n ?? 0;
    console.log(`  ${c.name.padEnd(22)} ${c.domains} identities [${c.domain_list}]  reqs=${reqs} contacts=${contacts}`);
  }

  // ── 2. ATS tokens taken from a subdomain label ────────────────────────────
  // A token equal to a common subdomain label was never the company's board.
  const SUBDOMAIN_LABELS = ['us', 'www', 'app', 'web', 'go', 'my', 'en', 'eu', 'uk', 'de', 'jp'];
  const placeholders = SUBDOMAIN_LABELS.map(() => '?').join(',');
  const badTokens = all<{ id: string; name: string; website: string; ats_platform: string; ats_token: string }>(
    db,
    `SELECT id, name, website, ats_platform, ats_token FROM company
      WHERE ats_token IN (${placeholders})`,
    ...SUBDOMAIN_LABELS,
  );

  console.log(`\nCompanies bound to a subdomain-label ATS token: ${badTokens.length}`);
  for (const b of badTokens) {
    const reqs = get<{ n: number }>(db, 'SELECT count(*) n FROM req WHERE company_id = ?', b.id)?.n ?? 0;
    console.log(`  ${b.name.padEnd(22)} ${b.website} → ${b.ats_platform}/${b.ats_token}  (${reqs} foreign reqs)`);
  }

  if (!APPLY) {
    console.log('\nNothing changed. Re-run with --apply, then `bun run seed` to rediscover.');
    return;
  }

  const removedReqs = { fused: 0, foreign: 0 };

  tx(db, () => {
    for (const c of deletable) {
      removedReqs.fused += get<{ n: number }>(db, 'SELECT count(*) n FROM req WHERE company_id = ?', c.id)?.n ?? 0;
      // ON DELETE CASCADE carries reqs, contacts and req_daily. The
      // observations are deliberately removed too: they are the evidence of a
      // merge that should never have happened, and leaving them would let the
      // resolver re-fuse the row on the next pass.
      // field_resolved.obs_id references field_observation(id), so the winners
      // have to go before the observations they point at.
      run(db, `DELETE FROM field_resolved WHERE entity = 'company' AND entity_id = ?`, c.id);
      run(db, `DELETE FROM field_observation WHERE entity = 'company' AND entity_id = ?`, c.id);
      // Contacts carry their own observations keyed by contact id.
      run(
        db,
        `DELETE FROM field_resolved WHERE entity = 'contact'
          AND entity_id IN (SELECT id FROM contact WHERE company_id = ?)`,
        c.id,
      );
      run(
        db,
        `DELETE FROM field_observation WHERE entity = 'contact'
          AND entity_id IN (SELECT id FROM contact WHERE company_id = ?)`,
        c.id,
      );
      run(
        db,
        `DELETE FROM field_resolved WHERE entity = 'req'
          AND entity_id IN (SELECT CAST(id AS TEXT) FROM req WHERE company_id = ?)`,
        c.id,
      );
      run(
        db,
        `DELETE FROM field_observation WHERE entity = 'req'
          AND entity_id IN (SELECT CAST(id AS TEXT) FROM req WHERE company_id = ?)`,
        c.id,
      );
      // A row merged into this one would be left dangling by the delete.
      run(db, 'UPDATE company SET canonical_id = NULL WHERE canonical_id = ?', c.id);
      run(db, 'DELETE FROM company WHERE id = ?', c.id);
    }

    for (const b of badTokens) {
      // The company itself is real; only its board binding and the requisitions
      // that came from it are another company's. Clearing the token makes the
      // next sweep re-probe with the corrected token derivation.
      removedReqs.foreign += get<{ n: number }>(db, 'SELECT count(*) n FROM req WHERE company_id = ?', b.id)?.n ?? 0;
      run(db, 'DELETE FROM req WHERE company_id = ?', b.id);
      run(
        db,
        `UPDATE company
            SET ats_platform = NULL, ats_token = NULL, careers_url = NULL,
                open_req_count = 0, open_req_eng_count = 0, stale_req_count = 0,
                max_days_open = NULL, estimated_fee_usd = NULL,
                quality_score = NULL, score_raw = NULL, score_headline = NULL,
                updated_at = ?
          WHERE id = ?`,
        Date.now(),
        b.id,
      );
      run(
        db,
        `DELETE FROM field_resolved
          WHERE entity = 'company' AND entity_id = ? AND field IN ('atsPlatform','atsToken','careersUrl')`,
        b.id,
      );
      run(
        db,
        `DELETE FROM field_observation
          WHERE entity = 'company' AND entity_id = ? AND field IN ('atsPlatform','atsToken','careersUrl')`,
        b.id,
      );
    }
  });

  if (skipped.length) {
    console.log(
      `\nSkipped ${skipped.length} fused row(s) that already have outreach history — ` +
        `deleting them would destroy the record of who was emailed. Resolve by hand: ` +
        skipped.map((c) => c.name).join(', '),
    );
  }
  console.log(`\nRemoved ${deletable.length} fused company rows (${removedReqs.fused} requisitions).`);
  console.log(`Cleared ${badTokens.length} wrong ATS binding(s) (${removedReqs.foreign} foreign requisitions).`);
  console.log('\nNow run `bun run seed` — YC ingest and the ATS sweep will rediscover these correctly.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
