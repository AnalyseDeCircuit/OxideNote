/* eslint-disable no-console */
/**
 * generate-third-party-notices.cjs
 *
 * Scans frontend (npm) and backend (cargo) production dependencies,
 * extracts license metadata, and writes a consolidated
 * THIRD_PARTY_NOTICES.md for compliance purposes.
 *
 * Usage:
 *   node scripts/generate-third-party-notices.cjs
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function exec(cmd, opts = {}) {
  return cp.execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 100,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    ...opts,
  });
}

function escPipe(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// ── NPM dependencies ───────────────────────────────────────

function collectNpmNotices() {
  console.log('Scanning npm production dependencies…');
  const raw = exec('pnpm licenses list --json --prod');
  const data = JSON.parse(raw);

  const packages = [];
  for (const [license, items] of Object.entries(data)) {
    for (const item of items) {
      packages.push({
        name: item.name,
        versions: (item.versions || []).join(', '),
        license,
        homepage: item.homepage || '',
      });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

// ── Cargo dependencies ──────────────────────────────────────

function collectCargoNotices() {
  console.log('Scanning Cargo production dependencies…');

  // Use cargo-metadata to enumerate dependencies
  let raw;
  try {
    raw = exec('cargo metadata --format-version 1 --no-deps', {
      cwd: path.join(ROOT, 'src-tauri'),
    });
  } catch {
    console.warn('cargo metadata failed — skipping Rust dependencies.');
    return [];
  }

  const meta = JSON.parse(raw);
  const ourPkgs = new Set(meta.packages.map((p) => p.name));

  // Now get the full dependency tree
  let fullRaw;
  try {
    fullRaw = exec('cargo metadata --format-version 1', {
      cwd: path.join(ROOT, 'src-tauri'),
    });
  } catch {
    console.warn('cargo metadata (full) failed — skipping Rust deps.');
    return [];
  }

  const fullMeta = JSON.parse(fullRaw);
  const packages = [];

  for (const pkg of fullMeta.packages) {
    // Skip our own crate
    if (ourPkgs.has(pkg.name)) continue;

    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || 'Unknown',
      homepage: pkg.homepage || pkg.repository || '',
    });
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

// ── Build output ────────────────────────────────────────────

function main() {
  const generatedAt = new Date().toISOString();
  const npmPkgs = collectNpmNotices();
  const cargoPkgs = collectCargoNotices();

  function buildSummary(pkgs) {
    const counts = new Map();
    for (const p of pkgs) counts.set(p.license, (counts.get(p.license) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([lic, n]) => `- ${lic}: ${n}`)
      .join('\n');
  }

  // ── Frontend (npm) → src/THIRD_PARTY_NOTICES.md ────────────
  let npmOut = '';
  npmOut += '# Third-Party Notices (Frontend)\n\n';
  npmOut += 'This file lists third-party npm packages used by OxideNote and their declared licenses.\n';
  npmOut += `Generated: ${generatedAt}\n\n`;
  npmOut += '## License Summary\n\n';
  npmOut += buildSummary(npmPkgs) + '\n\n';
  npmOut += '## NPM Production Dependencies\n\n';
  npmOut += '| Package | Version(s) | License | Homepage |\n';
  npmOut += '|---|---:|---|---|\n';
  for (const p of npmPkgs) {
    npmOut += `| ${escPipe(p.name)} | ${escPipe(p.versions)} | ${escPipe(p.license)} | ${p.homepage ? escPipe(p.homepage) : ''} |\n`;
  }
  npmOut += '\n## Notes\n\n';
  npmOut += '- Where a dependency offers multiple licenses, OxideNote exercises the most permissive option available.\n';
  npmOut += '- Licenses are taken from package metadata reported by pnpm at generation time.\n';

  const npmPath = path.join(ROOT, 'src', 'THIRD_PARTY_NOTICES.md');
  fs.writeFileSync(npmPath, npmOut);
  console.log(`Wrote ${npmPath} (${npmPkgs.length} packages)`);

  // ── Backend (Cargo) → src-tauri/THIRD_PARTY_NOTICES.md ─────
  if (cargoPkgs.length > 0) {
    let cargoOut = '';
    cargoOut += '# Third-Party Notices (Backend)\n\n';
    cargoOut += 'This file lists third-party Rust crates used by OxideNote and their declared licenses.\n';
    cargoOut += `Generated: ${generatedAt}\n\n`;
    cargoOut += '## License Summary\n\n';
    cargoOut += buildSummary(cargoPkgs) + '\n\n';
    cargoOut += '## Cargo Dependencies\n\n';
    cargoOut += '| Crate | Version | License | Homepage |\n';
    cargoOut += '|---|---:|---|---|\n';
    for (const p of cargoPkgs) {
      cargoOut += `| ${escPipe(p.name)} | ${escPipe(p.version)} | ${escPipe(p.license)} | ${p.homepage ? escPipe(p.homepage) : ''} |\n`;
    }
    cargoOut += '\n## Notes\n\n';
    cargoOut += '- Where a crate offers multiple licenses, OxideNote exercises the most permissive option available.\n';
    cargoOut += '- Licenses are taken from Cargo metadata at generation time.\n';

    const cargoPath = path.join(ROOT, 'src-tauri', 'THIRD_PARTY_NOTICES.md');
    fs.writeFileSync(cargoPath, cargoOut);
    console.log(`Wrote ${cargoPath} (${cargoPkgs.length} crates)`);
  }
}

main();
