#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * project-stats.cjs — cloc-style code statistics for OxideNote.
 *
 * Walks the project tree, counts lines (code / comment / blank)
 * per language, and prints a formatted report.
 *
 * Usage:
 *   node scripts/project-stats.cjs [--json] [--by-dir] [--include-hidden]
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const includeHidden = args.has('--include-hidden');
const byDir = args.has('--by-dir');

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.turbo',
  '.next',
  '.cache',
  'out',
  'coverage',
  'vendor',
  'gen',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.yml', '.yaml', '.toml',
  '.css', '.scss', '.less', '.html', '.htm',
  '.rs', '.go', '.py', '.sh', '.sql',
  '.typ', '.tex', '.bib',
]);

// Language groupings
const LANG_MAP = {
  TypeScript: ['.ts', '.tsx'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  Rust:       ['.rs'],
  CSS:        ['.css', '.scss', '.less'],
  JSON:       ['.json'],
  Markdown:   ['.md'],
  TOML:       ['.toml'],
  HTML:       ['.html', '.htm'],
  Typst:      ['.typ'],
  LaTeX:      ['.tex', '.bib'],
  Other:      [],
};

function shouldSkipDir(name) {
  if (!includeHidden && name.startsWith('.')) return true;
  return EXCLUDE_DIRS.has(name);
}

function isSingleLineComment(line, ext) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (ext === '.rs' && trimmed.startsWith('//')) return true;
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext) && trimmed.startsWith('//')) return true;
  if (['.py', '.sh', '.toml', '.yml', '.yaml'].includes(ext) && trimmed.startsWith('#')) return true;
  if (['.tex', '.typ', '.bib'].includes(ext) && trimmed.startsWith('//')) return true;
  if (ext === '.css' && trimmed.startsWith('/*') && trimmed.endsWith('*/')) return true;
  return false;
}

function countCodeLines(buffer, ext) {
  const text = buffer.toString('utf-8');
  const lines = text.split(/\r?\n/);
  let code = 0, comment = 0, blank = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) blank++;
    else if (isSingleLineComment(line, ext)) comment++;
    else code++;
  }
  return { total: lines.length, code, comment, blank };
}

function getLangGroup(ext) {
  for (const [lang, exts] of Object.entries(LANG_MAP)) {
    if (exts.includes(ext)) return lang;
  }
  return 'Other';
}

const stats = {
  files: 0,
  textFiles: 0,
  totalBytes: 0,
  totalLines: { total: 0, code: 0, comment: 0, blank: 0 },
  byExtension: {},
  byDir: {},
};

function walk(dir, currentDir = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      const nextDir = currentDir ? `${currentDir}/${entry.name}` : entry.name;
      walk(path.join(dir, entry.name), nextDir);
      continue;
    }
    if (!entry.isFile()) continue;

    const fullPath = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    const stat = fs.statSync(fullPath);

    stats.files++;
    stats.totalBytes += stat.size;

    if (!stats.byDir[currentDir]) {
      stats.byDir[currentDir] = { files: 0, bytes: 0, lines: 0 };
    }
    stats.byDir[currentDir].files++;

    if (!TEXT_EXTENSIONS.has(ext)) continue;

    const fd = fs.openSync(fullPath, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, 10 * 1024 * 1024));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    const content = buffer.slice(0, bytesRead);
    const lines = countCodeLines(content, ext);

    stats.textFiles++;
    stats.totalLines.total += lines.total;
    stats.totalLines.code += lines.code;
    stats.totalLines.comment += lines.comment;
    stats.totalLines.blank += lines.blank;

    stats.byDir[currentDir].lines += lines.total;
    stats.byDir[currentDir].bytes += stat.size;

    if (!stats.byExtension[ext]) {
      stats.byExtension[ext] = {
        files: 0, bytes: 0,
        lines: { total: 0, code: 0, comment: 0, blank: 0 },
        lang: getLangGroup(ext),
      };
    }
    const extStat = stats.byExtension[ext];
    extStat.files++;
    extStat.bytes += stat.size;
    extStat.lines.total += lines.total;
    extStat.lines.code += lines.code;
    extStat.lines.comment += lines.comment;
    extStat.lines.blank += lines.blank;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function printReport() {
  // Aggregate by language
  const langStats = {};
  for (const [, data] of Object.entries(stats.byExtension)) {
    const lang = data.lang;
    if (!langStats[lang]) langStats[lang] = { files: 0, blank: 0, comment: 0, code: 0 };
    langStats[lang].files += data.files;
    langStats[lang].blank += data.lines.blank;
    langStats[lang].comment += data.lines.comment;
    langStats[lang].code += data.lines.code;
  }

  const sortedLangs = Object.entries(langStats)
    .filter(([, d]) => d.files > 0)
    .sort((a, b) => b[1].code - a[1].code);

  const total = { files: 0, blank: 0, comment: 0, code: 0 };
  for (const [, d] of sortedLangs) {
    total.files += d.files;
    total.blank += d.blank;
    total.comment += d.comment;
    total.code += d.code;
  }

  console.log('\n' + '='.repeat(70));
  console.log(' OxideNote Code Statistics');
  console.log('='.repeat(70));
  console.log(`\nLocation: ${ROOT}\n`);

  // Language table
  console.log(
    'Language'.padEnd(14) +
    'files'.padStart(8) +
    'blank'.padStart(10) +
    'comment'.padStart(10) +
    'code'.padStart(12)
  );
  console.log('-'.repeat(54));
  for (const [lang, d] of sortedLangs) {
    console.log(
      lang.padEnd(14) +
      String(d.files).padStart(8) +
      d.blank.toLocaleString().padStart(10) +
      d.comment.toLocaleString().padStart(10) +
      d.code.toLocaleString().padStart(12)
    );
  }
  console.log('-'.repeat(54));
  console.log(
    'TOTAL'.padEnd(14) +
    String(total.files).padStart(8) +
    total.blank.toLocaleString().padStart(10) +
    total.comment.toLocaleString().padStart(10) +
    total.code.toLocaleString().padStart(12)
  );

  // Extension detail
  console.log('\n' + '='.repeat(70));
  console.log(' Extension Detail (sorted by code lines)');
  console.log('='.repeat(70));
  console.log(
    'Extension'.padEnd(12) +
    'files'.padStart(8) +
    'blank'.padStart(10) +
    'comment'.padStart(10) +
    'code'.padStart(12) +
    'size'.padStart(10)
  );
  console.log('-'.repeat(62));

  const sortedExts = Object.entries(stats.byExtension)
    .sort((a, b) => b[1].lines.code - a[1].lines.code);

  for (const [ext, d] of sortedExts) {
    console.log(
      (ext || '<none>').padEnd(12) +
      String(d.files).padStart(8) +
      d.lines.blank.toLocaleString().padStart(10) +
      d.lines.comment.toLocaleString().padStart(10) +
      d.lines.code.toLocaleString().padStart(12) +
      formatBytes(d.bytes).padStart(10)
    );
  }

  // Composition
  const totalLines = total.blank + total.comment + total.code;
  if (totalLines > 0) {
    console.log('\n' + '='.repeat(70));
    console.log(' Code Composition');
    console.log('='.repeat(70));
    console.log(`Total lines:  ${totalLines.toLocaleString().padStart(10)}`);
    console.log(`  Blank:      ${((total.blank / totalLines) * 100).toFixed(1)}%  (${total.blank.toLocaleString()})`);
    console.log(`  Comment:    ${((total.comment / totalLines) * 100).toFixed(1)}%  (${total.comment.toLocaleString()})`);
    console.log(`  Code:       ${((total.code / totalLines) * 100).toFixed(1)}%  (${total.code.toLocaleString()})`);
  }

  // By directory
  if (byDir) {
    console.log('\n' + '='.repeat(70));
    console.log(' Top Directories (by line count)');
    console.log('='.repeat(70));
    console.log(
      'Directory'.padEnd(40) + 'files'.padStart(8) + 'lines'.padStart(12) + 'size'.padStart(12)
    );
    console.log('-'.repeat(72));

    const sortedDirs = Object.entries(stats.byDir)
      .sort((a, b) => (b[1].lines || 0) - (a[1].lines || 0))
      .slice(0, 15);

    for (const [dir, d] of sortedDirs) {
      console.log(
        (dir || '.').slice(0, 40).padEnd(40) +
        String(d.files).padStart(8) +
        (d.lines || 0).toLocaleString().padStart(12) +
        formatBytes(d.bytes).padStart(12)
      );
    }
  }

  console.log('\n' + '='.repeat(70));
}

// Execute
const startTime = Date.now();
walk(ROOT);
const duration = Date.now() - startTime;

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, scanTime: `${duration}ms`, ...stats }, null, 2));
} else {
  printReport();
  console.log(`\nScan time: ${duration}ms\n`);
}
