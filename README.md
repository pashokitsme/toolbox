# toolbox

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

## Tools

| | |
|---|---|
| `glab-mrs` | Full-screen browser for GitLab merge requests and their pipelines: filter and read merge requests, watch job statuses, tail job logs, retry or cancel jobs and pipelines. |
| `git-ai-commit` | Stages everything, writes the commit message with Claude from the staged diff, commits and pushes. |
| `tauri-win` | Runs `tauri dev` for the Gramax desktop app cross-compiled to Windows, with the app itself running in a Parallels VM. |
| `prl-win-run` | The cargo runner behind `tauri-win`: executes a Windows binary inside the Parallels VM. Not called by hand. |

Each tool documents its own flags, keys and environment variables: run it with
`--help` (`glab-mrs --help`, `git-ai-commit --help`), or read the comment block
at the top of the file for the two Parallels scripts.
