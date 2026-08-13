# utils

Personal command-line tools. `install.sh` links `bin/*` into `~/.local/bin`, so
this checkout is the live copy — edit a file here and the installed tool changes
with it.

```sh
./install.sh                # link everything, install lib/ dependencies
./install.sh --dry-run      # print the plan, change nothing
./install.sh --force        # replace regular files sitting on a tool's name
./install.sh --uninstall    # remove every link that points into this checkout
./install.sh --prefix /opt  # install under /opt/bin instead of ~/.local/bin
```

## `glab-mrs` — merge request and pipeline browser (TypeScript, Bun)

Full-screen terminal UI over `glab`. Arguments pass straight through to
`glab mr list`, so any filter that command understands works:

```sh
glab-mrs --author @me
glab-mrs --all --search openapi -P 100
glab-mrs -R ics/doc-reader --reviewer @me
```

- **List** — merge requests with a pipeline dot (cyan running, green passed, red
  failed, gray canceled, dim circle none) and the number colored by state.
  Pipeline statuses load asynchronously: one `projects/:id/pipelines` page covers
  most rows, the rest are looked up per merge request.
- **Detail** — the description rendered as markdown (headings, lists, tables,
  quotes, code highlighted through `bat` when present) with inline images via the
  kitty or iTerm2 graphics protocol.
- **Pipeline jobs** — jobs grouped by stage with status, duration and failure
  reason; job logs; retry a job or the whole pipeline; cancel either; start a
  manual job. Every mutation asks `y/n` first. Auto-refreshes every 5s while
  something is running.
- **Copy** — `y` puts "title + link" on the clipboard as a rich hyperlink (with a
  plain-text fallback), `Y` as markdown.

Keys are modal: letters are commands, filtering lives behind `/`. Nothing needs
ctrl or cmd, and arrows work everywhere `hjkl` do.

| | |
|---|---|
| merge requests | `j k` move · `l` open · `p` pipeline · `o` browser · `y`/`Y` copy · `/` filter · `u` reload · `?` help · `q` quit |
| merge request | `j k` scroll · `space` page · `g G` ends · `p` pipeline · `o` browser · `h` back |
| pipeline jobs | `j k` move · `l` log · `r` retry job · `R` retry pipeline · `x` cancel job · `X` cancel pipeline · `s` start manual · `u` refresh · `o`/`O` browser · `h` back |
| job log | `j k` scroll · `g G` ends · `u` refresh · `o` browser · `h` back |

Commands match the *physical* key, so a Cyrillic layout keeps working (`о` is
`j`, `з` is `p`, `й` is `q`): terminals speaking the kitty keyboard protocol
report the real base-layout key, the rest go through a ЙЦУКЕН→QWERTY position
table.

Needs `bun` and an authenticated `glab`; the rich-link clipboard is macOS-only
(`textutil`, `osascript`, `pbcopy`). Optional: `bat` for code highlighting, a
terminal with kitty or iTerm2 graphics for images.

Environment: `GLAB_MRS_IMAGES=off`, `GLAB_MRS_IMAGE_PROTOCOL=kitty|iterm|none`,
`GLAB_MRS_KITTY_KEYS=off`.

## `git-ai-commit` — stage, write the message with Claude, commit, push (bash)

Stages everything, feeds the staged diff to `claude -p` (Haiku by default) to
write the commit message, shows it for confirmation, commits and pushes. The
positional argument seeds the *why*; the model still reads the whole diff. On a
rejected push it offers `git pull --rebase` and a retry; a missing upstream is
fixed with `push -u`.

```sh
git-ai-commit "why this change exists"
git-ai-commit -n                 # generate and print only
git-ai-commit -y --no-push       # commit without asking, stay local
git-ai-commit --amend -m sonnet  # amend, different model
```

Needs `git` and the `claude` CLI. Model override: `AI_COMMIT_MODEL`.

## `tauri-win` — Gramax tauri dev for Windows, app runs in Parallels (bash)

Run from anywhere inside the gramax repo (worktrees included). Cross-compiles
`apps/tauri` for `x86_64-pc-windows-msvc` with clang-cl plus xwin headers and
`rust-lld`, refreshes a `netsh portproxy` inside the VM so guest
`localhost:5173` reaches the Mac's vite, then runs `cargo tauri dev`.

Two decisions that look odd, both deliberate: `devUrl` stays `localhost` because
the app's `ALLOWED_DOMAINS` holds no raw IPs and overriding it would force a rust
rebuild whenever the Mac's IP changes; the host IP comes from `en0/en1/en2`
rather than the Parallels bridge because a LAN or VPN route can shadow the
`10.211.55/24` subnet.

Needs `prlctl` (Parallels), nightly `cargo` with `cargo-tauri`, `~/.xwin/splat`
and Homebrew `llvm`. VM name override: `PARALLELS_VM` (default `Windows 11`).

## `prl-win-run` — cargo runner for Windows binaries (bash)

Translates a Mac path into a `\\Mac\Home\…` UNC path and runs the binary inside
the Parallels VM, killing the guest process when the runner dies (tauri dev
restarts it on every rebuild). Not called by hand — it is wired into
`~/.cargo/config.toml` as the runner for `x86_64-pc-windows-msvc`, which is what
lets `tauri-win` launch anything. It lives here because the two are useless
apart.
