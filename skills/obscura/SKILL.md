---
name: obscura
description: Use before fetching any URL — `ofetch`, a CLI on PATH, is the default reader and replaces WebFetch — and when scraping a site, driving a page that needs clicking, form-filling or a login, checking a local dev server's rendered output, console or network traffic, or choosing between ofetch, the obscura MCP, WebFetch, WebSearch and Playwright.
---

# obscura

**The default way to read a URL is `ofetch <url>` through Bash.** It is a plain
script on `PATH` — no MCP registration, no session setup — so it is available
from a subagent, from a fresh session, and anywhere the `browser_*` tools are
not loaded. It renders the page, files it, and prints a preview, which is the
whole point: the page does not land in context. `WebFetch` is a fallback for
one case (a cheap summary of a huge page), not the first reach.

A headless browser (Rust) that renders pages and runs their JavaScript. It
replaces `WebFetch` for reading the web, because `WebFetch` retrieves HTML over
HTTP without executing it and therefore sees an empty shell on any
client-rendered site.

Two entry points, and the choice between them is about **state**:

| | |
|---|---|
| `ofetch` (CLI, via Bash) | read a page and leave — no session |
| `obscura` MCP, 37 `browser_*` tools | a live tab: cookies, history and DOM persist between calls |

## When to use what

| Task | Reach for |
|---|---|
| Read a docs page, article, README | `ofetch <url>` |
| One fact off a page | `ofetch -e "<js>" <url>` |
| Structured records off a page | `browser_extract` — best tool in the set |
| A page that needs a click, a form, a login, or waiting | `browser_*` MCP tools |
| What a page **logged or requested** | Playwright MCP — obscura's console/network tools are blind, see below |
| A dev server's rendered output (not its console) | `browser_*` MCP, or `ofetch --local` |
| Many URLs at once | `obscura scrape --concurrency N` — but it writes to stdout, so redirect it to a file and grep, never let it land in context |
| Find which URL to read | `WebSearch` — obscura has no index |
| A cheap summary of one huge page | `WebFetch` — it answers via a small model |
| Pixel-accurate rendering, real Chrome behavior | Playwright MCP — obscura has its own engine |
| A big SPA that must actually boot (checkout, account, cart) | try obscura once, fall back to Playwright — see *When an app boots but breaks* |
| The human should look at it | the Browser pane |

## ofetch

Renders the page, writes it to `$TMPDIR/ofetch/<slug>-<hash>.md`, prints the
path plus a preview. Read or grep the file for the rest — do not pull a whole
document into context just to use ten lines of it.

```bash
ofetch https://example.com                    # markdown + preview
ofetch -d links -n 0 https://example.com      # links only, no preview
ofetch --local http://localhost:5173          # dev server (see SSRF note)
ofetch -e "document.title" https://example.com
```

`ofetch --help` has every flag. Formats: `markdown text html links assets
cookies original`. Exit codes: `2` bad arguments or contradictory flags, `3` the
page came back under `--min-text` bytes (a failed render, see below), `1`
obscura itself could not fetch.

`ofetch` settles less than the MCP tab does: a page whose form is missing from
`ofetch -d markdown` can still be fully present under `browser_navigate` with
`waitUntil: networkidle0`. Do not conclude "obscura cannot render this" from a
thin `ofetch` dump alone — re-check in a tab first.

## An HTTP error is the site, not the entry point

`ofetch`, `obscura scrape` and the `browser_*` MCP tools all drive the same
engine over the same transport, so a 403, a 429 or a challenge page from one of
them is the same answer from all three. Re-running the fetch through a different
entry point after a rate limit changes nothing except how much context it costs.
Back off, wait, or take the refusal as the answer — see *Scraping manners*. The
entry points differ in **state and output shape**, not in what a site is willing
to serve.

## Four places the obscura docs are wrong

Verified against 0.2.1 by hand. Trust this list over docs.obscura.sh.

1. **`--selector` does not narrow the output.** The docs call it "narrow output
   to CSS selector"; it is a *wait* condition. A missing selector logs
   `Warning: selector 'x' not found after 5s` and the full page is dumped
   anyway. To extract one region, use `--eval` with JS:
   `ofetch -e "document.querySelector('main').innerText" <url>`
2. **`--eval` combined with `--dump` prints both** the whole page and the
   result. `ofetch` drops `--dump` in eval mode; raw `obscura` calls must too.
3. **Loopback and RFC1918 are blocked by default** — an SSRF guard, not a bug.
   `localhost` fails with "Access to localhost domain 'localhost' is not
   allowed". Pass `ofetch --local`, or `obscura --allow-private-network`.
4. **`--version` prints 0.1.0** regardless of the real version, and on a cargo
   install `brew list` knows nothing either. `cargo install --list` is the one
   that answers — it prints the git URL and tag the binary was built from:
   `obscura-cli v0.1.0 (https://github.com/…?tag=v0.2.1#2810cb47)`.

## MCP tools worth knowing

**All 37 `browser_*` tools are deferred.** Calling one before its schema is
loaded fails with `InputValidationError`. Pull the whole set in one round trip
first — `ToolSearch` with `{query: "obscura browser", max_results: 40}` — not
one `select:` per tool.

`browser_navigate` has no timeout parameter, only `waitUntil`; the CLI's
`--timeout` has no MCP equivalent. When a page needs longer than the MCP tab
gives it, that page belongs to `ofetch --timeout` or to Playwright.

The names are self-describing; these are the ones that are easy to miss.

- `browser_extract` — give it `{field: css_selector}`, get a structured object
  back; `field[]` returns an array, `selector@attr` reads an attribute. One call
  replaces a snapshot plus hand-parsing. Reach for it first.
- `browser_interactive_elements` — every clickable/typeable element with a
  `ref`. Click by `ref` when the ref is fresh, by `selector` when it is not.
- `browser_storage_state` / `browser_set_storage_state` — export and restore
  cookies + localStorage + sessionStorage as one object. Log in once, reuse the
  session afterwards.
- `browser_count` — cheap existence and pagination probe.
- `browser_search`, `browser_wait_for_text` — locate or wait on rendered text.

## Where the MCP tools bite

Measured on 0.2.1 (`obscura mcp --stealth`) against live sites and a local
probe page. Every row is a reproduced failure, not a doc reading.

| Tool | Behaviour |
|---|---|
| `browser_console_messages` | **Returns nothing, ever.** Not for `console.log` at load on a local `file://` page, not for `console.error` fired from `browser_evaluate`, not for an uncaught `TypeError`. To read a page's console, patch it yourself (below) or use Playwright. |
| `browser_network_requests` | Loader traffic only — document, CSS, images, fonts, module scripts. `fetch`/`XHR` issued by page JS **never appear**, even when they succeed. Useless for watching an app's API calls. |
| `browser_evaluate` | Does not await promises — a `Promise` serializes to `{}`. Park the result: fire the call storing into `window.__x`, then read `window.__x` in a second call. |
| `browser_press_key` | Sends `keydown` + `keyup` only — no `keypress`, `code` is empty, `keyCode`/`which` are absent, `composed: false`. Handlers keyed on `keyCode === 13`, or listening across a shadow boundary, never fire. Prefer clicking the submit control. |
| `browser_type` / `browser_fill` | Dispatch `input` only (it does arrive as `isTrusted`), no key events. |
| `browser_fill_form` | A `submit_selector` that matches nothing is ignored silently — the reply is `Filled N fields.` either way. Verify the URL or title changed. |
| `browser_detect_forms` | Reports the labelled element, which on component libraries is the decorative wrapper input, not the one the framework binds. |
| refs | Go stale on far more than navigation — a plain `browser_evaluate` invalidated them (`unknown ref 'e4'`). Re-run `browser_snapshot` after anything. |
| scheme guard | `import()` of a `blob:` URL is refused (`Forbidden URL scheme 'blob' - only http, https, and file are allowed`). http(s) dynamic imports work. |

Reading the console anyway, when the failure happens after load:

```js
// call 1 — patch
(()=>{window.__c=[];['log','warn','error'].forEach(k=>{const o=console[k];
  console[k]=function(){window.__c.push(k+': '+[...arguments].map(a=>String(a&&a.stack||a)).join(' | '));
  return o.apply(console,arguments)}});return 'patched'})()
// call 2 — trigger the thing, call 3 — JSON.stringify(window.__c)
```

**Fill the input the framework binds, not the one that is labelled.** After a
fill, read the value back (or check for `ng-dirty` / the framework's own dirty
marker). A form that stays `ng-pristine` after a successful-looking fill means
the value went into a decorative sibling and the submit will do nothing.

## Build features

`default = []` — both features are opt-in, and which ones a given binary has
changes what it can do:

- `render` — screenshots, PDF, and the `browser_screenshot` / `browser_pdf` MCP
  tools. Without it those two tools are **absent from the tool list** (35 tools
  instead of 37) and `--screenshot` fails naming the feature.
- `stealth` — TLS impersonation and tracker blocking, on top of the fingerprint
  consistency `--stealth` gives on its own. It is not enough for an aggressive
  bot wall: `html.duckduckgo.com` answered a form POST with an image-checkbox
  anomaly challenge.

Official release archives and Docker images ship **with** rendering. What lacks
it is a bare `cargo install` with no `--features` — which is exactly how the
Homebrew formula builds, so a brew copy has neither feature. Note also that the
runtime `--stealth` flag needs a `render,stealth` build for the wreq/BoringSSL
transport; on a stock build it delivers much less than advertised.

To get both:

```bash
cargo install --git https://github.com/h4ckf0r0day/obscura --tag <tag> \
  obscura-cli --features stealth,render --locked
```

If the tool list comes back with 35 tools and no screenshot tool, the binary on
PATH is a featureless build. Homebrew is the usual way that happens — its copy
in `/opt/homebrew/bin` shadows `~/.cargo/bin` — but confirm with
`command -v obscura` and `cargo install --list` rather than assuming brew.

`install.sh` links this skill and checks that `obscura` is on PATH; it does
**not** register the MCP server. That is a separate `claude mcp add` in
`~/.claude.json`, and Claude Code fixes its tool list at session start — a
server registered mid-session has no callable tools until the session restarts.

## When a heavy page times out

obscura caps the script-execution phase at 30s so one hung page cannot stall a
worker. A heavy React/Vue/Angular SPA on a slow link can need longer just to
boot and fire its data requests — the symptom is a navigation timeout on a site
that loads fine in a real browser. Raise the budget rather than the navigation
timeout alone:

```bash
OBSCURA_SCRIPT_DEADLINE_MS=60000 ofetch --timeout 90 <url>
```

Related knobs: `OBSCURA_MODULE_BUDGET_MS` (3s per page-enhancing module),
`--v8-flags "--max-old-space-size=4096"` for `JavaScript heap out of memory`,
`OBSCURA_NETWORK_BODY_BUFFER_BYTES` (2 MiB default — larger response bodies are
not retained).

These are process environment variables, so they apply to `ofetch` and to a
`obscura scrape` run — **not** to the MCP server, which was started with the
session and cannot be re-tuned from inside it.

## When an app boots but breaks

The engine is stronger than "renders JS" suggests: it hydrates an Angular 21
app, honours `<base href>`, resolves http `import()`, and exposes IndexedDB,
`crypto.subtle`, `structuredClone`, `ResizeObserver`, `BroadcastChannel`,
`matchMedia`, `requestIdleCallback`. Cross-origin `fetch`/`XHR` and CORS work.

**The signal that a render failed rather than the page being short:** a dump
under ~100 bytes, or `document.body.innerText.length` near zero while
`document.scripts` is non-empty and the framework root (`<app-root>`,
`<a-root>`) sits empty in the DOM. `ofetch` now checks this itself — under
`--min-text` (default 100) it warns on stderr and exits 3 on a text dump.

That is exactly what makes the failure mode confusing: a big SPA can boot,
hydrate, and then die on one runtime difference, leaving a page that looks
merely empty. Real case — autodoc.ru renders its shell and its search box, but
the runtime config never reaches the app, so `config` is `null`, every route
draws its generic error card and the search box does nothing:

```
TypeError: Cannot read properties of null (reading 'authApi')
TypeError: Cannot read properties of undefined (reading 'robots')
```

Ruled out there, in order, before blaming the engine: bandwidth, `--stealth`
(same failure with `--no-stealth`), `<base href>` resolution, CORS, and the
network stack itself — a hand-written `fetch` to the same config URL from the
same page returned 200 and valid JSON.

Triage in that order, and when the app is still broken, either drop to its HTTP
API from inside the page (`fetch` works even when the app does not) or hand the
task to Playwright. Do not spend the session bisecting someone's bundle.

## Scraping manners

This is a scraper with TLS impersonation, so the restraint has to come from the
caller: one page at a time unless the job genuinely needs `scrape`, a sane
`--concurrency`, and no re-fetching what is already sitting in `$TMPDIR/ofetch`.
Check `robots.txt` and the site's terms before a sweep, keep off anything behind
a login you were not given, and treat a bot wall (a challenge page, a 403 that
a browser does not get) as an answer rather than an obstacle to route around.

## What it is not

The project says so itself: obscura is not a bundled Chrome. Long-tail CSS,
service workers, some Web APIs, native media, GPU and compositor effects, PDF
structure and font rasterization can all differ from Chromium. PDF output is
raster-backed — no selectable text, tags, outlines, headers/footers, or full
CSS paged-media. Take any question about how a page *looks* to Playwright.

The upstream repo ships its own `skills/obscura/SKILL.md` covering build
variants and visual-regression methodology; this skill covers tool choice and
the doc/binary discrepancies instead.

## Common mistakes

- Reaching for `WebFetch` by reflex. The default reader for a URL is `ofetch`;
  `WebFetch` sees an un-executed HTML shell and drops the result into context
  whole.
- Dumping a rendered page straight into context instead of letting `ofetch`
  file it and grepping the file.
- Re-trying a 429 or a 403 through another entry point. Same engine, same
  answer — see above.
- Using `--selector` expecting a filtered result (see above).
- Trying `localhost` without `--local` and reading the SSRF refusal as the dev
  server being down.
- Believing an empty `browser_console_messages` or a short
  `browser_network_requests` — both are blind, not quiet.
- Filling the labelled input on a component-library form and never checking the
  value landed.
- Reaching for obscura to judge how a page *looks*. Its renderer is not
  Chromium; use Playwright for visual questions.
- Trying to search with it. It fetches URLs; it does not find them.
