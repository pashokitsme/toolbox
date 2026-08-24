# toolbox

Personal command-line tools and application configs that live on this machine.
This checkout is the source of truth: `install.sh` only creates symlinks into
`~/.local/bin` and `~/.config`, so editing a file here changes the installed
tool or config immediately — there is no build or copy step to remember.

**Each tool's own `--help` is its documentation.** Flags, keys, environment
variables and behavior belong there (or in the header comment for scripts
without a `--help`), so a user who has the tool installed never needs the repo.
`README.md` stays a one-line-per-tool index plus install instructions — when a
tool changes, update its `--help` first and only touch `README.md` if the
one-liner stopped being true.

## Layout

| Path | What goes there |
|------|-----------------|
| `bin/` | Everything that ends up on `PATH`. One self-contained script per tool, or a symlink into `lib/` for tools that span several files. |
| `lib/<tool>/` | Multi-file tools with their own dependencies (`package.json`, lockfile, config). |
| `config/<app>` | Application configs, one entry per `~/.config` name — a whole directory (`config/helix`) or a single file (`config/starship.toml`). |
| `install.sh` | Links `bin/*` into `$PREFIX/bin` (default `~/.local`) and `config/*` into `$XDG_CONFIG_HOME` (default `~/.config`), installs `lib/` dependencies, reports missing external commands. |

Adding a tool: drop a single executable file in `bin/`, or put the package in
`lib/<name>/` and symlink `bin/<name> -> ../lib/<name>/<entrypoint>`. Then
re-run `./install.sh`, make sure the tool explains itself under `--help`, and add
a one-line row to the `README.md` table. Nothing else knows about the tool list —
the script globs `bin/`.

Adding a config: move the real thing out of `~/.config` and into `config/` under
the same name, then `./install.sh --force`. Directories are linked whole, so
whatever the application writes inside them lands in this checkout — which is the
point, and also why a directory that holds machine-local state does not belong
here.

## install.sh

`bin/` and `config/` go through the same `link_tree`, so both behave the same
way. `--force` is needed when something real (not a link) already sits on a
target name — it may be the user's own copy, so it is moved to `<name>.bak`
rather than deleted, and a `<name>.bak` already in the way stops the entry.
`--dry-run` prints the plan; `--no-config` skips `~/.config` entirely.

Removal works off the destination directories, not off `bin/` and `config/`:
`--uninstall` globs `$PREFIX/bin` and the config directory, keeps every link
whose target lies inside this checkout and drops those — so an entry deleted from
the checkout still gets cleaned up. A plain install does the same sweep for links
that no longer resolve, which is what removing an entry leaves behind.

## Working on the tools

`lib/glab-mrs` is a Bun package — typecheck it with `bunx tsc --noEmit` from
inside that directory. Its files split as: `main.ts` (app: modes, key handling,
rendering), `term.ts` (colors, width-aware string ops, key decoding,
alternate-screen surface), `markdown.ts` (markdown→ANSI), `images.ts` (fetch,
sizing, terminal graphics protocols), `glab.ts` (every subprocess — `glab`, the
browser, the clipboard, the CI endpoints). It is on `PATH` twice: `bin/glab-mrs`
and `bin/glmr` are two links to the same `main.ts`, so the name it is called by
is not something the tool can read — `--help` spells both out by hand.

`bin/git-ai-commit` has a byte-identical twin in the `gramax-team` workspace as
`git-ai-commit.sh`, which predates this repo. Change it here.

`bin/tauri-win` and `bin/prl-win-run` only work together: the first cross-builds
and launches, the second is the cargo runner wired into `~/.cargo/config.toml`.
Touching one usually means checking the other.
