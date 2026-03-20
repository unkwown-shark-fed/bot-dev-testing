#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'logs', 'exports']);

function walk(dir, result = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), result);
      continue;
    }

    if (!entry.name.endsWith('.js')) continue;
    result.push(path.join(dir, entry.name));
  }
  return result;
}

const files = walk(ROOT);
let hasFailure = false;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
  try {
    new Function(source);
  } catch (error) {
    hasFailure = true;
    console.error(`Syntax error in ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

if (hasFailure) {
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} file(s).`);
