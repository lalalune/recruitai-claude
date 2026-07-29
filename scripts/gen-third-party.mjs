/**
 * Generates THIRD-PARTY-LICENSES.md from the installed dependency tree.
 *
 * Apache-2.0 §4(a) requires giving recipients a copy of the License for
 * bundled Apache-2.0 work, and §4(d) requires propagating any NOTICE file.
 * esbuild inlines dependencies into dist/main/index.cjs and Vite inlines them
 * into the renderer bundle, so those obligations attach to our binaries — this
 * file is how they are met.
 *
 * Run: bun run licenses
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'node_modules';
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'license', 'License'];
const NOTICE_FILES = ['NOTICE', 'NOTICE.md', 'NOTICE.txt'];

function findFile(dir, names) {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Walk node_modules including one level of @scope directories. */
function packageDirs(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    if (entry === '.bin' || entry === '.cache') continue;
    const p = join(root, entry);
    if (!statSync(p).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(p)) out.push(join(p, sub));
    } else {
      out.push(p);
    }
  }
  return out;
}

const pkgs = [];
const platformGated = [];
for (const dir of packageDirs(ROOT)) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) continue;
  let m;
  try { m = JSON.parse(readFileSync(manifest, 'utf8')); } catch { continue; }
  if (!m.name) continue;

  // Platform-gated packages differ between a macOS dev machine and a Linux CI
  // runner, which would make this file non-deterministic and fail the staleness
  // check on every release. They are also native build tooling (esbuild,
  // lightningcss, rolldown, tailwind oxide, fsevents) that runs at build time
  // and is never bundled into the shipped app — the main process is one esbuild
  // bundle and the renderer is a Vite bundle, so neither carries a .node binary.
  // Excluding them keeps the file both reproducible and accurate about what we
  // actually distribute.
  if (m.os || m.cpu) {
    platformGated.push(`${m.name}@${m.version ?? ''}`);
    continue;
  }

  const license =
    typeof m.license === 'string' ? m.license
    : m.license?.type ? m.license.type
    : Array.isArray(m.licenses) ? m.licenses.map((l) => l.type ?? l).join(' OR ')
    : 'UNKNOWN';

  const licPath = findFile(dir, LICENSE_FILES);
  const notPath = findFile(dir, NOTICE_FILES);
  pkgs.push({
    name: m.name,
    version: m.version ?? '',
    license,
    repository: typeof m.repository === 'string' ? m.repository : (m.repository?.url ?? ''),
    licenseText: licPath ? readFileSync(licPath, 'utf8').trim() : null,
    noticeText: notPath ? readFileSync(notPath, 'utf8').trim() : null,
  });
}

pkgs.sort((a, b) => a.name.localeCompare(b.name));

const byLicense = new Map();
for (const p of pkgs) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1);

// Anything copyleft here would contaminate an Apache-2.0 distribution.
const COPYLEFT = /^(GPL|AGPL|LGPL|SSPL|BUSL|EUPL|CDDL|EPL)/i;
const flagged = pkgs.filter((p) => COPYLEFT.test(p.license) || p.license === 'UNKNOWN');

const apache = pkgs.filter((p) => p.license.includes('Apache'));
const withNotice = pkgs.filter((p) => p.noticeText);

const lines = [];
lines.push('# Third-party licenses');
lines.push('');
lines.push('recruitAI is distributed under the Apache License 2.0. It bundles the packages');
lines.push('below into its application binaries. Their licenses are reproduced here in full,');
lines.push('and any NOTICE files they ship are propagated verbatim, as Apache-2.0 §4(a) and');
lines.push('§4(d) require.');
lines.push('');
lines.push(`Generated from the installed dependency tree by \`bun run licenses\`. ${pkgs.length} packages.`);
lines.push('');
lines.push(
  'Packages that declare an `os` or `cpu` constraint are omitted: they are native build ' +
  'tooling that differs per platform and is never bundled into the shipped application ' +
  '(the main process is a single esbuild bundle, the renderer a Vite bundle, and neither ' +
  'carries a native addon). Omitting them also keeps this file reproducible across ' +
  'developer machines and CI.',
);
lines.push('');
lines.push('## Summary');
lines.push('');
lines.push('| License | Packages |');
lines.push('|---|---|');
for (const [lic, n] of [...byLicense.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${lic} | ${n} |`);
}
lines.push('');
if (flagged.length) {
  lines.push('> **Review required.** The following are copyleft or have no declared license:');
  for (const p of flagged) lines.push(`> - ${p.name}@${p.version} — ${p.license}`);
} else {
  lines.push('No GPL, AGPL, LGPL, SSPL, BUSL, EUPL, CDDL or EPL dependency is present, and every');
  lines.push('package declares a license. All are permissive and compatible with Apache-2.0.');
}
lines.push('');

if (withNotice.length) {
  lines.push('## Propagated NOTICE files');
  lines.push('');
  lines.push('Apache-2.0 §4(d) requires these to travel with any distribution that includes the work.');
  lines.push('');
  for (const p of withNotice) {
    lines.push(`### ${p.name}@${p.version}`);
    lines.push('');
    lines.push('```');
    lines.push(p.noticeText);
    lines.push('```');
    lines.push('');
  }
} else {
  lines.push('## Propagated NOTICE files');
  lines.push('');
  lines.push(`None of the ${apache.length} Apache-2.0 dependencies ships a NOTICE file, so §4(d) adds nothing beyond the license texts below.`);
  lines.push('');
}

lines.push('## Packages');
lines.push('');
for (const p of pkgs) {
  lines.push(`### ${p.name}@${p.version} — ${p.license}`);
  if (p.repository) lines.push(`${p.repository.replace(/^git\+/, '').replace(/\.git$/, '')}`);
  lines.push('');
  if (p.licenseText) {
    lines.push('<details><summary>License text</summary>');
    lines.push('');
    lines.push('```');
    lines.push(p.licenseText);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
  } else {
    lines.push(`_No license file shipped in the package; declared as ${p.license} in its manifest._`);
  }
  lines.push('');
}

writeFileSync('THIRD-PARTY-LICENSES.md', lines.join('\n'));
console.log(
  `THIRD-PARTY-LICENSES.md: ${pkgs.length} packages, ${apache.length} Apache-2.0, ` +
  `${withNotice.length} with NOTICE, ${platformGated.length} platform-gated omitted`,
);
if (flagged.length) {
  console.error(`COPYLEFT/UNKNOWN: ${flagged.map((p) => `${p.name}(${p.license})`).join(', ')}`);
  process.exit(1);
}
