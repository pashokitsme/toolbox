# toolbox

Personal command-line tools and application configs. `install.sh` links `bin/*`
into `~/.local/bin`, `config/*` into `~/.config` and `skills/*` into
`~/.claude/skills`, so this checkout is the live copy — edit a file here and the
installed tool, config or skill changes with it.

```sh
./install.sh                    # link everything, install lib/ dependencies and adoc
./install.sh --dry-run          # print the plan, change nothing
./install.sh --force            # move whatever sits on a target name to <name>.bak
./install.sh --uninstall        # remove every link that points into this checkout
./install.sh --prefix /opt      # install tools under /opt/bin instead of ~/.local/bin
./install.sh --config-dir DIR   # link configs into DIR instead of ~/.config
./install.sh --no-config        # tools only, leave ~/.config alone
./install.sh --no-skills        # leave ~/.claude/skills alone
```

## Tools

| | |
|---|---|
| `glab-mrs` | Full-screen browser for GitLab merge requests and their pipelines: filter and read merge requests, watch job statuses, tail job logs, retry or cancel jobs and pipelines. Give it a link or a number to open that one merge request, `-y` to copy its link and be done. |
| `glmr` | `glab-mrs` under a shorter name — the same tool, for `glmr 3614`. |
| `adoc` | Car parts off autodoc.ru without a browser: search by part number or name, product card with rating and reviews, seller prices and delivery times, and your own basket, favorites and orders. Not linked from here — [its own tool](https://github.com/pashokitsme/adoc), which `install.sh` installs with `bun install -g`. |
| `ccp` | Claude Code account profiles: several logins on this machine that share everything else — sessions, settings, skills, plugins — so moving between accounts is `ccp use <name>` instead of logging out and back in. Switches the command line and the Claude Desktop app together (the app restarts). Needs `eval "$(ccp --shell-init)"` in `~/.zshrc`, a one-time `ccp migrate <name>` with Claude quit, and one login per profile in each. |
| `git-ai-commit` | Stages everything, writes the commit message with Claude from the staged diff, commits and pushes. |
| `mcz` | Shrinks photos and videos with ImageMagick and ffmpeg: pick them in a full-screen list or the macOS file dialog, or name them on the command line, and get `name.compressed.ext` beside each — EXIF dropped, color profile kept, and only when it came out smaller. Profiles `fast` and `small`, tuned in `mcz.toml`. |
| `ofetch` | Renders a page in the obscura headless browser and saves it as markdown (or text, html, links, assets), printing the file path and a preview rather than the whole document — so an agent can grep out the part it needs. |
| `tauri-win` | Runs `tauri dev` for the Gramax desktop app cross-compiled to Windows, with the app itself running in a Parallels VM. |
| `prl-win-run` | The cargo runner behind `tauri-win`: executes a Windows binary inside the Parallels VM. Not called by hand. |

## Configs

Every entry of `config/` is linked into `~/.config` under the same name —
`ghostty`, `helix` and `zellij` as whole directories (so files an application
writes into its own directory land in this checkout), `starship.toml` and
`mcz.toml` as single files.

## Skills

Every entry of `skills/` is linked into `~/.claude/skills` under the same name,
so Claude picks it up in every project.

| | |
|---|---|
| `obscura` | When to use the obscura headless browser and `ofetch` over `WebFetch`, `WebSearch` or Playwright, which of the 37 `browser_*` MCP tools to reach for and which of them are quietly broken, and the places obscura's own docs disagree with the shipped binary. |

## Raycast

| | |
|---|---|
| `GitLab: MR Name` | A script command in `raycast/`: a merge request link in, the same link titled with the merge request's name out, on the clipboard — `glmr -y` from Raycast. |
| `GitLab: Show MRs` | An extension in `lib/raycast-gitlab`: merge requests of a project, projects in the order you last opened them, filters by people, state, draft and pipeline, details in a side panel, ⌘C for a titled link. A merge request link pasted into its search turns into that merge request. |

`install.sh` leaves Raycast alone. For `GitLab: MR Name`, add `raycast/` once
under Settings → Extensions → Script Commands → Add Script Directory; to have it
take a link pasted straight into the root search, run Manage Fallback Commands
and enable it there.

`GitLab: Show MRs` reads hosts and tokens from glab's own config, so a host
shows up once `glab auth login --hostname <host>` has saved a token for it (a
token kept in the keychain is not seen). To put the extension into Raycast:

```sh
cd lib/raycast-gitlab
bun install        # ./install.sh does this too
bun run dev        # imports the extension; it stays after ⌃C
```

| Keys in Show MRs | |
|---|---|
| ↵ | details of the merge request in a side panel |
| ⌘C / ⌘⇧C | copy a link titled with the merge request's name / the same as markdown |
| ⇧↵ | open in the browser |
| ⌘1 / ⌘2 | only merge requests by me / by Claude — again to clear |
| ⌘F | state, draft, pipeline, reviewer, assignee, or any author |
| ⌘R | refresh |

Claude's GitLab username (`claude` unless set) is in the extension's
preferences in Raycast.

Each tool documents its own flags, keys and environment variables: run it with
`--help` (`glab-mrs --help`, `git-ai-commit --help`), or read the comment block
at the top of the file for the two Parallels scripts.
