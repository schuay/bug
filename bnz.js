#!/usr/bin/env node
// bnz — fetch issuetracker.google.com / Buganizer issues via authenticated headless Chromium.
//
// Usage:
//   bnz login                              Open headed browser to log in (one-time).
//   bnz <id|url> [--format=fmt]            Fetch an issue. fmt = markdown (default) | json | text.
//   bnz <id|url> --debug                   Also include raw page text.
//   bnz --help

import { chromium } from 'playwright';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE_DIR = join(homedir(), '.config', 'bnz', 'profile');
const ISSUE_HOSTS = new Set([
  'b.corp.google.com',
  'crbug.com',
  'issues.chromium.org',
  'issuetracker.google.com',
]);
const CLUSTERFUZZ_HOST = 'clusterfuzz.com';

const ANSI_ESCAPE_RE =
  /\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const TERMINAL_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// ---------- arg parsing ----------

function usage() {
  console.error(`bnz — fetch issuetracker.google.com issues and clusterfuzz testcases

Usage:
  bnz login                              Open a headed browser to log in to issuetracker (one-time).
  bnz cf login                           Open a headed browser to log in to clusterfuzz (one-time).
  bnz <id|url> [--format=fmt]            Fetch an issue. fmt = markdown (default) | json | text.
  bnz cf <key|url|issue-id> [--format=fmt]
                                         Fetch a clusterfuzz testcase. Accepts a testcase key/URL,
                                         or a Buganizer issue id/URL/b/<id> (the issue's description
                                         and comments are scanned for a clusterfuzz testcase link).
                                         Heuristic for bare numerics: 14+ digits = testcase key.

Flags:
  -v, --verbose                          Markdown: more detail. For issues, include metadata-only comments and per-comment Changes lists. For cf testcases, include URL, crash header, environment, and full stacktrace.
  --debug                                Include raw page text in output.
  --debug-screenshot=path                Write a ClusterFuzz debug screenshot to an explicit path.
  --no-color                             Disable ANSI color in markdown output.
  -h, --help                             Show this help.
`);
}

function parseArgs(argv) {
  const args = { _: [], format: 'markdown' };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--no-color') args.noColor = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a.startsWith('--format=')) args.format = a.slice('--format='.length);
    else if (a.startsWith('--debug-screenshot=')) {
      args.debugScreenshot = a.slice('--debug-screenshot='.length);
    }
    else args._.push(a);
  }
  return args;
}

function parseHttpUrl(input, kind) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Cannot interpret as ${kind}: ${input}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Only https URLs are supported for ${kind}: ${input}`);
  }
  return url;
}

function isIssueUrl(url) {
  return url.protocol === 'https:' && ISSUE_HOSTS.has(url.hostname);
}

function assertIssueUrl(url) {
  if (!isIssueUrl(url)) {
    throw new Error(`Unsupported issue host: ${url.hostname}`);
  }
}

function canonicalIssueUrl(id) {
  return `https://issuetracker.google.com/issues/${id}`;
}

function extractIssueIdFromUrl(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) return parts[i];
  }
  return null;
}

function resolveIssueUrl(input) {
  if (/^\d+$/.test(input)) return canonicalIssueUrl(input);
  if (/^https?:\/\//.test(input)) {
    const url = parseHttpUrl(input, 'issue URL');
    assertIssueUrl(url);
    const id = extractIssueIdFromUrl(url);
    if (!id) throw new Error(`Cannot find issue id in url: ${input}`);
    return canonicalIssueUrl(id);
  }
  throw new Error(`Cannot interpret as issue id or url: ${input}`);
}

function resolveTestcaseKey(input) {
  if (/^\d+$/.test(input)) return input;
  const url = parseHttpUrl(input, 'clusterfuzz testcase URL');
  if (url.hostname !== CLUSTERFUZZ_HOST) {
    throw new Error(`Unsupported ClusterFuzz host: ${url.hostname}`);
  }
  const key = url.searchParams.get('key') ?? url.searchParams.get('testcase_id');
  if (key && /^\d+$/.test(key)) return key;
  throw new Error(`Cannot interpret as clusterfuzz testcase key or url: ${input}`);
}

function resolveCfTarget(input) {
  if (/^https?:\/\//.test(input)) {
    const url = parseHttpUrl(input, 'clusterfuzz target URL');
    if (url.hostname === CLUSTERFUZZ_HOST) {
      return { kind: 'testcase', key: resolveTestcaseKey(input) };
    }
    if (isIssueUrl(url)) {
      return { kind: 'issue', issue: resolveIssueUrl(input) };
    }
    throw new Error(`Unsupported ClusterFuzz target host: ${url.hostname}`);
  }
  if (/^b\/\d+$/.test(input)) {
    return { kind: 'issue', issue: input.slice(2) };
  }
  if (/^\d+$/.test(input)) {
    // Testcase keys are typically 14+ digits; Buganizer issue IDs are 9-13.
    if (input.length >= 14) return { kind: 'testcase', key: input };
    return { kind: 'issue', issue: input };
  }
  throw new Error(`Cannot interpret cf target: ${input}`);
}

function findTestcaseKeyInIssue(issue) {
  const haystack = [
    issue.description?.body ?? '',
    ...issue.comments.map((c) => c.body || ''),
  ].join('\n');
  const m = haystack.match(/clusterfuzz\.com\/(?:testcase\?key=|download\?testcase_id=)(\d+)/);
  return m ? m[1] : null;
}

function sanitizeTerminalText(value) {
  return String(value)
    .replace(ANSI_ESCAPE_RE, '')
    .replace(TERMINAL_CONTROL_RE, '');
}

function sanitizeForTerminal(value) {
  if (typeof value === 'string') return sanitizeTerminalText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForTerminal(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeForTerminal(item)]),
    );
  }
  return value;
}

function looksLikeIssueContent(text, id) {
  const padded = `\n${text}\n`;
  if (id && padded.includes(`\n${id}\nVisibility\n`)) return true;
  return padded.includes('\nIssue metadata\n') ||
    (padded.includes('\nDESCRIPTION\n') && padded.includes('\nCOMMENTS\n'));
}

function looksLikeAuthPrompt(text) {
  return text.includes('Access is denied to this issue') &&
    text.includes('Access to this issue may be resolved by signing in.');
}

function assertIssueContentAvailable({ url, text }) {
  if (/accounts\.google\.com/.test(url)) {
    throw new Error('Not logged in. Run `bnz login` first.');
  }

  const id = extractIdFromUrl(url);
  if (looksLikeIssueContent(text, id)) return;
  if (looksLikeAuthPrompt(text)) {
    throw new Error('Not logged in. Run `bnz login` first.');
  }
  throw new Error('Issue content not available. Run `bnz login` first or verify access to this issue.');
}

// ---------- color ----------

function makeColors({ enabled }) {
  const c = (open, close) => (s) =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
  return {
    bold: c(1, 22),
    dim: c(2, 22),
    italic: c(3, 23),
    underline: c(4, 24),
    red: c(31, 39),
    green: c(32, 39),
    yellow: c(33, 39),
    blue: c(34, 39),
    magenta: c(35, 39),
    cyan: c(36, 39),
    gray: c(90, 39),
  };
}

// ---------- browser session ----------

async function withContext(fn, { headless = true } = {}) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

async function login(startUrl = 'https://issuetracker.google.com/') {
  console.error(`Opening browser to ${startUrl}. Log in to Google, then close the window when done.`);
  await withContext(async (ctx) => {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(startUrl);
    await new Promise((resolve) => ctx.on('close', resolve));
  }, { headless: false });
  console.error('Login session saved to', PROFILE_DIR);
}

async function fetchPageText(url) {
  return withContext(async (ctx) => {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) {
      throw new Error('Not logged in. Run `bnz login` first.');
    }
    assertIssueUrl(new URL(page.url()));
    await page.waitForSelector('h1, [role="heading"]', { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const result = await page.evaluate(() => {
      const main = document.querySelector('main, [role="main"]') || document.body;
      return {
        url: location.href,
        text: (main.innerText || '').trim(),
      };
    });
    assertIssueContentAvailable(result);
    return result;
  });
}

async function fetchTestcase(key, { debugScreenshot } = {}) {
  const pageUrl = `https://clusterfuzz.com/testcase?key=${key}`;
  const downloadUrl = `https://clusterfuzz.com/download?testcase_id=${key}`;
  return withContext(async (ctx) => {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) {
      throw new Error('Not logged in. Run `bnz cf login` first.');
    }
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    // Give Polymer/shadow-DOM views a moment to paint after networkidle.
    await page.waitForTimeout(500);

    // Walk light + shadow DOM and emit a flat text representation.
    const text = await page.evaluate(() => {
      const BLOCK = new Set([
        'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'TD', 'TH', 'PRE', 'HR', 'BR',
        'TABLE', 'BLOCKQUOTE', 'FIGURE', 'DETAILS', 'SUMMARY', 'LABEL',
      ]);
      function isVisible(el) {
        if (!(el instanceof Element)) return true;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        return true;
      }
      const out = [];
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.nodeValue;
          if (t && t.trim()) out.push(t);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (!isVisible(node)) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
        const block = BLOCK.has(tag);
        if (block) out.push('\n');
        if (node.shadowRoot) {
          for (const c of node.shadowRoot.childNodes) walk(c);
        }
        // Slot content is exposed via the slot's assignedNodes; for simplicity,
        // we still walk the host's lightDOM children (will be projected once).
        for (const c of node.childNodes) walk(c);
        if (block) out.push('\n');
      }
      walk(document.body);
      return out.join('').replace(/\n{3,}/g, '\n\n').trim();
    });

    // Use Playwright's request context (auth cookies, no CORS) to download the
    // reproducer file.
    let reproducer;
    try {
      const resp = await ctx.request.get(downloadUrl);
      if (resp.ok()) {
        reproducer = { ok: true, body: await resp.text() };
      } else {
        reproducer = { ok: false, status: resp.status() };
      }
    } catch (e) {
      reproducer = { ok: false, error: String(e) };
    }

    if (debugScreenshot) {
      await page.screenshot({ path: debugScreenshot, fullPage: true });
    }

    return {
      url: page.url(),
      pageUrl,
      downloadUrl,
      text,
      reproducer,
    };
  });
}

// ---------- parsing ----------

const SIDEBAR_FIELDS = [
  'Reporter', 'Type', 'Priority', 'Severity', 'Status',
  'Story points', 'Access', 'Assignee', 'Verifier',
  'Collaborators', 'CC', 'Code Changes', 'Pending Code Changes',
  'BuildNumber', 'Chromium Labels', 'Component Tags', 'CVE', 'CWE ID',
  'Merge', 'Merge-Request', 'Milestone', 'OS', 'ReleaseBlock', 'Respin',
  'IRM Link', 'Security_Release', 'vrp-reward', 'Fixed By Code Changes',
  'HW', 'Introduced In', 'Found In', 'Targeted To', 'Verified In', 'In Prod',
];
const SIDEBAR_ACTIONS = new Set([
  'Edit', 'Add', 'Add me', 'CC me', 'Start work', 'Expanded Access',
]);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractIdFromUrl(url) {
  return url.match(/\/(\d+)(?:[?#]|$)/)?.[1] ?? null;
}

function extractTitle(text, id) {
  if (id) {
    const m = text.match(new RegExp(`\\n${id}\\nVisibility\\n([^\\n]+)\\n`));
    if (m) return m[1].trim();
  }
  // Fallback: title appears in the issue-creation field-change list as `Title:​<title>`.
  const m2 = text.match(/\nTitle:[\s​]*([^\n]+)/);
  return m2 ? m2[1].trim() : null;
}

function extractComponentPath(text) {
  const m = text.match(/\n(Public Trackers > [^\n]+)\n/);
  return m ? m[1].trim() : null;
}

function extractHotlists(text) {
  // After the title and vote count, there's a "Hotlists (N)\n<line>\n..." block,
  // then known status words. We capture the hotlist names by reading lines after
  // "Hotlists (N)\nMark as Duplicate\nComments\n(N)\nDependencies\n(N)\n..." up to "STATUS UPDATE".
  const m = text.match(/\nResources\n\(\d+\)\n([\s\S]+?)\nSTATUS UPDATE\n/);
  if (!m) return [];
  // The block contains a few status words (Status/Type/Priority echoed) plus hotlists.
  // Filter lines that look like hotlist names: not all-caps section headers.
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  // Drop lines that match status/type/priority echoes — those will appear in sidebar too.
  const drop = new Set([
    'Assigned', 'New', 'Fixed', 'Fixed (Verified)', 'Verified', 'WontFix', 'Duplicate',
    'Vulnerability', 'Bug', 'Feature Request', 'Task', 'Customer Issue',
    'P0', 'P1', 'P2', 'P3', 'P4', 'S0', 'S1', 'S2', 'S3', 'S4',
  ]);
  return lines.filter((l) => !drop.has(l));
}

function extractSidebar(text) {
  const idx = text.indexOf('\nIssue metadata\n');
  if (idx === -1) return {};
  let tail = text.slice(idx + '\nIssue metadata\n'.length);
  const endRe = /\nShow \d+ additional fields\n|\nPrivacy\s*\|/;
  const endMatch = tail.match(endRe);
  if (endMatch) tail = tail.slice(0, endMatch.index);
  // Pad with newline so the very last field is matched by the field regex.
  tail += '\n';

  const fieldRe = new RegExp(
    `(^|\\n)(${SIDEBAR_FIELDS.map(escapeRe).join('|')})\\n`,
    'g',
  );
  const matches = [...tail.matchAll(fieldRe)];
  const result = {};
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][2];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index + 1 : tail.length;
    const raw = tail.slice(start, end);
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const values = lines.filter(
      (l) => !SIDEBAR_ACTIONS.has(l) && l !== '--' && !/^\.\.\. and \d+ more/.test(l),
    );
    if (values.length === 0) result[name] = null;
    else if (values.length === 1) result[name] = values[0];
    else result[name] = values;
  }
  return result;
}

function extractDescription(text) {
  const m = text.match(
    /\nDESCRIPTION\nEdit\n([^\n]+) created issue #1\n([^\n]+)\n([\s\S]+?)\n+COMMENTS\n/,
  );
  if (!m) return null;
  return {
    author: m[1].trim(),
    timestamp: m[2].trim(),
    body: m[3].trim(),
  };
}

const TIME_RE = /^\d{1,2}:\d{2}(?:AM|PM)$/;
const FIELD_CHANGE_RE = /^[+\-]?[\w()][\w\s()\/-]*:[\s​]/;
const AUTHOR_RE = /^(.+?)<([^>]+)>(?:\s+#(\d+))?$/;
const DATE_RE = /^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}(?:AM|PM)$/;

function extractComments(text) {
  const m = text.match(/\nCOMMENTS\nFull history\nOldest first\n([\s\S]+?)\nAdd comment\n/);
  if (!m) return [];
  const lines = m[1].split('\n');

  // Split into raw blocks at author-header + date-line boundaries.
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (AUTHOR_RE.test(line) && next && DATE_RE.test(next)) {
      if (cur) blocks.push(cur);
      const am = line.match(AUTHOR_RE);
      cur = {
        author: am[1].trim(),
        email: am[2].trim(),
        number: am[3] ? Number(am[3]) : null,
        timestamp: next.trim(),
        rest: [],
      };
      i++; // consume date line
    } else if (cur) {
      cur.rest.push(line);
    }
  }
  if (cur) blocks.push(cur);

  // Within each block: separate body from trailing metadata changes.
  // Metadata changes look like alternating `HH:MMAM/PM` lines and `Field:​old  new` lines.
  return blocks.map((b) => {
    const rest = b.rest;
    // Find the start of the metadata-changes tail.
    // Scan from the end: find the earliest index `i` such that every non-empty line
    // from i onwards is either a TIME line or a FIELD_CHANGE line.
    let tailStart = rest.length;
    for (let i = rest.length - 1; i >= 0; i--) {
      const l = rest[i].trim();
      if (l === '' || TIME_RE.test(l) || FIELD_CHANGE_RE.test(l)) {
        tailStart = i;
      } else {
        break;
      }
    }
    const bodyLines = rest.slice(0, tailStart);
    const tailLines = rest.slice(tailStart);

    const changes = [];
    for (const l of tailLines) {
      const t = l.trim();
      if (!t || TIME_RE.test(t)) continue;
      // Field change: `Field:​<old>  <new>` or `Field:​<value>` or `+Hotlist:​...`.
      const fm = t.match(/^([+\-]?[^:]+):[\s​]+([\s\S]*)$/);
      if (fm) {
        const field = fm[1].trim();
        const valueRaw = fm[2].trim();
        // Detect old → new pattern when separated by two spaces (after ZWSP cleanup).
        const arrow = valueRaw.match(/^(.+?)\s\s+(.+)$/);
        if (arrow) {
          changes.push({ field, from: arrow[1].trim(), to: arrow[2].trim() });
        } else {
          changes.push({ field, value: valueRaw });
        }
      }
    }

    return {
      author: b.author,
      email: b.email,
      number: b.number,
      timestamp: b.timestamp,
      body: bodyLines.join('\n').trim() || null,
      changes,
    };
  });
}

// ---------- clusterfuzz parsing ----------

function firstMatch(text, re, group = 1) {
  const m = text.match(re);
  return m ? m[group].trim() : null;
}

function extractHeader(text) {
  // Top of page renders as: "<Crash Type> · <Crash State>" inside an h1-ish block.
  // Everything is heavily padded with whitespace from our DOM walker.
  const m = text.match(/\n\s*([^\n·]+?)\s+·\s+([^\n]+?)\n/);
  if (!m) return { crashType: null, crashState: null };
  return { crashType: m[1].trim(), crashState: m[2].trim() };
}

function extractGnConfig(text) {
  const m = text.match(/\nGN config[^\n]*\n+([\s\S]+?)\n+(?:Metadata|Event History|$)/);
  return m ? m[1].trim() : null;
}

function extractStacktrace(text) {
  // The stacktrace block starts at "[Environment] <VAR>=..." (the page body
  // also mentions "[Environment]" in prose, so anchor on a uppercase-letter
  // continuation to skip that). It ends at the "Statistics" section.
  const startMatch = text.match(/\n\[Environment\] [A-Z]/);
  if (!startMatch) return null;
  const start = startMatch.index + 1;
  const tail = text.slice(start);
  const endMatch = tail.match(/\n\s*Statistics\n/);
  const slice = endMatch ? tail.slice(0, endMatch.index) : tail;
  return slice.trim();
}

function extractCommandLine(text) {
  const m = text.match(/\[Command line\]\s+([^\n]+)/);
  if (!m) return null;
  const raw = m[1].trim();
  const tokens = raw.split(/\s+/);
  const binary = tokens[0];
  // The last non-flag token is conventionally the testcase path.
  let testcase = null;
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (!tokens[i].startsWith('-')) { testcase = tokens[i]; break; }
  }
  const flags = tokens.slice(1).filter((t) => t !== testcase);
  return { raw, binary, flags, testcase };
}

function extractEnvironment(text) {
  const m = text.match(/\[Environment\]\s+([^\n]+)/);
  return m ? m[1].trim() : null;
}

// Some labeled fields render unambiguously (single value, no radio group).
function extractSingleLineField(text, label) {
  const re = new RegExp(`\\n${escapeRe(label)}:\\s*\\n+\\s*([^\\n]+?)\\s*\\n`);
  return firstMatch(text, re);
}

function parseTestcase(tc, key) {
  const text = tc.text;
  const header = extractHeader(text);
  const reproducerBody = tc.reproducer?.ok ? tc.reproducer.body : null;
  return {
    key,
    pageUrl: tc.pageUrl,
    downloadUrl: tc.downloadUrl,
    crashType: header.crashType,
    crashState: header.crashState,
    jobType: extractSingleLineField(text, 'Job Type'),
    sanitizer: extractSingleLineField(text, 'Sanitizer'),
    crashAddress: extractSingleLineField(text, 'Crash Address'),
    commandLine: extractCommandLine(text),
    environment: extractEnvironment(text),
    gnConfig: extractGnConfig(text),
    stacktrace: extractStacktrace(text),
    reproducer: reproducerBody,
    reproducerError: tc.reproducer?.ok ? null : tc.reproducer,
  };
}

function renderTestcaseMarkdown(parsed, { color, verbose }) {
  parsed = sanitizeForTerminal(parsed);
  const C = makeColors({ enabled: color });
  const out = [];

  out.push(C.bold(C.cyan(`# ClusterFuzz testcase ${parsed.key}`)));
  out.push('');

  if (verbose) {
    out.push(C.dim(C.underline(parsed.pageUrl)));
    out.push('');
    if (parsed.crashType || parsed.crashState) {
      out.push(`${C.bold(C.red(parsed.crashType || ''))}${
        parsed.crashState ? `  ·  ${parsed.crashState}` : ''}`);
      out.push('');
    }
    const summary = [
      parsed.jobType && `${C.bold('Job')}: ${parsed.jobType}`,
      parsed.sanitizer && `${C.bold('Sanitizer')}: ${parsed.sanitizer}`,
      parsed.crashAddress && parsed.crashAddress !== '---' &&
        `${C.bold('Crash addr')}: ${parsed.crashAddress}`,
    ].filter(Boolean).join('  ·  ');
    if (summary) { out.push(summary); out.push(''); }
  }

  if (parsed.commandLine) {
    const cl = parsed.commandLine;
    out.push(C.bold(C.cyan('## Flags')));
    if (verbose) {
      out.push('');
      out.push(`${C.bold('Binary')}: ${C.dim(cl.binary)}`);
      out.push(`${C.bold('Testcase')}: ${C.dim(cl.testcase ?? '(unknown)')}`);
    }
    out.push('```');
    out.push(cl.flags.join(' '));
    out.push('```');
    out.push('');
  }

  if (verbose && parsed.environment) {
    out.push(C.bold(C.cyan('## Environment')));
    out.push('```');
    out.push(parsed.environment);
    out.push('```');
    out.push('');
  }

  if (parsed.gnConfig) {
    out.push(C.bold(C.cyan('## GN config (args.gn)')));
    out.push('```');
    out.push(parsed.gnConfig);
    out.push('```');
    out.push('');
  }

  if (parsed.reproducer) {
    out.push(C.bold(C.cyan('## Minimized testcase')));
    out.push('```javascript');
    out.push(parsed.reproducer);
    out.push('```');
    out.push('');
  } else if (parsed.reproducerError) {
    out.push(C.red('## Minimized testcase (download failed)'));
    out.push('```');
    out.push(JSON.stringify(parsed.reproducerError, null, 2));
    out.push('```');
    out.push('');
  }

  if (verbose && parsed.stacktrace) {
    out.push(C.bold(C.cyan('## Crash stacktrace')));
    out.push('```');
    out.push(parsed.stacktrace);
    out.push('```');
  }

  return out.join('\n');
}

function parseIssue(text, url) {
  const id = extractIdFromUrl(url);
  return {
    url,
    id,
    title: extractTitle(text, id),
    componentPath: extractComponentPath(text),
    hotlists: extractHotlists(text),
    sidebar: extractSidebar(text),
    description: extractDescription(text),
    comments: extractComments(text),
  };
}

// ---------- markdown rendering ----------

function flatten(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function renderMarkdown(issue, { color, verbose }) {
  issue = sanitizeForTerminal(issue);
  const C = makeColors({ enabled: color });
  const out = [];
  const sb = issue.sidebar;

  const titleLine = `[${issue.id}] ${issue.title || '(no title)'}`;
  out.push(C.bold(C.cyan(`# ${titleLine}`)));
  out.push('');
  out.push(C.dim(C.underline(issue.url)));
  out.push('');

  const status = flatten(sb.Status);
  const type = flatten(sb.Type);
  const priority = flatten(sb.Priority);
  const severity = flatten(sb.Severity);

  const priColor =
    priority === 'P0' || priority === 'P1' ? C.red :
    priority === 'P2' ? C.yellow : C.green;
  const sevColor =
    severity === 'S0' || severity === 'S1' ? C.red :
    severity === 'S2' ? C.yellow : C.green;
  const statusColor =
    /Fixed|Verified/i.test(status || '') ? C.green :
    /Assigned|New/i.test(status || '') ? C.yellow : C.gray;

  const summary = [
    status && `${C.bold('Status')}: ${statusColor(status)}`,
    type && `${C.bold('Type')}: ${type}`,
    priority && `${C.bold('Priority')}: ${priColor(priority)}`,
    severity && `${C.bold('Severity')}: ${sevColor(severity)}`,
  ].filter(Boolean).join('  ·  ');
  if (summary) { out.push(summary); out.push(''); }

  const meta = [
    issue.componentPath && [`Component`, issue.componentPath],
    flatten(sb.Assignee) && [`Assignee`, flatten(sb.Assignee)],
    flatten(sb.Reporter) && [`Reporter`, flatten(sb.Reporter)],
    flatten(sb.Verifier) && [`Verifier`, flatten(sb.Verifier)],
    flatten(sb.Milestone) && [`Milestone`, flatten(sb.Milestone)],
    flatten(sb['Found In']) && [`Found in`, flatten(sb['Found In'])],
    flatten(sb['Introduced In']) && [`Introduced in`, flatten(sb['Introduced In'])],
    flatten(sb['Targeted To']) && [`Targeted to`, flatten(sb['Targeted To'])],
    flatten(sb['Verified In']) && [`Verified in`, flatten(sb['Verified In'])],
    flatten(sb.OS) && [`OS`, flatten(sb.OS)],
    flatten(sb['Component Tags']) && [`Component tags`, flatten(sb['Component Tags'])],
    flatten(sb.ReleaseBlock) && [`Release block`, flatten(sb.ReleaseBlock)],
    flatten(sb.CC) && [`CC`, flatten(sb.CC)],
    flatten(sb.Collaborators) && [`Collaborators`, flatten(sb.Collaborators)],
    flatten(sb.Access) && [`Access`, flatten(sb.Access)],
    flatten(sb.CVE) && [`CVE`, flatten(sb.CVE)],
  ].filter(Boolean);

  if (meta.length) {
    for (const [k, v] of meta) out.push(`- ${C.bold(k)}: ${v}`);
    out.push('');
  }

  if (issue.hotlists.length) {
    out.push(`${C.bold('Hotlists')}: ${C.magenta(issue.hotlists.join(', '))}`);
    out.push('');
  }

  if (issue.description) {
    out.push(C.bold(C.cyan('## Description')));
    out.push(C.dim(`${issue.description.author} — ${issue.description.timestamp}`));
    out.push('');
    out.push(issue.description.body);
    out.push('');
  }

  const comments = verbose
    ? issue.comments
    : issue.comments.filter((c) => c.number != null);

  if (comments.length) {
    const total = issue.comments.length;
    const header = verbose
      ? `## Comments (${total})`
      : `## Comments (${comments.length}${total !== comments.length ? ` of ${total}` : ''})`;
    out.push(C.bold(C.cyan(header)));
    out.push('');
    for (const c of comments) {
      const tag = c.number != null ? `#${c.number}` : C.dim('(metadata-only)');
      const who = c.author === c.email ? c.author : `${c.author} <${c.email}>`;
      out.push(C.bold(`### ${tag} ${who}`) + '  ' + C.dim(c.timestamp));
      if (c.body) {
        out.push('');
        out.push(c.body);
      }
      if (verbose && c.changes.length) {
        out.push('');
        out.push(C.gray('Changes:'));
        for (const ch of c.changes) {
          if ('from' in ch) {
            out.push(`  - ${C.bold(ch.field)}: ${C.dim(ch.from)} → ${ch.to}`);
          } else {
            out.push(`  - ${C.bold(ch.field)}: ${ch.value}`);
          }
        }
      }
      out.push('');
    }
  }

  return out.join('\n');
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const colorEnabled =
    !args.noColor && !process.env.NO_COLOR && process.stdout.isTTY;

  const cmd = args._[0];
  if (cmd === 'login') {
    await login();
    return;
  }
  if (cmd === 'cf') {
    const sub = args._[1];
    if (!sub) { usage(); process.exit(1); }
    if (sub === 'login') {
      await login('https://clusterfuzz.com/');
      return;
    }
    const target = resolveCfTarget(sub);
    let key;
    if (target.kind === 'issue') {
      const issueUrl = resolveIssueUrl(target.issue);
      console.error(`Resolving testcase via issue ${issueUrl}...`);
      const { url: finalUrl, text: issueText } = await fetchPageText(issueUrl);
      const issue = parseIssue(issueText, finalUrl);
      key = findTestcaseKeyInIssue(issue);
      if (!key) {
        throw new Error(`No clusterfuzz testcase link found in issue ${target.issue}.`);
      }
      console.error(`-> testcase ${key}`);
    } else {
      key = target.key;
    }
    if (args.debugScreenshot === '') {
      throw new Error('--debug-screenshot requires a path.');
    }
    const tc = await fetchTestcase(key, {
      debugScreenshot: args.debugScreenshot ?? null,
    });
    if (args.debugScreenshot) {
      console.error(`[debug] screenshot: ${args.debugScreenshot}`);
    }
    const parsed = parseTestcase(tc, key);
    if (args.debug) parsed.rawText = tc.text;
    if (args.format === 'json') {
      console.log(JSON.stringify(parsed, null, 2));
    } else if (args.format === 'text') {
      console.log(sanitizeTerminalText(tc.text));
    } else if (args.format === 'markdown') {
      console.log(renderTestcaseMarkdown(parsed, { color: colorEnabled, verbose: !!args.verbose }));
    } else {
      throw new Error(`Unknown format: ${args.format}`);
    }
    return;
  }

  const url = resolveIssueUrl(cmd);
  const { url: finalUrl, text } = await fetchPageText(url);
  const issue = parseIssue(text, finalUrl);
  if (args.debug) issue.rawText = text;

  if (args.format === 'json') {
    console.log(JSON.stringify(issue, null, 2));
  } else if (args.format === 'text') {
    console.log(sanitizeTerminalText(text));
  } else if (args.format === 'markdown') {
    console.log(renderMarkdown(issue, { color: colorEnabled, verbose: !!args.verbose }));
  } else {
    throw new Error(`Unknown format: ${args.format}`);
  }
}

export {
  assertIssueContentAvailable,
  findTestcaseKeyInIssue,
  parseArgs,
  parseIssue,
  parseTestcase,
  renderMarkdown,
  renderTestcaseMarkdown,
  resolveCfTarget,
  resolveIssueUrl,
  resolveTestcaseKey,
  sanitizeForTerminal,
  sanitizeTerminalText,
};

function isMainModule() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(sanitizeTerminalText(err.message || err));
    process.exit(1);
  });
}
