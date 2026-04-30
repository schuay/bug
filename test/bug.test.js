import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findTestcaseKeyInIssue,
  parseIssue,
  parseTestcase,
  renderMarkdown,
  resolveCfTarget,
  resolveIssueUrl,
  resolveTestcaseKey,
  sanitizeTerminalText,
} from '../bug.js';

test('resolves only known https issue URLs', () => {
  assert.equal(
    resolveIssueUrl('505610970'),
    'https://issuetracker.google.com/issues/505610970',
  );
  assert.equal(
    resolveIssueUrl('https://issues.chromium.org/issues/505610970'),
    'https://issues.chromium.org/issues/505610970',
  );
  assert.throws(
    () => resolveIssueUrl('http://issuetracker.google.com/issues/505610970'),
    /Only https URLs are supported/,
  );
  assert.throws(
    () => resolveIssueUrl('https://example.com/issues/505610970'),
    /Unsupported issue host/,
  );
});

test('resolves ClusterFuzz targets without accepting lookalike hosts', () => {
  assert.deepEqual(
    resolveCfTarget('https://clusterfuzz.com/testcase?key=5009280990216192'),
    { kind: 'testcase', key: '5009280990216192' },
  );
  assert.deepEqual(
    resolveCfTarget('https://issuetracker.google.com/issues/505610970'),
    { kind: 'issue', issue: 'https://issuetracker.google.com/issues/505610970' },
  );
  assert.deepEqual(
    resolveCfTarget('b/505610970'),
    { kind: 'issue', issue: '505610970' },
  );
  assert.equal(
    resolveTestcaseKey('https://clusterfuzz.com/download?testcase_id=5009280990216192'),
    '5009280990216192',
  );
  assert.throws(
    () => resolveCfTarget('https://clusterfuzz.com.evil.test/testcase?key=5009280990216192'),
    /Unsupported ClusterFuzz target host/,
  );
});

test('parses Buganizer issue text', () => {
  const text = `
505610970
Visibility
Crash on startup
Resources
(1)
ReleaseBlock-Stable
STATUS UPDATE
Issue metadata
Type
Bug
Priority
P1
Severity
S2
Status
Assigned
Assignee
owner@example.com
OS
Linux
Mac
Privacy |
DESCRIPTION
Edit
Alice <alice@example.com> created issue #1
Jan 2, 2026 1:23PM
See https://clusterfuzz.com/testcase?key=5009280990216192 for the testcase.
COMMENTS
Full history
Oldest first
Bob <bob@example.com> #2
Jan 3, 2026 2:34PM
This is the user-facing comment.
2:45PM
Status: New  Assigned
Add comment
`;

  const issue = parseIssue(text, 'https://issuetracker.google.com/issues/505610970');

  assert.equal(issue.id, '505610970');
  assert.equal(issue.title, 'Crash on startup');
  assert.deepEqual(issue.hotlists, ['ReleaseBlock-Stable']);
  assert.equal(issue.sidebar.Type, 'Bug');
  assert.deepEqual(issue.sidebar.OS, ['Linux', 'Mac']);
  assert.equal(issue.description.author, 'Alice <alice@example.com>');
  assert.equal(issue.comments[0].number, 2);
  assert.equal(issue.comments[0].body, 'This is the user-facing comment.');
  assert.deepEqual(issue.comments[0].changes, [
    { field: 'Status', from: 'New', to: 'Assigned' },
  ]);
  assert.equal(findTestcaseKeyInIssue(issue), '5009280990216192');
});

test('parses ClusterFuzz testcase text', () => {
  const text = `
Heap-buffer-overflow \u00b7 v8::internal::Foo
Job Type:
linux_asan_d8
Sanitizer:
address
Crash Address:
0x10

GN config
is_debug = false
v8_enable_sandbox = true

Metadata
[Environment] ASAN_OPTIONS=detect_leaks=0
[Command line] /path/to/d8 --expose-gc --future /tmp/testcase.js
#0 crash
Statistics
`;

  const parsed = parseTestcase({
    pageUrl: 'https://clusterfuzz.com/testcase?key=5009280990216192',
    downloadUrl: 'https://clusterfuzz.com/download?testcase_id=5009280990216192',
    text,
    reproducer: { ok: true, body: 'print("hello");\n' },
  }, '5009280990216192');

  assert.equal(parsed.crashType, 'Heap-buffer-overflow');
  assert.equal(parsed.crashState, 'v8::internal::Foo');
  assert.equal(parsed.jobType, 'linux_asan_d8');
  assert.deepEqual(parsed.commandLine.flags, ['--expose-gc', '--future']);
  assert.equal(parsed.commandLine.testcase, '/tmp/testcase.js');
  assert.match(parsed.gnConfig, /v8_enable_sandbox = true/);
  assert.match(parsed.stacktrace, /\[Command line\]/);
  assert.equal(parsed.reproducer, 'print("hello");\n');
});

test('sanitizes terminal control sequences from human output', () => {
  const dirty = 'safe\x1b[31mred\x1b[0m\x1b]0;title\x07done\x08';
  assert.equal(sanitizeTerminalText(dirty), 'safereddone');

  const rendered = renderMarkdown({
    url: 'https://issuetracker.google.com/issues/1',
    id: '1',
    title: dirty,
    componentPath: null,
    hotlists: [],
    sidebar: {},
    description: {
      author: 'Reporter',
      timestamp: 'Jan 1, 2026 1:00PM',
      body: dirty,
    },
    comments: [],
  }, { color: false, verbose: false });

  assert.doesNotMatch(rendered, /\x1b/);
  assert.match(rendered, /safereddone/);
});
