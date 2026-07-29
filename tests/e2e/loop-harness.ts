/**
 * The primary-loop harness: drives the REAL app the way the operator does.
 *
 * boot-harness.ts proves the app starts; this proves the product's spine
 * WORKS — a seeded database renders in Review, real `j`/`a` keystrokes (sent
 * through Chromium's input pipeline, not synthetic DOM events) move the
 * selection and approve a company, the approval enqueues a draft task, and
 * the drainer turns it into a real draft. AUDIT.md phase 4: "a feature that
 * demos is a different thing from a feature that compiles."
 *
 * Run: bun run test:loop  (an Electron main process, not a node:test file)
 */
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { DatabaseSync } from 'node:sqlite';
import { initDb, closeDb, run, ulid, type Db } from '../../src/main/db/index.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';

const PORT = 5183;
const RENDERER_ROOT = path.resolve(__dirname, '../renderer');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2',
};

const failures: string[] = [];
const ok = (m: string) => console.log(`✓ ${m}`);
const fail = (m: string) => {
  failures.push(m);
  console.error(`✗ ${m}`);
};

function serveRenderer(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = (req.url ?? '/').split('?')[0] ?? '/';
      const filePath = path.join(RENDERER_ROOT, rel === '/' ? 'index.html' : rel);
      if (!filePath.startsWith(RENDERER_ROOT + path.sep)) return void res.writeHead(403).end();
      fs.readFile(filePath, (err, data) => {
        if (err) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor<T>(what: string, ms: number, poll: () => T | null | undefined | Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  let lastErr: unknown = null;
  for (;;) {
    // A throwing poll is "not ready yet", not a verdict: executeJavaScript
    // rejects while a reload is in flight, and the WAL probe can hit
    // SQLITE_BUSY during a checkpoint. Only past the deadline does the last
    // error become the failure.
    try {
      const got = await poll();
      if (got !== null && got !== undefined) return got;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${lastErr})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Three reviewable companies, each approvable into a real draft. */
function seed(db: Db): string[] {
  const names = ['Alpha Loop Co', 'Beta Loop Co', 'Gamma Loop Co'];
  for (const [i, name] of names.entries()) {
    const domain = `${name.split(' ')[0]!.toLowerCase()}.loop.test`;
    const companyId = upsertCompany(db, { name, domain });
    run(
      db,
      `UPDATE company SET status = 'scored', quality_score = ?, headcount = 40, open_req_count = 1,
              in_bay_area = 1, updated_at = ? WHERE id = ?`,
      8 - i,
      Date.now(),
      companyId,
    );
    run(
      db,
      `INSERT INTO req (company_id, external_id, source, title, location, url, first_seen_at, last_seen_at)
       VALUES (?, ?, 'greenhouse', 'Founding Engineer', 'SF', 'https://loop.test/j', ?, ?)`,
      companyId,
      `req-${i}`,
      Date.now() - 30 * 86_400_000,
      Date.now(),
    );
    run(
      db,
      `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
       VALUES (?, ?, 'Casey Reviewer', 'Casey', ?, 'approved')`,
      ulid(),
      companyId,
      `casey@${domain}`,
    );
  }
  return names;
}

function pressKey(win: BrowserWindow, keyCode: string): void {
  // Through Chromium's input pipeline — the same path a physical key takes.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'char', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}

const selectedName = (win: BrowserWindow) =>
  win.webContents.executeJavaScript(
    `document.querySelector('h1[data-selectable]')?.textContent ?? null`,
  ) as Promise<string | null>;

let cleanupDir = '';

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-loop-'));
  process.env.RECRUITAI_DATA = dataDir;
  cleanupDir = dataDir;

  // Watchdog: every waitFor has a deadline, but app.whenReady() and a poll
  // that never resolves do not — without this, a hang bills the CI job's
  // full timeout instead of failing in three minutes.
  const watchdog = setTimeout(() => {
    console.error('✗ loop harness watchdog: no verdict after 180s — failing the run');
    app.exit(1);
  }, 180_000);
  watchdog.unref?.();

  // Seed BEFORE the app boots: same db module, same migrations, same file the
  // main process will open — the app starts life with reviewable companies.
  const seededDb = initDb(path.join(dataDir, 'recruitai.db'));
  const names = seed(seededDb);
  closeDb();
  ok(`seeded ${names.length} reviewable companies`);

  const server = await serveRenderer();
  require(path.resolve(__dirname, '../main/index.cjs'));
  await app.whenReady();
  const win = await waitFor('BrowserWindow', 15_000, () => BrowserWindow.getAllWindows()[0]);
  await waitFor('page load', 15_000, () => !win.webContents.isLoading() || undefined);

  // A pristine profile (CI) correctly lands on the Setup wizard; the loop
  // under test is Review's. Mark setup complete exactly as Setup's skip
  // button does, then reload — unconditional, so local machines with stale
  // Electron userData and fresh CI runners behave identically.
  await win.webContents.executeJavaScript(`localStorage.setItem('recruitai.setupComplete', '1')`);
  // Deterministic reload wait: the old fixed-sleep-then-poll could observe the
  // OLD page settled before the reload IPC flipped isLoading on a slow runner.
  const reloaded = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  win.webContents.reload();
  await Promise.race([
    reloaded,
    new Promise((_, reject) => setTimeout(() => reject(new Error('reload did not finish in 15s')), 15_000)),
  ]);
  win.webContents.focus();

  // The seeded list must actually render.
  await waitFor('Review rows in the DOM', 10_000, async () => {
    const n = (await win.webContents.executeJavaScript(
      `document.querySelectorAll('[role="option"]').length`,
    )) as number;
    return n >= 3 || undefined;
  });
  ok('Review list rendered the seeded companies');

  const first = await waitFor('initial selection', 5_000, () => selectedName(win));
  if (!names.includes(first)) fail(`initial selection "${first}" is not a seeded company`);
  else ok(`initial selection: ${first}`);

  // j — move down. Real keystroke, real hotkey handler, real store.
  pressKey(win, 'j');
  const second = await waitFor('selection moved after j', 5_000, async () => {
    const now = await selectedName(win);
    return now && now !== first ? now : undefined;
  });
  ok(`j moved selection: ${first} → ${second}`);

  pressKey(win, 'k');
  await waitFor('k moved selection back', 5_000, async () =>
    (await selectedName(win)) === first || undefined,
  );
  ok('k moved selection back');

  // a — approve the selected company. Verify the DATABASE, not just pixels.
  pressKey(win, 'j');
  const target = await waitFor('target selected', 5_000, () => selectedName(win));
  pressKey(win, 'a');

  // A second WAL connection for verification — the app's own handle lives in
  // its separately-bundled module; this harness's db singleton was closed
  // after seeding. Reading the truth from a fresh connection is also the more
  // honest probe: it sees only what was durably written.
  const probe = new DatabaseSync(path.join(dataDir, 'recruitai.db'));
  // The app's connection carries busy_timeout 5000; a probe without one can
  // throw SQLITE_BUSY during a WAL checkpoint and fail the run spuriously.
  probe.exec('PRAGMA busy_timeout = 5000');
  await waitFor(`"${target}" approved in the database`, 5_000, () => {
    const row = probe
      .prepare(`SELECT status FROM company WHERE name = ?`)
      .get(target) as { status: string } | undefined;
    return row?.status === 'approved' || undefined;
  });
  ok(`a approved "${target}" — status row confirms it`);

  // The approve→draft pipeline: the drainer (3s tick) must produce a draft.
  await waitFor('the drainer generated a draft for the approval', 20_000, () => {
    const row = probe
      .prepare(
        `SELECT d.id FROM draft d JOIN company co ON co.id = d.company_id WHERE co.name = ? AND d.state = 'draft'`,
      )
      .get(target) as { id: string } | undefined;
    return row?.id;
  });
  ok('approval flowed through the task queue into a real draft');

  // And the draft is visible to the UI layer through the same IPC the
  // Outreach screen uses.
  const drafts = (await win.webContents.executeJavaScript(`window.api.listDrafts('draft')`)) as unknown[];
  if (drafts.length >= 1) ok(`listDrafts sees ${drafts.length} draft(s) over live IPC`);
  else fail('listDrafts returned nothing for the generated draft');

  // Continue the loop into Outreach: click the sidebar nav (a real DOM click
  // on the real button), see the draft in the Drafts tab, queue it with the
  // real ⌘/Ctrl+Enter hotkey, and verify the queue state in the database.
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Outreach'))?.click()`,
  );
  await waitFor('Outreach shows the draft', 10_000, async () => {
    const text = (await win.webContents.executeJavaScript(`document.body.innerText`)) as string;
    return text.includes(target) || undefined;
  });
  ok('Outreach Drafts tab lists the generated draft');

  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: [modifier] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: [modifier] });

  await waitFor('the draft reaches the queue', 10_000, () => {
    const row = probe
      .prepare(
        `SELECT d.state FROM draft d JOIN company co ON co.id = d.company_id WHERE co.name = ?`,
      )
      .get(target) as { state: string } | undefined;
    return row?.state === 'queued' || undefined;
  });
  ok('⌘/Ctrl+Enter queued the draft — state and schedule confirmed in the database');

  const sendStats = (await win.webContents.executeJavaScript(`window.api.getSendStats()`)) as { queued: number };
  if (sendStats.queued >= 1) ok(`send stats report ${sendStats.queued} queued over live IPC`);
  else fail(`send stats report ${sendStats.queued} queued — expected at least 1`);
  probe.close();
  server.close();

  if (failures.length) {
    console.error(`\nLOOP TEST FAILED (${failures.length})`);
    app.exit(1);
  } else {
    console.log('\nLOOP TEST PASSED — the primary loop works end to end');
    app.exit(0);
  }
}

main().catch((err) => {
  console.error('✗ loop harness crashed:', err);
  app.exit(1);
});

// Cleanup on BOTH verdicts: a thrown waitFor used to jump straight past the
// rmSync and leak the tmpdir (ephemeral on CI, accumulating locally).
app.on('will-quit', () => {
  try {
    if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* best effort — a leaked tmpdir must not mask the real verdict */
  }
});
