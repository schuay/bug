// Persistent Playwright session for fetching authenticated pages.
//
// Designed for multi-target reuse: one Session instance owns one Chromium
// launch and can fetch many pages. Use openSession() in a try/finally so the
// browser is closed even on error.
//
// Markdown extraction pipeline:
//   1. In-page: pageToFlatHtml() walks the rendered DOM, projects slots, and
//      emits HTML mirroring what the browser paints.
//   2. In Node: Turndown converts that HTML to markdown with GFM tables.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import TurndownService from 'turndown';
import gfm from '@joplin/turndown-plugin-gfm';

import { pageToFlatHtml } from './dom.js';

export const PROFILE_DIR = join(homedir(), '.config', 'bnz', 'profile');

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
    linkStyle: 'inlined',
  });
  td.use(gfm.gfm);
  // Polymer pages are riddled with empty <a> elements (icon-only buttons with
  // no visible text). Drop links whose visible text is empty so Turndown
  // doesn't emit bare "[](url)" noise.
  td.addRule('drop-empty-anchors', {
    filter: (node) =>
      node.nodeName === 'A' &&
      !(node.textContent || '').trim() &&
      !node.querySelector('img'),
    replacement: () => '',
  });
  // Counter pills and other inline links nest blocks (e.g. <a><span>Label</span><span>(N)</span></a>),
  // which Turndown renders as multi-line link text. Collapse so they fit on one line.
  td.addRule('flatten-inline-links', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (node.textContent || '').trim() &&
      !node.querySelector('img, pre'),
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      const flat = content.replace(/\s+/g, ' ').trim();
      if (!flat) return '';
      if (!href || href === '#') return flat;
      return '[' + flat + '](' + href + ')';
    },
  });
  // Decorative images (empty alt) carry no information for a markdown reader.
  // Drop avatar placeholders, status icons, etc.
  td.addRule('drop-decorative-images', {
    filter: (node) =>
      node.nodeName === 'IMG' && !(node.getAttribute('alt') || '').trim(),
    replacement: () => '',
  });
  // Buganizer renders one per-field-change event for each field set when the
  // bug was created, each prefixed with a redundant time-of-day stamp like
  // "07:13". The main comment header still carries the full timestamp.
  td.addRule('drop-time-only-stamps', {
    filter: (node) =>
      (node.nodeName === 'TIME' || node.nodeName === 'B-FORMATTED-DATE-TIME') &&
      /^\d{1,2}:\d{2}\s*(?:[ap]m)?$/i.test((node.textContent || '').trim()),
    replacement: () => '',
  });
  // Drop common Buganizer action buttons whose text is a known verb. The
  // sidebar's user pickers are wrapped in <button> too, but their text is the
  // user's email — those don't match and are kept.
  const BUTTON_ACTION_TEXTS = new Set([
    'Edit', 'Add', 'Add me', 'Add Hotlist', 'CC me', 'Start work',
    'Expanded Access', 'Mark as Duplicate', 'Sign in',
    'Sign in with Google', 'Sign in with GitHub', 'Skip Navigation',
    'Hide all',
  ]);
  td.addRule('drop-action-buttons', {
    filter: (node) => {
      if (node.nodeName !== 'BUTTON') return false;
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (BUTTON_ACTION_TEXTS.has(txt)) return true;
      const a = node.getAttribute('aria-label') || '';
      if (a === 'collapsible panel') return true;
      return /^(?:Remove|Add) .* (?:from|to) /.test(a) ||
        /^Add item to /.test(a);
    },
    replacement: () => '',
  });
  // Drop action-only divs/spans in the sidebar (aria-labels like "Edit",
  // "Add me", "Show all 6 Chromium Labels items", "Add yourself to ...").
  td.addRule('drop-action-elements', {
    filter: (node) => {
      if (node.nodeName !== 'DIV' && node.nodeName !== 'SPAN') return false;
      const a = node.getAttribute('aria-label') || '';
      if (a) {
        if (BUTTON_ACTION_TEXTS.has(a)) return true;
        if (/^Show all \d+/.test(a) || /^Add yourself/.test(a)) return true;
      }
      // Bare action-verb spans (e.g. "Expanded Access" widget).
      if (node.nodeName === 'SPAN' && !a) {
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (BUTTON_ACTION_TEXTS.has(txt)) return true;
      }
      return false;
    },
    replacement: () => '',
  });
  // Sidebar fields with a structured aria-label ("Foo value is Bar",
  // "Foo is empty", "Foo has N items"). Compact each to a single bullet.
  // Skip empty sidebar fields in focused mode — they dominate the bullet list
  // for issues with most fields unset. The full-mode dump keeps everything.
  const fieldLine = (label, value) => {
    if (!label) return '';
    if (!value || value === '—' || value === '--') return '';
    return '\n- **' + label + '**: ' + value + '\n';
  };
  td.addRule('compact-sidebar-aria', {
    filter: (node) =>
      (node.nodeName === 'B-EDIT-FIELD' || node.nodeName === 'B-LIST-FIELD') &&
      node.querySelector('div[aria-label]'),
    replacement: (content, node) => {
      const wrap = node.querySelector('div[aria-label]');
      const a = wrap ? wrap.getAttribute('aria-label') || '' : '';
      let m;
      if (a.match(/^(.+?)\s+(?:value\s+)?is\s+empty$/)) return '';
      if ((m = a.match(/^(.+?)\s+value\s+is\s+(.+)$/))) {
        return fieldLine(m[1].trim(), m[2].trim());
      }
      if ((m = a.match(/^(.+?)\s+has\s+\d+\s+items?$/))) {
        const labelEl = node.querySelector('label');
        const labelTxt = labelEl ? (labelEl.textContent || '').trim() : m[1].trim();
        const items = [];
        for (const e of node.querySelectorAll('b-truncated-span, a[href]')) {
          const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !items.includes(t)) items.push(t);
        }
        return fieldLine(labelTxt, items.join(', '));
      }
      return content;
    },
  });
  // Stray onedev-edit-field (e.g. Story points) not wrapped in a b-*-control.
  td.addRule('compact-onedev-edit-field', {
    filter: 'onedev-edit-field',
    replacement: (content, node) => {
      const labelEl = node.querySelector('onedev-field-label, label');
      const label = labelEl ? (labelEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const valueEl = node.querySelector('onedev-field-value');
      const value = valueEl ? (valueEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return fieldLine(label, value);
    },
  });
  // Comment events with no user-written body (system-generated field-change
  // events) leave behind an empty author header. Drop those entirely; events
  // with real text bodies live in <b-formatted-comment-presenter>.
  td.addRule('drop-empty-history-events', {
    filter: (node) =>
      node.nodeName === 'B-HISTORY-EVENT' &&
      !node.querySelector('b-formatted-comment-presenter'),
    replacement: () => '',
  });
  // User picker sidebar fields (Reporter / Assignee / Verifier / CC /
  // Collaborators). No aria-label of the field pattern — extract from DOM.
  td.addRule('compact-user-field', {
    filter: (node) =>
      node.nodeName === 'B-SINGLE-USER-CONTROL' ||
      node.nodeName === 'B-MULTI-USER-CONTROL',
    replacement: (content, node) => {
      const labelEl = node.querySelector('onedev-field-label, label');
      const label = labelEl ? (labelEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const users = [];
      for (const e of node.querySelectorAll('b-user-membership-chip, b-person-hovercard')) {
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !users.includes(t)) users.push(t);
      }
      return fieldLine(label, users.join(', '));
    },
  });
  return td;
}

const turndown = makeTurndown();

// After Turndown runs, anything inside the "### Issue metadata" section that
// isn't a bullet is by definition an unrecognized sidebar field — its label
// and value rendered as separate lines because no compaction rule matched.
// In focused mode we'd rather drop them than show a multi-line stub.
function compactSidebarTail(markdown) {
  const marker = '### Issue metadata';
  const idx = markdown.indexOf(marker);
  if (idx === -1) return markdown;
  const before = markdown.slice(0, idx + marker.length);
  const after = markdown.slice(idx + marker.length);
  const cleaned = after
    .split('\n')
    .filter((line) => line.startsWith('- ') || line.trim() === '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return before + '\n' + cleaned.replace(/^\n+/, '\n');
}

export class AuthRequiredError extends Error {
  constructor(url) {
    super(`Not logged in (redirected to accounts.google.com when fetching ${url}). ` +
      `Run \`bug login\` (issuetracker) or \`bug cf login\` (clusterfuzz).`);
    this.name = 'AuthRequiredError';
  }
}

export async function openSession({ headless = true } = {}) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
  });
  let page = ctx.pages()[0] || await ctx.newPage();

  async function navigate(url, { settleSelector } = {}) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) {
      throw new AuthRequiredError(url);
    }
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    if (settleSelector) {
      // Wait up to 5s for a known lazy-loaded element. Best-effort: some pages
      // (auth gates, errors) won't ever have it.
      await page.waitForSelector(settleSelector, { timeout: 5_000 }).catch(() => {});
    }
    await page.waitForTimeout(400);
    return page.url();
  }

  async function dump(url, { rootSelector, attachmentRe, dropTags, settleSelector } = {}) {
    const finalUrl = await navigate(url, { settleSelector });
    const payload = await page.evaluate(pageToFlatHtml, {
      rootSelector,
      attachmentRe: attachmentRe ? attachmentRe.source : null,
      dropTags: dropTags || null,
    });
    const markdown = compactSidebarTail(turndown.turndown(payload.html));
    return { ...payload, markdown, finalUrl };
  }

  async function rawHtml(url) {
    await navigate(url);
    return page.content();
  }

  async function downloadBytes(url) {
    try {
      const resp = await ctx.request.get(url);
      if (!resp.ok()) return { ok: false, status: resp.status() };
      const buf = await resp.body();
      return { ok: true, body: buf, contentType: resp.headers()['content-type'] || '' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function downloadText(url) {
    const r = await downloadBytes(url);
    if (!r.ok) return r;
    return { ok: true, body: r.body.toString('utf8'), contentType: r.contentType };
  }

  return {
    ctx,
    page,
    dump,
    rawHtml,
    navigate,
    downloadBytes,
    downloadText,
    async close() { await ctx.close(); },
  };
}

// Open a headed browser so the user can complete Google SSO. Resolves when
// the user closes the window.
export async function loginInteractive(startUrl) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(startUrl);
  await new Promise((resolve) => ctx.on('close', resolve));
}
