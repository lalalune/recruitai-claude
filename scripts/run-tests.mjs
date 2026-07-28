/**
 * Test runner.
 *
 * Source uses NodeNext `.js` specifiers, which Node's type-stripping does not
 * remap to `.ts`. So tests are bundled with esbuild (exactly as the app is)
 * and then executed by node:test. This also means tests exercise the same
 * module graph the packaged app uses, rather than a parallel one.
 */
import { build } from 'esbuild';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const OUT = 'dist/tests';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const entries = [];
for (const dir of ['tests/unit', 'tests/e2e']) {
  let files = [];
  try { files = readdirSync(dir); } catch { continue; }
  for (const f of files) if (f.endsWith('.test.ts')) entries.push(join(dir, f));
}

if (entries.length === 0) {
  console.error('No test files found under tests/unit or tests/e2e.');
  process.exit(1);
}

await build({
  entryPoints: entries,
  outdir: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  loader: { '.sql': 'text' },
  // Electron is only reachable inside the app; tests stub it (see tests/e2e).
  external: ['electron', 'node:test'],
  logLevel: 'error',
  outExtension: { '.js': '.cjs' },
});

const filter = process.argv[2] ? [`--test-name-pattern=${process.argv[2]}`] : [];
// Node 24 treats a positional argument to --test as a glob, not as a directory
// to walk: passing the bare output directory makes it try to *execute* the
// directory and die with MODULE_NOT_FOUND before any test runs.
const child = spawn(
  process.execPath,
  ['--test', ...filter, `${OUT}/**/*.test.cjs`],
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
