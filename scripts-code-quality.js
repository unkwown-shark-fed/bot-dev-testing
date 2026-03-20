#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const TARGET_EXTENSIONS = new Set(['.js', '.json', '.md']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'logs']);
const fixMode = process.argv.includes('--fix');

function walk(dir, result = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(fullPath, result);
      continue;
    }

    if (entry.name.startsWith('.') && !['.env.example', '.gitignore'].includes(entry.name)) continue;

    const ext = path.extname(entry.name);
    if (TARGET_EXTENSIONS.has(ext)) {
      result.push(relativePath);
    }
  }
  return result;
}

function analyzeAndMaybeFixFile(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const original = fs.readFileSync(fullPath, 'utf8');

  const issues = [];
  let output = original;

  if (output.includes('\r\n')) {
    issues.push('contains CRLF line endings');
    if (fixMode) output = output.replace(/\r\n/g, '\n');
  }

  const lines = output.split('\n');
  const longLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/\s+$/.test(line)) {
      issues.push(`line ${i + 1} has trailing whitespace`);
      if (fixMode) {
        lines[i] = line.replace(/\s+$/g, '');
      }
    }

    if (/\t/.test(line)) {
      issues.push(`line ${i + 1} contains tab indentation`);
    }

    if (line.length > 120) {
      longLines.push(i + 1);
    }
  }

  const warnings = [];
  if (longLines.length > 0) {
    warnings.push(`lines longer than 120 chars: ${longLines.slice(0, 10).join(', ')}${longLines.length > 10 ? '…' : ''}`);
  }

  if (fixMode) {
    output = lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
    if (!output.endsWith('\n')) {
      output += '\n';
    }

    if (output !== original) {
      fs.writeFileSync(fullPath, output, 'utf8');
    }
  } else if (!original.endsWith('\n')) {
    issues.push('missing newline at end of file');
  }

  return { issues, warnings };
}

const files = walk(ROOT).sort();
const failures = [];
const warningList = [];

for (const file of files) {
  const result = analyzeAndMaybeFixFile(file);
  if (result.issues.length > 0) {
    failures.push({ file, issues: result.issues });
  }
  if (result.warnings.length > 0) {
    warningList.push({ file, warnings: result.warnings });
  }
}

if (fixMode) {
  console.log(`Quality fix pass completed for ${files.length} files.`);
  process.exit(0);
}

if (warningList.length > 0) {
  console.warn(`Code quality warnings for ${warningList.length} file(s):`);
  for (const warning of warningList) {
    console.warn(`\n- ${warning.file}`);
    for (const item of warning.warnings) {
      console.warn(`  • ${item}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Code quality checks failed for ${failures.length} file(s):`);
  for (const failure of failures) {
    console.error(`\n- ${failure.file}`);
    for (const issue of failure.issues) {
      console.error(`  • ${issue}`);
    }
  }
  process.exit(1);
}

console.log(`All code quality checks passed for ${files.length} files.`);
