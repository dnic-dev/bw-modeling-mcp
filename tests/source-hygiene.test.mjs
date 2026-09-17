import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Control characters must never reach the sources.
 *
 * They get there when a regex is written through a scripted edit and an escape layer
 * turns `\b` into the byte 0x08 rather than leaving the two characters that mean a
 * word boundary. The result is a regex that can never match, and nothing shows it:
 * the editor renders nothing, `git diff` renders nothing, the build succeeds, and the
 * code just quietly stops doing its job. It has happened twice in this repository —
 * once in a member rename, once in an id lookup — and cost hours both times.
 *
 * The check compares code points rather than using a regex with escape sequences, so
 * that this file cannot fall into the very trap it guards against.
 * Tab (9), LF (10) and CR (13) are legitimate in source text.
 */
const ALLOWED = new Set([9, 10, 13]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(path);
  }
  return out;
}

test('no source file contains a control character', () => {
  const offenders = [];

  for (const file of [...sourceFiles('src'), ...sourceFiles('tests')]) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, row) => {
      for (let col = 0; col < line.length; col++) {
        const code = line.charCodeAt(col);
        if (code < 32 && !ALLOWED.has(code)) {
          const hex = code.toString(16).toUpperCase().padStart(4, '0');
          offenders.push(`${file}:${row + 1}:${col + 1} contains U+${hex}`);
        }
      }
    });
  }

  assert.deepEqual(offenders, [], `control characters found:\n${offenders.join('\n')}`);
});
