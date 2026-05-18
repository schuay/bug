// Output synthesis: terminal-safe sanitization, ANSI color helpers, and the
// small wrappers that turn the page-markdown plus any structured extras into
// final text written to stdout.

const ANSI_ESCAPE_RE =
  /\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const TERMINAL_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function sanitizeTerminalText(value) {
  return String(value).replace(ANSI_ESCAPE_RE, '').replace(TERMINAL_CONTROL_RE, '');
}

export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeTerminalText(value);
  if (Buffer.isBuffer?.(value)) return value;
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)]),
    );
  }
  return value;
}

export function makeColors(enabled) {
  const c = (open, close) => (s) =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
  return {
    bold: c(1, 22),
    dim: c(2, 22),
    underline: c(4, 24),
    red: c(31, 39),
    green: c(32, 39),
    yellow: c(33, 39),
    cyan: c(36, 39),
    gray: c(90, 39),
  };
}

// Top-of-output header for an issue / testcase / search dump.
export function header(c, title, url) {
  const out = [];
  out.push(c.bold(c.cyan('# ' + title)));
  if (url) {
    out.push('');
    out.push(c.dim(c.underline(url)));
  }
  out.push('');
  return out.join('\n');
}

// Bottom-of-output appendix: attachments, downloads, etc.
export function appendix(c, sections) {
  const out = [];
  for (const [title, lines] of sections) {
    if (!lines || lines.length === 0) continue;
    out.push('');
    out.push(c.bold(c.cyan('## ' + title)));
    out.push('');
    for (const line of lines) out.push(line);
  }
  return out.join('\n');
}
