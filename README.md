# toolbox

Personal command-line tools and application configs. `install.sh` links `bin/*`
into `~/.local/bin` and `config/*` into `~/.config`, so this checkout is the live
copy — edit a file here and the installed tool or config changes with it.

```sh
./install.sh                    # link everything, install lib/ dependencies
./install.sh --dry-run          # print the plan, change nothing
./install.sh --force            # move whatever sits on a target name to <name>.bak
./install.sh --uninstall        # remove every link that points into this checkout
./install.sh --prefix /opt      # install tools under /opt/bin instead of ~/.local/bin
./install.sh --config-dir DIR   # link configs into DIR instead of ~/.config
./install.sh --no-config        # tools only, leave ~/.config alone
```

## Tools

| | |
|---|---|
| `glab-mrs` | Full-screen browser for GitLab merge requests and their pipelines: filter and read merge requests, watch job statuses, tail job logs, retry or cancel jobs and pipelines. |
| `git-ai-commit` | Stages everything, writes the commit message with Claude from the staged diff, commits and pushes. |
| `tauri-win` | Runs `tauri dev` for the Gramax desktop app cross-compiled to Windows, with the app itself running in a Parallels VM. |
| `prl-win-run` | The cargo runner behind `tauri-win`: executes a Windows binary inside the Parallels VM. Not called by hand. |

## Configs

Every entry of `config/` is linked into `~/.config` under the same name —
`ghostty`, `helix` and `zellij` as whole directories (so files an application
writes into its own directory land in this checkout), `starship.toml` as a single
file.

Each tool documents its own flags, keys and environment variables: run it with
`--help` (`glab-mrs --help`, `git-ai-commit --help`), or read the comment block
at the top of the file for the two Parallels scripts.
