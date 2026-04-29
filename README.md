# bug

A small CLI that fetches authenticated content from
[issuetracker.google.com](https://issuetracker.google.com) (Buganizer) and
[clusterfuzz.com](https://clusterfuzz.com), using a persistent headless
Chromium session driven by Playwright.

Built because there is no usable external API for either service and pasting
issue contents into another tool gets old fast.

## Install

```sh
git clone <this repo> ~/repos/bug
cd ~/repos/bug
npm install
npx playwright install chromium
```

Add `~/repos/bug` to your `PATH` so `bug` is on it (the repo ships a `bug`
symlink to `bug.js`).

## First-time login

Each service is a one-time headed-browser login. The session is stored in a
persistent Playwright profile at `~/.config/bug-cli/profile`.

```sh
bug login        # log into issuetracker.google.com
bug cf login     # log into clusterfuzz.com
```

Both services use Google SSO, so logging into one usually carries the other —
but running both is harmless and ensures cookies are warm.

## Usage

### Fetch a Buganizer issue

```sh
bug 505610970                 # markdown, compact
bug 505610970 -v              # markdown, verbose (metadata-only comments + Changes lists)
bug 505610970 --format=json   # structured JSON
bug https://issuetracker.google.com/issues/505610970
```

Compact markdown shows: title, status/type/priority/severity summary, sidebar
metadata, hotlists, description, and numbered comments. Verbose adds
metadata-only entries (component changes, hotlist toggles) and per-comment
field-change lists.

### Fetch a ClusterFuzz testcase

```sh
bug cf 5009280990216192       # by testcase key
bug cf 505610970              # by Buganizer issue id (resolves the testcase link in the issue body)
bug cf b/505610970
bug cf https://clusterfuzz.com/testcase?key=5009280990216192
bug cf 505610970 -v           # verbose
bug cf 505610970 --format=json
```

Numeric input is disambiguated by length: 14+ digits is treated as a testcase
key; otherwise it's a Buganizer issue id and the issue's description and
comments are scanned for a `clusterfuzz.com/testcase?key=...` link.

Compact testcase output is the three things you usually want:

- `## Flags` — d8 flags parsed from the `[Command line]` in the crash stacktrace
- `## GN config (args.gn)` — the build configuration verbatim
- `## Minimized testcase` — the reproducer JavaScript, downloaded via the authenticated session

Verbose adds the page URL, crash header, Job/Sanitizer summary, binary and
testcase paths, ASAN environment options, and the full crash stacktrace.

### Common flags

| Flag                  | Effect                                                                 |
|-----------------------|------------------------------------------------------------------------|
| `--format=markdown`   | Default. Pretty-printed with ANSI color when stdout is a TTY.          |
| `--format=json`       | Structured output. Always full content (verbosity is ignored).         |
| `--format=text`       | Raw page text from the DOM walker. Useful for debugging the parser.    |
| `-v`, `--verbose`     | Markdown only: include the omitted-by-default sections.                |
| `--debug`             | Adds `rawText` to JSON, writes a screenshot to `/tmp/bug-cf-<key>.png`.|
| `--no-color`          | Disable ANSI color (also respects `NO_COLOR`).                         |
| `-h`, `--help`        | Show usage.                                                            |

## How it works

Both sites are JavaScript SPAs (Polymer with shadow DOM), so we don't try to
hit any backend API. Instead:

1. Playwright launches Chromium against a persistent user-data dir, reusing
   the cookies you established with `bug login` / `bug cf login`.
2. We navigate, wait for the SPA to settle (`networkidle`), and walk the
   document — descending into open shadow roots — to produce a flat text
   representation.
3. The text is parsed with anchored regexes for the fields we care about
   (issue sidebar, description, comments; testcase command line, GN config,
   stacktrace).
4. The clusterfuzz reproducer is downloaded as a separate authenticated
   request via Playwright's request context (avoids CORS).

## Limitations

- Parsing is heuristic. The pages don't expose stable selectors, so when
  Google changes the UI the regexes will drift. `--format=text` and `--debug`
  are the escape hatches.
- Some sidebar fields on the issue page contain truncated lists (e.g. `OS`
  showing only the first three values, hidden behind a "Show all" disclosure).
  The full list is recoverable from the comment-change history.
- Buganizer fields rendered as radio groups (Crash Type alternates, Reliably
  Reproduces, Security selector, etc.) on the clusterfuzz page concatenate
  all options in DOM order. Those fields are intentionally omitted from the
  parsed output rather than presented misleadingly.
- `bug login` / `bug cf login` require manual interaction. Cookie rotation
  may eventually invalidate the session; re-run the login if requests start
  redirecting to `accounts.google.com`.

## Files

- `bug.js` — the entire CLI.
- `bug` — symlink to `bug.js` (so the unsuffixed name is on `PATH`).
- `package.json` — declares the Playwright dependency.
