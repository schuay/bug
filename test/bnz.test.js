import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractSearchHits, findTestcaseKeyInMarkdown, parseArgs, sanitizeFilename,
} from '../bnz.js';
import { sanitizeDeep, sanitizeTerminalText } from '../lib/render.js';

test('parseArgs picks up flags and positional targets', () => {
  const a = parseArgs(['1', '2', '--format=json', '--refresh']);
  assert.deepEqual(a._, ['1', '2']);
  assert.equal(a.format, 'json');
  assert.equal(a.refresh, true);
  assert.equal(a.useCache, true);

  const b = parseArgs(['cf', '5009280990216192', '--download-original', '--no-cache']);
  assert.deepEqual(b._, ['cf', '5009280990216192']);
  assert.equal(b.downloadOriginal, true);
  assert.equal(b.useCache, false);

  const c = parseArgs(['1', '--download-attachments']);
  assert.equal(c.downloadAttachments, '.');
  const d = parseArgs(['1', '--download-attachments=/tmp/foo']);
  assert.equal(d.downloadAttachments, '/tmp/foo');
});

test('parseArgs rejects unknown formats', () => {
  assert.throws(() => parseArgs(['1', '--format=html']), /Unknown --format/);
});

test('findTestcaseKeyInMarkdown picks up both URL shapes', () => {
  assert.equal(
    findTestcaseKeyInMarkdown('See https://clusterfuzz.com/testcase?key=5009280990216192 for details.'),
    '5009280990216192',
  );
  assert.equal(
    findTestcaseKeyInMarkdown('Repro: https://clusterfuzz.com/download?testcase_id=4242 .'),
    '4242',
  );
  assert.equal(findTestcaseKeyInMarkdown('no links here'), null);
});

test('extractSearchHits dedupes by id, keeping first title', () => {
  const md = `
- [crash on startup](https://issuetracker.google.com/issues/123) status: New
- [crash on startup (linked)](https://issuetracker.google.com/issues/123) Status: Assigned
- [another bug](https://issuetracker.google.com/issues/456?pli=1) status: New
`;
  const hits = extractSearchHits(md);
  assert.deepEqual(hits, [
    { id: '123', title: 'crash on startup', url: 'https://issuetracker.google.com/issues/123' },
    { id: '456', title: 'another bug', url: 'https://issuetracker.google.com/issues/456' },
  ]);
});

test('sanitizeFilename strips control + path chars', () => {
  assert.equal(sanitizeFilename('foo/bar:baz<qux>.txt'), 'foo_bar_baz_qux_.txt');
  assert.equal(sanitizeFilename('  spaced out  '), 'spaced out');
  assert.equal(sanitizeFilename('a'.repeat(300)).length, 200);
});

test('sanitizeTerminalText strips ANSI + control', () => {
  const dirty = 'safe\x1b[31mred\x1b[0m\x1b]0;title\x07done\x08';
  assert.equal(sanitizeTerminalText(dirty), 'safereddone');
});

test('sanitizeDeep recurses', () => {
  const dirty = { a: 'foo\x1b[31mbar', b: [{ c: 'baz\x07' }] };
  assert.deepEqual(sanitizeDeep(dirty), { a: 'foobar', b: [{ c: 'baz' }] });
});
