// Flat-tree HTML serializer, designed to be passed to page.evaluate().
//
// Walks the live DOM, descending into open shadow roots and substituting
// <slot> elements with their assignedNodes({flatten:true}), so the resulting
// HTML mirrors what the browser actually renders. The output is plain HTML;
// markdown conversion happens in Node via Turndown.
//
// Three layers, cleanly separated:
//   1. serialization — produces a single string
//   2. flatten       — slot projection (this file)
//   3. rendering     — Turndown (in Node, see browser.js)

export function pageToFlatHtml(opts) {
  opts = opts || {};
  const rootSelector = opts.rootSelector || 'main, [role="main"], body';
  const attachmentRe = opts.attachmentRe ? new RegExp(opts.attachmentRe) : null;
  const dropTags = new Set((opts.dropTags || []).map((t) => t.toUpperCase()));

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'AUDIO', 'VIDEO',
  ]);
  const VOID_TAGS = new Set([
    'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
    'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
  ]);
  // Attributes carrying content Turndown will use, or otherwise meaningful for
  // downstream consumers. Everything else (style, class, data-*, on*, etc.)
  // is dropped to keep the intermediate HTML compact.
  const KEEP_ATTRS = new Set([
    'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'value',
    'type', 'name', 'aria-label',
  ]);

  function isVisible(el) {
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const win = el.ownerDocument.defaultView;
    if (!win) return true;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return true;
  }

  function escapeText(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function serializeAttrs(el) {
    let out = '';
    for (const a of el.attributes) {
      const name = a.name;
      if (!KEEP_ATTRS.has(name)) continue;
      // Resolve href/src against the document so relative URLs become absolute.
      let value = a.value;
      if (name === 'href' && el.href) value = el.href;
      else if (name === 'src' && el.src) value = el.src;
      out += ' ' + name + '="' + escapeAttr(value) + '"';
    }
    return out;
  }

  const attachments = [];
  const seenAttach = new Set();

  function noteAttachment(el) {
    if (!attachmentRe) return;
    const href = el.href || el.getAttribute('href') || '';
    if (!href || !attachmentRe.test(href) || seenAttach.has(href)) return;
    seenAttach.add(href);
    attachments.push({ name: (el.textContent || '').trim() || href, url: href });
  }

  function walk(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return escapeText(node.nodeValue || '');
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return '';
    if (dropTags.has(tag)) return '';
    if (!isVisible(node)) return '';

    if (tag === 'SLOT' && typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      const targets = assigned.length ? assigned : Array.from(node.childNodes);
      let s = '';
      for (const n of targets) s += walk(n);
      return s;
    }

    if (tag === 'A') noteAttachment(node);

    const kids = node.shadowRoot
      ? Array.from(node.shadowRoot.childNodes)
      : Array.from(node.childNodes);
    let inner = '';
    for (const c of kids) inner += walk(c);

    const lower = tag.toLowerCase();
    const attrs = serializeAttrs(node);
    if (VOID_TAGS.has(tag)) {
      return '<' + lower + attrs + '>';
    }
    return '<' + lower + attrs + '>' + inner + '</' + lower + '>';
  }

  // Comma-separated rootSelectors are tried in order — querySelector itself
  // returns matches in document order, which is the wrong semantics for a
  // fallback chain (a body selector would always win over anything inside it).
  let root = null;
  for (const sel of rootSelector.split(',')) {
    const trimmed = sel.trim();
    if (!trimmed) continue;
    root = document.querySelector(trimmed);
    if (root) break;
  }
  if (!root) root = document.body;
  const html = walk(root);

  return {
    url: location.href,
    title: document.title || '',
    html,
    attachments,
  };
}
