# utils

Personal command-line tools that live on this machine. This checkout is the
source of truth: `install.sh` only creates symlinks into `~/.local/bin`, so
editing a file here changes the installed tool immediately — there is no build
or copy step to remember.

**What each tool does, how to call it and what it needs is in `README.md`.**
Keep that file current when tool behavior changes; this one covers the repo
itself.

## Layout

| Path | What goes there |
|------|-----------------|
| `bin/` | Everything that ends up on `PATH`. One self-contained script per tool, or a symlink into `lib/` for tools that span several files. |
| `lib/<tool>/` | Multi-file tools with their own dependencies (`package.json`, lockfile, config). |
| `install.sh` | Links `bin/*` into `$PREFIX/bin` (default `~/.local`), installs `lib/` dependencies, reports missing external commands. |

Adding a tool: drop a single executable file in `bin/`, or put the package in
`lib/<name>/` and symlink `bin/<name> -> ../lib/<name>/<entrypoint>`. Then
re-run `./install.sh` and give the tool a section in `README.md`. Nothing else
knows about the tool list — the script globs `bin/`.

## install.sh

`--force` is needed to replace a regular file that already sits on a target name
(it may be someone's own copy); `--dry-run` prints the plan.

Removal works off the install directory, not off `bin/`: `--uninstall` globs
`$PREFIX/bin`, keeps every link whose target lies inside this checkout and drops
those — so a tool deleted from `bin/` still gets cleaned up. A plain install does
the same sweep for links that no longer resolve, which is what removing a tool
from `bin/` leaves behind.

## Working on the tools

`lib/glab-mrs` is a Bun package — typecheck it with `bunx tsc --noEmit` from
inside that directory. Its files split as: `main.ts` (app: modes, key handling,
rendering), `term.ts` (colors, width-aware string ops, key decoding,
alternate-screen surface), `markdown.ts` (markdown→ANSI), `images.ts` (fetch,
sizing, terminal graphics protocols), `glab.ts` (every subprocess — `glab`, the
browser, the clipboard, the CI endpoints).

`bin/git-ai-commit` has a byte-identical twin in the `gramax-team` workspace as
`git-ai-commit.sh`, which predates this repo. Change it here.

`bin/tauri-win` and `bin/prl-win-run` only work together: the first cross-builds
and launches, the second is the cargo runner wired into `~/.cargo/config.toml`.
Touching one usually means checking the other.
