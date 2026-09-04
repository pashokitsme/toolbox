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
| `ofetch` | Renders a page in the obscura headless browser and saves it as markdown (or text, html, links, assets), printing the file path and a preview rather than the whole document — so an agent can grep out the part it needs. |
| `tauri-win` | Runs `tauri dev` for the Gramax desktop app cross-compiled to Windows, with the app itself running in a Parallels VM. |
| `prl-win-run` | The cargo runner behind `tauri-win`: executes a Windows binary inside the Parallels VM. Not called by hand. |

## Configs

Every entry of `config/` is linked into `~/.config` under the same name —
`ghostty`, `helix` and `zellij` as whole directories (so files an application
writes into its own directory land in this checkout), `starship.toml` as a single
file.

## Skills

Every entry of `skills/` is linked into `~/.claude/skills` under the same name,
so Claude picks it up in every project.

| | |
|---|---|
| `obscura` | When to use the obscura headless browser and `ofetch` over `WebFetch`, `WebSearch` or Playwright, which of the 37 `browser_*` MCP tools to reach for and which of them are quietly broken, and the places obscura's own docs disagree with the shipped binary. |

Each tool documents its own flags, keys and environment variables: run it with
`--help` (`glab-mrs --help`, `git-ai-commit --help`), or read the comment block
at the top of the file for the two Parallels scripts.
