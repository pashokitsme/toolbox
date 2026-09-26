# rescue-usb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the user's global instructions rule out subagent-driven-development; bounded edits may go to `caveman:cavecrew-builder`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SystemRescue-based ISO for a Ventoy stick with my packages, configs, toolbox, tailscale and Claude Code baked in, built by one script locally (Docker on the Mac) and in GitHub Actions, smoke-tested in QEMU.

**Architecture:** `iso/rescue-usb/build.sh` downloads and verifies the latest SystemRescue ISO, unpacks its ISO tree with SystemRescue's own `sysrescue-customize`, unsquashes `airootfs.sfs`, lays `rootfs/` and a clone of this toolbox commit over it, runs `chroot.sh` inside it (packages from SystemRescue's archive snapshot, tailscaled, firewall, XFCE terminal, Claude Code, `install.sh`), repacks and rebuilds the ISO. A smoke check baked into the image runs when the kernel command line carries `rescue_usb_smoke=1`; `qemu.sh --smoke` boots the ISO that way and reads the verdict off the serial console.

**Tech Stack:** bash, SystemRescue 13.02 (Arch, XFCE), squashfs-tools, xorriso (libisoburn), arch-install-scripts, gnupg, Docker Desktop (Rosetta, `linux/amd64`), QEMU (`qemu-system-x86_64`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-26-rescue-usb-design.md`

## Global Constraints

- No secrets anywhere in the repository or the image: no auth keys, no tokens; `tailscale up` and the Claude login happen by hand. The Mac's `~/.zshrc` keeps every exported token and is never copied, printed or committed.
- Packages come only from SystemRescue's archive snapshot (`archive.archlinux.org`); the build stops if `pacman` points anywhere else.
- Signature check: `gpg --verify` must report primary key `0FF11AF081E98345594812037091115F8320B897` (release signed by subkey `62989046EB5C7E985ECDF5DD3B0FEA9BE13CA3C9`); anything else stops the build.
- SystemRescue version: newest tag of `gitlab.com/systemrescue/systemrescue-sources` unless one is passed.
- Root filesystem compression: `-comp xz -Xbcj x86 -b 512k -Xdict-size 512k`; `FAST=1` → `-comp zstd -Xcompression-level 5`.
- Output name: `rescue-usb-<ver>-<yyyy-mm-dd>.iso`.
- Toolbox in the image: clone of the built commit at `/root/toolbox`, `origin` = `https://github.com/pashokitsme/toolbox`.
- CI: `workflow_dispatch` only, ISO as a workflow artifact, no releases.
- Everything user-facing in the repo follows CLAUDE.md: script header comments are the documentation, README gets one row.
- Unpacking happens on a Linux filesystem (Docker volume / runner disk), never on the Mac's case-insensitive APFS.

## Review Focus

- A new SystemRescue release moves or renames something the build edits (LOGDROP rule, XFCE launcher, helpers.rc, pacman mirrorlist) → the build must stop with a message naming the file, not ship an image missing the change. Pinned by the `die` asserts in `chroot.sh` (Task 4) and the smoke check (Task 3).
- ghostty cannot get an OpenGL context (QEMU's std VGA, old GPUs) → the terminal shortcut and panel launcher still open a terminal (xfce4-terminal). Pinned by the interactive QEMU check in Task 5.
- The Mac's fresh shell after the zshrc split → same aliases, functions, PATH entries and exported variable names as before, nothing on stderr. Pinned by the before/after comparison in Task 2.
- A cached ISO that was tampered with or truncated → `build.sh` refuses it instead of re-using it. Pinned by the `--verify-only` negative test in Task 4.
- A shell where some zshrc tool is missing (e.g. no zoxide) → `cd`, `ls`, `cat`, `grep` keep working as the builtins/originals. Pinned by the Linux container check in Task 2.

---

### Task 1: `install.sh --no-adoc`, and a failing adoc install is a warning

(The user: adoc is not needed in the image. `--no-adoc` skips both the bun install and the skill; the gh fix stays because it was asked for separately.)

**Files:**
- Modify: `install.sh` (header options list, `usage` line range, option parsing, the adoc block)

**Interfaces:**
- Consumes: nothing.
- Produces: `install.sh --no-adoc` touches neither `bun install -g …adoc` nor `gh skill install …adoc` (`chroot.sh`, Task 4, calls `./install.sh --no-adoc`); without the flag, a failure of either prints a `  warn     …` line and the run still exits 0.

Second test, `$SCRATCH/test-install-noadoc.sh`, with a fake `bun` that records its arguments and a PATH without the real `~/.bun/bin` (so `adoc` is not found and the install branch is reached):

```bash
#!/usr/bin/env bash
# --no-adoc must not try to install adoc or its skill; without it, it must.
set -u
t=$(mktemp -d); mkdir -p "$t/fakebin"
printf '#!/bin/sh
echo "$*" >>%s/bun.calls
' "$t" >"$t/fakebin/bun"
printf '#!/bin/sh
echo "$*" >>%s/gh.calls
' "$t" >"$t/fakebin/gh"
chmod +x "$t/fakebin/"*
run() { PATH="$t/fakebin:/usr/bin:/bin" /Users/pavel.smirnov/Source/repos/toolbox/install.sh \
	--prefix "$t/prefix" --config-dir "$t/config" --skills-dir "$t/skills" "$@" >"$t/log" 2>&1; }
run; code1=$?
with=$(cat "$t/bun.calls" "$t/gh.calls" 2>/dev/null | grep -c adoc)
rm -f "$t/bun.calls" "$t/gh.calls"
run --no-adoc; code2=$?
without=$(cat "$t/bun.calls" "$t/gh.calls" 2>/dev/null | grep -c adoc)
echo "plain: exit=$code1 adoc-calls=$with; --no-adoc: exit=$code2 adoc-calls=$without"
rm -rf "$t"
[ "$code1" = 0 ] && [ "$with" = 2 ] && [ "$code2" = 0 ] && [ "$without" = 0 ]
```

RED expectation: `--no-adoc` is an unknown option → `exit=2`. GREEN: `plain: exit=0 adoc-calls=2; --no-adoc: exit=0 adoc-calls=0`.

Implementation: header line `#       --no-adoc        Skip installing adoc and its agent skill` after `--no-skills`; `usage` prints `2,25p`; `WITH_ADOC=1` default, `--no-adoc) WITH_ADOC=0 ;;`; the adoc block becomes `if [ "$WITH_ADOC" = 0 ]; then :; elif command -v adoc …` and the skill condition gains `[ "$WITH_ADOC" = 1 ] &&`.

- [ ] **Step 1: Write the failing test**

Scratch script `$SCRATCH/test-install-gh.sh` (not committed; `$SCRATCH` is the session scratchpad):

```bash
#!/usr/bin/env bash
# install.sh must finish when gh is present but cannot install the adoc skill.
set -u
t=$(mktemp -d)
mkdir -p "$t/fakebin"
printf '#!/bin/sh\necho "gh: not logged in" >&2\nexit 1\n' >"$t/fakebin/gh"
chmod +x "$t/fakebin/gh"
PATH="$t/fakebin:$PATH" /Users/pavel.smirnov/Source/repos/toolbox/install.sh \
	--prefix "$t/prefix" --config-dir "$t/config" --skills-dir "$t/skills" >"$t/log" 2>&1
code=$?
grep -q 'warn .*adoc skill' "$t/log" && warned=1 || warned=0
echo "exit=$code warned=$warned"
rm -rf "$t"
[ "$code" = 0 ] && [ "$warned" = 1 ]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash $SCRATCH/test-install-gh.sh`
Expected: `exit=1 warned=0` and a non-zero exit.

- [ ] **Step 3: Make both adoc installs non-fatal**

In `install.sh` replace

```bash
	run bun install -g github:pashokitsme/adoc
fi
```

with

```bash
	run bun install -g github:pashokitsme/adoc ||
		say "  warn     adoc did not install — run ./install.sh again later"
fi
```

and

```bash
	run gh skill install pashokitsme/adoc adoc --agent claude-code --scope user --force
fi
```

with

```bash
	run gh skill install pashokitsme/adoc adoc --agent claude-code --scope user --force ||
		say "  warn     the adoc skill did not install — is gh logged in? (gh auth status)"
fi
```

Also update the comment above them to: `# … Both are skipped when their command is missing, and a failed install is a warning, not the end of the run — gh may simply not be logged in yet.`

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash $SCRATCH/test-install-gh.sh`
Expected: `exit=0 warned=1`.

Also: `./install.sh --dry-run >/dev/null && echo ok` → `ok`.

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "fix(install): a failed adoc install warns instead of aborting"
```

---

### Task 2: portable zshrc in toolbox, Mac `~/.zshrc` sources it, ghostty font fallback

**Files:**
- Create: `config/zsh/zshrc`
- Modify: `config/ghostty/config:15` (add a line after `font-family = menlo`)
- Modify (outside the repo, backed up first): `~/.zshrc`

**Interfaces:**
- Consumes: Task 1 (`install.sh` links `config/zsh` → `~/.config/zsh`).
- Produces: `~/.config/zsh/zshrc`, sourced by the Mac's `~/.zshrc` and by the image's `/root/.zshrc` (Task 3). Tools it expects on Linux: `zsh-syntax-highlighting`, `zsh-autosuggestions`, `starship`, `zoxide`, `eza`, `bat`, `ripgrep`, `lazygit`, `bun`, `helix`, `ccp` — every one optional.

- [ ] **Step 1: Capture the Mac shell as it is now**

Values never reach the terminal — only names and hashes are compared later.

Shell functions do not survive between tool calls, so the snapshot is a script, `$SCRATCH/zsh-snap.sh`:

```bash
#!/usr/bin/env bash
# zsh-snap.sh DIR — a fresh login shell's aliases, functions, PATH and variable
# names (never values) into DIR
d=$1; mkdir -p "$d"
env -i HOME="$HOME" TERM=xterm-256color USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
	zsh -l -i -c 'alias | sort >'"$d"'/aliases; print -l ${(ok)functions} >'"$d"'/functions; print -l $path >'"$d"'/path; env | cut -d= -f1 | sort >'"$d"'/envnames; env | sort | shasum >'"$d"'/envhash' \
	2>"$d/stderr"
```

```bash
S=$SCRATCH/zsh-before; bash $SCRATCH/zsh-snap.sh $S; wc -l $S/*
```

Expected: files populated; `$S/stderr` may already have lines — note them, they are the baseline.

- [ ] **Step 2: Write `config/zsh/zshrc`**

```zsh
# Shell setup shared by every machine. The Mac sources it from ~/.zshrc, which
# keeps what must not be in a public repository (tokens, work variables) and
# what only exists there (Homebrew, Xcode, emsdk); the rescue-usb image makes it
# root's whole ~/.zshrc. A missing tool is skipped, never an error at shell start.

case "$OSTYPE" in
	darwin*) __zsh_plugins=/opt/homebrew/share
		fpath=($fpath /opt/homebrew/share/zsh/site-functions/) ;;
	*) __zsh_plugins=/usr/share/zsh/plugins ;;
esac

autoload -Uz compinit && compinit
zstyle ':completion::complete:*' use-cache 1
export ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=#757575'

bindkey "^[[1;3D" backward-word   # cmd+← / alt+←
bindkey "^[[1;3C" forward-word    # cmd+→ / alt+→

path=("$HOME/.local/bin" "$HOME/.bun/bin" $path)
typeset -U path

(( $+commands[ccp] )) && eval "$(ccp --shell-init)"

# aliases — the ones that shadow a standard command only when the replacement exists
(( $+commands[eza] )) && alias ls="eza -A -s type"
(( $+commands[bat] )) && alias cat="bat -p"
(( $+commands[rg] )) && alias grep="rg"
(( $+commands[lazygit] )) && alias lg="lazygit"
(( $+commands[bun] )) && alias npm="bun"
alias cls="clear"
alias clear="clear && printf '\033[3J'"
alias rmf="rm -rf"
alias claude="claude --allow-dangerously-skip-permissions --dangerously-skip-permissions"

[ -r "$__zsh_plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ] &&
	source "$__zsh_plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
(( $+commands[starship] )) && source <(starship init zsh --print-full-init)
if (( $+commands[zoxide] )); then
	eval "$(zoxide init zsh)"
	alias cd="z"
fi
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"
[ -r "$__zsh_plugins/zsh-autosuggestions/zsh-autosuggestions.zsh" ] &&
	source "$__zsh_plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
unset __zsh_plugins

export _ZO_DOCTOR=0
export EDITOR=hx
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

function reload() {
	source ~/.zshrc
}

function ffmpeg-compress() {
	ffmpeg -i $1 -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k $2
}

function magick-compress() {
	magick $1 -strip -interlace Plane -gaussian-blur 0.05 -quality 85% $2
}

function rustfmt-init() {
	cp ~/.config/rustfmt.toml .
}
```

- [ ] **Step 3: Link it and rewrite the Mac `~/.zshrc`**

```bash
./install.sh            # links config/zsh -> ~/.config/zsh
ls -l ~/.config/zsh     # -> …/toolbox/config/zsh
cp -p ~/.zshrc ~/.zshrc.bak
```

Edit `~/.zshrc` with the Edit tool (never print the file to the transcript again):
- Delete the lines now in the shared file: the `fpath=…site-functions` line, `compinit`, the `zstyle`, `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE`, both `bindkey` lines, `eval "$(ccp --shell-init)"`, `export PATH="…/.bun/bin:$PATH"`, the whole `# aliases` block (`ls` … `claude`), the `zsh-syntax-highlighting` source, the starship source, `zoxide init`, the `_bun` source, the `zsh-autosuggestions` source, `_ZO_DOCTOR`, `EDITOR`, the functions `reload`, `ffmpeg-compress`, `magick-compress`, `rustfmt-init`, and the final `LANG`/`LC_ALL` exports.
- Right after `eval "$(/opt/homebrew/bin/brew shellenv)"` insert:

```zsh
# the shell setup every machine shares (toolbox: config/zsh/zshrc)
source ~/.config/zsh/zshrc
```

- Everything else stays where it is: `HOMEBREW_*`, `HELIX_RUNTIME`, `DOTNET_ROOT`, `AR`/`RANLIB`, every token export, `apksigner`, `enable-/disable-docportal`, llvm/`SDKROOT`/emsdk/libffi, solana, `kill-audio`, `NODE_TLS_REJECT_UNAUTHORIZED`, the Antigravity `PATH` line.

- [ ] **Step 4: Compare the Mac shell with the baseline**

```bash
A=$SCRATCH/zsh-after; bash $SCRATCH/zsh-snap.sh $A
for f in aliases functions envnames; do diff -u $S/$f $A/$f && echo "$f same"; done
diff <(sort -u $S/path) <(sort -u $A/path) && echo "path entries same"
diff $S/path $A/path >/dev/null || echo "path ORDER differs — inspect: diff $S/path $A/path"
diff $S/stderr $A/stderr && echo "stderr same"
```

Expected: `aliases same`, `functions same`, `envnames same`, `path entries same`, `stderr same`. A `path ORDER differs` line is inspected by eye (`~/.local/bin` and `~/.bun/bin` moving earlier, and duplicates gone through `typeset -U path`, are acceptable). `envhash` may differ only if a value changed — if it does, compare `env` of both shells by name only to find which (`comm -3` on `env | sort` would print values; don't).

- [ ] **Step 5: Check the shared file on Linux, with and without the tools**

```bash
docker run --rm --platform linux/amd64 -v "$PWD/config/zsh:/z:ro" archlinux:latest bash -c '
	pacman -Sy --noconfirm zsh >/dev/null 2>&1
	echo "--- bare"; HOME=/tmp zsh -i -c "source /z/zshrc; alias cd ls cat grep; type cd" 2>&1
	pacman -S --noconfirm zsh-syntax-highlighting zsh-autosuggestions starship zoxide eza bat ripgrep lazygit >/dev/null 2>&1
	echo "--- full"; HOME=/tmp zsh -i -c "source /z/zshrc; alias cd ls cat grep" 2>&1'
```

Expected: `--- bare` shows no aliases for cd/ls/cat/grep, `cd is a shell builtin`, no error lines; `--- full` shows `cd=z`, `ls='eza -A -s type'`, `cat='bat -p'`, `grep=rg`, no error lines.

- [ ] **Step 6: ghostty font fallback**

After `font-family = menlo` in `config/ghostty/config` add:

```
font-family = JetBrainsMono Nerd Font
```

Check: `/Applications/Ghostty.app/Contents/MacOS/ghostty +validate-config` → no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add config/zsh/zshrc config/ghostty/config
git commit -m "feat(config): shared zshrc for every machine, ghostty font fallback for Linux"
```

---

### Task 3: image contents — packages, overlay files, boot YAML, signing key, smoke check

**Files:**
- Create: `iso/rescue-usb/packages.txt`
- Create: `iso/rescue-usb/systemrescue-signing-key.pem`
- Create: `iso/rescue-usb/sysrescue.d/500-toolbox.yaml`
- Create: `iso/rescue-usb/rootfs/root/.zshrc`
- Create: `iso/rescue-usb/rootfs/root/.zshenv`
- Create: `iso/rescue-usb/rootfs/etc/X11/xorg.conf.d/00-keyboard.conf`
- Create: `iso/rescue-usb/rootfs/usr/local/bin/rescue-terminal`
- Create: `iso/rescue-usb/rootfs/root/.local/share/xfce4/helpers/custom-TerminalEmulator.desktop`
- Create: `iso/rescue-usb/rootfs/usr/local/lib/rescue-usb/smoke`
- Create: `iso/rescue-usb/rootfs/etc/systemd/system/rescue-usb-smoke.service`
- Modify: `.gitignore` (add `iso/rescue-usb/out/`)

**Interfaces:**
- Consumes: Task 2's `config/zsh/zshrc` (sourced by `/root/.zshrc`).
- Produces: `packages.txt` (one package per line, `#` comments) read by `chroot.sh`; `rootfs/` copied verbatim over the image root by `build.sh`; `/usr/local/lib/rescue-usb/smoke` printing `SMOKE OK` or `SMOKE FAILED (<n>)` as its last line, run by `rescue-usb-smoke.service` when the kernel command line has `rescue_usb_smoke=1`, output on `/dev/ttyS0`, then poweroff; `/usr/local/bin/rescue-terminal` used by `chroot.sh`'s XFCE edits.

- [ ] **Step 1: `packages.txt`**

```
# Packages rescue-usb adds on top of SystemRescue, one per line.
# They come from SystemRescue's archive snapshot, so every one of them must
# exist in Arch's repositories on that SystemRescue release's date.

# network
tailscale
wireshark-cli
nethogs
arp-scan
lldpd
mosh

# disks
fio
gdu

# everyday
ghostty
helix
zellij
starship
btop
fzf
ripgrep
fd
bat
eza
git-delta
github-cli
glab
bun
jq
ttf-jetbrains-mono-nerd

# what config/zsh/zshrc uses
zsh-syntax-highlighting
zsh-autosuggestions
zoxide
lazygit
ffmpeg
imagemagick
```

Check every name against the snapshot SystemRescue 13.02 used (the `extra-0728.db` already in `$SCRATCH`, plus `core`):

```bash
curl -s -o $SCRATCH/core-0728.db https://archive.archlinux.org/repos/2026/07/28/core/os/x86_64/core.db
for p in $(grep -v '^\s*#' iso/rescue-usb/packages.txt); do
	tar -tzf $SCRATCH/extra-0728.db | grep -q "^$p-[0-9][^/]*-[0-9]*/\$" ||
	tar -tzf $SCRATCH/core-0728.db | grep -q "^$p-[0-9][^/]*-[0-9]*/\$" || echo "MISSING $p"
done; echo checked
```

Expected: only `checked`.

- [ ] **Step 2: signing key**

```bash
curl -fsSL -o iso/rescue-usb/systemrescue-signing-key.pem \
	https://www.system-rescue.org/security/signing-keys/gnupg-pubkey-fdupoux-20210704-v001.pem
g=$(mktemp -d); gpg --homedir $g --batch --import iso/rescue-usb/systemrescue-signing-key.pem 2>/dev/null
gpg --homedir $g --with-colons --fingerprint | grep '^fpr' | cut -d: -f10; rm -rf $g
```

Expected: first line `0FF11AF081E98345594812037091115F8320B897`, and `62989046EB5C7E985ECDF5DD3B0FEA9BE13CA3C9` among the rest.

- [ ] **Step 3: boot YAML and overlay files**

`iso/rescue-usb/sysrescue.d/500-toolbox.yaml`:

```yaml
---
# rescue-usb: zsh for root and straight into XFCE on tty1
global:
    rootshell: "/bin/zsh"
    dostartx: true
```

`iso/rescue-usb/rootfs/root/.zshrc`:

```zsh
# the shell setup every machine shares (toolbox: config/zsh/zshrc)
source ~/.config/zsh/zshrc
```

`iso/rescue-usb/rootfs/root/.zshenv`:

```zsh
# Everything here runs as root. Claude Code refuses --dangerously-skip-permissions
# as root unless it is told it is in a sandbox — this live system is one.
export IS_SANDBOX=1
```

`iso/rescue-usb/rootfs/etc/X11/xorg.conf.d/00-keyboard.conf`:

```
# us + ru, switched with Super+Space (Cmd+Space on a Mac keyboard)
Section "InputClass"
	Identifier "system-keyboard"
	MatchIsKeyboard "on"
	Option "XkbLayout" "us,ru"
	Option "XkbOptions" "grp:win_space_toggle"
EndSection
```

`iso/rescue-usb/rootfs/usr/local/bin/rescue-terminal` (mode 755):

```sh
#!/bin/sh
# The terminal XFCE opens: ghostty, or xfce4-terminal when ghostty cannot start
# (no usable OpenGL — old GPUs, some virtual machines).
ghostty "$@" || exec xfce4-terminal "$@"
```

`iso/rescue-usb/rootfs/root/.local/share/xfce4/helpers/custom-TerminalEmulator.desktop`:

```
[Desktop Entry]
NoDisplay=true
Version=1.0
Encoding=UTF-8
Type=X-XFCE-Helper
X-XFCE-Category=TerminalEmulator
X-XFCE-Commands=/usr/local/bin/rescue-terminal
X-XFCE-CommandsWithParameter=/usr/local/bin/rescue-terminal -e "%s"
Icon=utilities-terminal
Name=Terminal
```

- [ ] **Step 4: smoke check and its unit**

`iso/rescue-usb/rootfs/usr/local/lib/rescue-usb/smoke` (mode 755):

```bash
#!/usr/bin/env bash
# rescue-usb smoke check: what the image adds on top of SystemRescue is there
# and works. One line per failure, then "SMOKE OK" or "SMOKE FAILED (<n>)".
# Runs at boot with rescue_usb_smoke=1 (rescue-usb-smoke.service); safe to run by hand.
set -u
export HOME=/root TERM=xterm-256color
export PATH="/root/.local/bin:/root/.bun/bin:$PATH"
failed=0
bad() { echo "FAIL $*"; failed=$((failed + 1)); }

for c in tailscale tailscaled tshark nethogs arp-scan lldpd mosh fio gdu \
	ghostty hx zellij starship btop fzf rg fd bat eza delta gh glab bun jq \
	zoxide lazygit ffmpeg magick claude ccp glab-mrs glmr git-ai-commit; do
	command -v "$c" >/dev/null || bad "command missing: $c"
done

systemctl is-active --quiet tailscaled || bad "tailscaled is not running"
iptables -S INPUT | grep -q -- '-i tailscale0 -j ACCEPT' || bad "iptables: tailscale0 not accepted"
ip6tables -S INPUT | grep -q -- '-i tailscale0 -j ACCEPT' || bad "ip6tables: tailscale0 not accepted"

# the sync databases are in the image: a package SystemRescue does not ship resolves without -Sy
pacman -Si nginx >/dev/null 2>&1 || bad "pacman sync database missing"

[ "$(git -C /root/toolbox remote get-url origin 2>/dev/null)" = https://github.com/pashokitsme/toolbox ] ||
	bad "/root/toolbox is not a toolbox clone"
claude --version >/dev/null 2>&1 || bad "claude does not run"

[ "$(getent passwd root | cut -d: -f7)" = /bin/zsh ] || bad "root shell is not zsh"
[ "$(zsh -c 'echo $IS_SANDBOX')" = 1 ] || bad "IS_SANDBOX is not set for root"
err=$(zsh -i -c exit 2>&1 >/dev/null)
[ -z "$err" ] || bad "zsh -i prints on stderr: $err"
aliases=$(zsh -i -c 'alias cd ls cat grep lg' 2>/dev/null)
for want in "cd=z" "ls='eza -A -s type'" "cat='bat -p'" "grep=rg" "lg=lazygit"; do
	grep -qxF "$want" <<<"$aliases" || bad "zsh alias missing: $want"
done
[ "$(zsh -i -c 'whence -w ccp' 2>/dev/null)" = "ccp: function" ] || bad "ccp shell function missing"

grep -q '^TerminalEmulator=custom-TerminalEmulator$' /root/.config/xfce4/helpers.rc ||
	bad "XFCE terminal is not rescue-terminal"
grep -q 'startx' /root/.zlogin 2>/dev/null || bad "X does not start on tty1 (dostartx)"

if [ "$failed" = 0 ]; then echo "SMOKE OK"; else echo "SMOKE FAILED ($failed)"; exit 1; fi
```

`iso/rescue-usb/rootfs/etc/systemd/system/rescue-usb-smoke.service`:

```ini
[Unit]
Description=rescue-usb smoke check (only with rescue_usb_smoke=1)
ConditionKernelCommandLine=rescue_usb_smoke=1
After=sysrescue-initialize-whilenet.service tailscaled.service iptables.service ip6tables.service
Wants=tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/rescue-usb/smoke
ExecStopPost=/usr/bin/systemctl poweroff --no-block
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyS0

[Install]
WantedBy=multi-user.target
```

(`chroot.sh` enables it; the condition keeps it inert on normal boots.)

- [ ] **Step 5: lint**

```bash
chmod 755 iso/rescue-usb/rootfs/usr/local/bin/rescue-terminal iso/rescue-usb/rootfs/usr/local/lib/rescue-usb/smoke
docker run --rm -v "$PWD/iso/rescue-usb:/r:ro" koalaman/shellcheck:stable \
	/r/rootfs/usr/local/lib/rescue-usb/smoke /r/rootfs/usr/local/bin/rescue-terminal
```

Expected: no findings. (The real run of `smoke` happens in Task 5.)

- [ ] **Step 6: Commit**

```bash
printf 'iso/rescue-usb/out/\n' >>.gitignore
git add .gitignore iso/rescue-usb/packages.txt iso/rescue-usb/systemrescue-signing-key.pem iso/rescue-usb/sysrescue.d iso/rescue-usb/rootfs
git commit -m "feat(rescue-usb): packages, overlay files and smoke check for the image"
```

---

### Task 4: `build.sh`, `chroot.sh`, `docker-build.sh` — a verified, customized ISO

**Files:**
- Create: `iso/rescue-usb/build.sh`
- Create: `iso/rescue-usb/chroot.sh`
- Create: `iso/rescue-usb/docker-build.sh`

**Interfaces:**
- Consumes: Task 3's `packages.txt`, `rootfs/`, `sysrescue.d/`, `systemrescue-signing-key.pem`; Task 1's non-fatal `install.sh`.
- Produces: `build.sh [--verify-only] [VERSION]` (runs as root in x86_64 Arch; env `WORK` default `/work`, `OUT` default `<dir>/out`, `FAST=1`) → `$OUT/rescue-usb-<ver>-<yyyy-mm-dd>.iso`, path printed on the last line as `==> done: <path>`; `docker-build.sh [build.sh args]` runs it on the Mac with `WORK` in docker volume `rescue-usb-work` and `OUT` = `iso/rescue-usb/out`.

- [ ] **Step 1: `build.sh`**

```bash
#!/usr/bin/env bash
# Builds the rescue-usb image: the newest SystemRescue with the packages,
# configs and tools from this directory baked in (see packages.txt, rootfs/,
# chroot.sh, sysrescue.d/). Runs as root inside an x86_64 Arch Linux container:
# docker-build.sh on a Mac, .github/workflows/rescue-usb.yml in CI.
#
#   build.sh [VERSION]              build; VERSION defaults to the newest SystemRescue
#   build.sh --verify-only [VERSION]  download and verify the SystemRescue ISO, nothing else
#
#   WORK=/work   scratch space, ~10 GB; the downloaded ISO is cached in $WORK/cache
#   OUT=…/out    where the finished ISO goes
#   FAST=1       zstd instead of xz for the root filesystem: quicker, ~20% bigger
#
# The SystemRescue ISO must carry a valid signature by Francois Dupoux's key
# (systemrescue-signing-key.pem, primary 0FF11AF0…8320B897), or nothing is built.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/work}"
OUT="${OUT:-$HERE/out}"
KEY_FPR=0FF11AF081E98345594812037091115F8320B897
CDN=https://fastly-cdn.system-rescue.org/releases
SOURCES=https://gitlab.com/systemrescue/systemrescue-sources
TAGS_API='https://gitlab.com/api/v4/projects/systemrescue%2Fsystemrescue-sources/repository/tags?per_page=20'
DEPS=(arch-install-scripts squashfs-tools libisoburn git jq gnupg rsync patch curl)
if [ -n "${FAST:-}" ]; then
	SFS_OPTS=(-comp zstd -Xcompression-level 5)
else
	SFS_OPTS=(-comp xz -Xbcj x86 -b 512k -Xdict-size 512k)
fi

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

latest_version() {
	curl -fsSL "$TAGS_API" | jq -r '.[].name' | grep -E '^[0-9]+\.[0-9]+$' | sort -V | tail -1
}

# fetch_verified VERSION — prints the path of a checksummed, signature-checked ISO
fetch_verified() {
	local ver=$1 iso="systemrescue-$1-amd64.iso" dir="$WORK/cache"
	mkdir -p "$dir"
	if [ ! -s "$dir/$iso" ]; then
		say "downloading $iso" >&2
		curl -fL --retry 3 -o "$dir/$iso.part" "$CDN/$ver/$iso"
		mv "$dir/$iso.part" "$dir/$iso"
	fi
	curl -fsSL -o "$dir/$iso.sha512" "$CDN/$ver/$iso.sha512"
	curl -fsSL -o "$dir/$iso.asc" "$CDN/$ver/$iso.asc"
	(cd "$dir" && sha512sum --quiet -c "$iso.sha512") >&2 ||
		die "$dir/$iso does not match its sha512 — delete it to download again"
	local gnupg status
	gnupg=$(mktemp -d)
	gpg --homedir "$gnupg" --batch --quiet --import "$HERE/systemrescue-signing-key.pem" 2>/dev/null
	status=$(gpg --homedir "$gnupg" --batch --status-fd 1 --verify "$dir/$iso.asc" "$dir/$iso" 2>/dev/null) ||
		{ rm -rf "$gnupg"; die "$iso: signature does not verify"; }
	rm -rf "$gnupg"
	grep -qE "^\[GNUPG:\] VALIDSIG .* $KEY_FPR\$" <<<"$status" ||
		die "$iso: signed, but not by $KEY_FPR"
	say "$iso: sha512 and signature ok" >&2
	printf '%s\n' "$dir/$iso"
}

cleanup() {
	[ -n "${ROOT:-}" ] && umount -R "$ROOT" 2>/dev/null || true
}

main() {
	local verify_only=
	[ "${1:-}" = --verify-only ] && { verify_only=1; shift; }
	case "${1:-}" in -h | --help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$0"; exit 0 ;; esac

	[ "$(id -u)" = 0 ] || die "run as root (inside the build container)"
	pacman -Syu --needed --noconfirm "${DEPS[@]}" >/dev/null

	local ver="${1:-}"
	[ -n "$ver" ] || ver=$(latest_version) || true
	[ -n "$ver" ] || die "could not find the newest SystemRescue version ($TAGS_API)"
	say "SystemRescue $ver"
	local iso
	iso=$(fetch_verified "$ver")
	[ -z "$verify_only" ] || return 0

	local build="$WORK/build" customize="$WORK/sysrescue-customize-$ver"
	[ -s "$customize" ] || curl -fsSL -o "$customize" "$SOURCES/-/raw/$ver/airootfs/usr/share/sysrescue/bin/sysrescue-customize"
	rm -rf "$build"
	mkdir -p "$build"
	bash "$customize" --unpack -s "$iso" -d "$build/iso"

	local sfs="$build/iso/filesystem/sysresccd/x86_64/airootfs.sfs"
	[ -f "$sfs" ] || die "no airootfs.sfs at $sfs — SystemRescue changed its layout"
	ROOT="$build/root"
	trap cleanup EXIT
	say "unpacking the root filesystem"
	unsquashfs -q -d "$ROOT" "$sfs"

	say "overlaying rootfs/ and the toolbox checkout"
	rsync -a --chown=root:root "$HERE/rootfs/" "$ROOT/"
	local repo
	repo=$(git -C "$HERE" rev-parse --show-toplevel)
	git -c safe.directory='*' clone --quiet --no-local "$repo" "$ROOT/root/toolbox"
	git -C "$ROOT/root/toolbox" remote set-url origin https://github.com/pashokitsme/toolbox
	install -m 0644 "$HERE/packages.txt" "$ROOT/tmp/rescue-usb-packages.txt"
	install -m 0755 "$HERE/chroot.sh" "$ROOT/tmp/rescue-usb-chroot.sh"

	say "customizing inside the image"
	mount --bind "$ROOT" "$ROOT"
	arch-chroot "$ROOT" /tmp/rescue-usb-chroot.sh /tmp/rescue-usb-packages.txt
	umount -R "$ROOT"
	rm -f "$ROOT"/tmp/rescue-usb-*

	say "repacking the root filesystem (${SFS_OPTS[*]})"
	rm "$sfs"
	mksquashfs "$ROOT" "$sfs" -noappend -quiet "${SFS_OPTS[@]}"
	(cd "$(dirname "$sfs")" && sha512sum airootfs.sfs >airootfs.sha512)
	rm -rf "$ROOT"

	install -m 0644 "$HERE"/sysrescue.d/*.yaml "$build/iso/filesystem/sysrescue.d/"
	mkdir -p "$OUT"
	local out
	out="$OUT/rescue-usb-$ver-$(date +%F).iso"
	rm -f "$out"
	bash "$customize" --rebuild -s "$build/iso" -d "$out"
	rm -rf "$build"
	say "done: $out"
}

main "$@"
```

- [ ] **Step 2: `chroot.sh`**

```bash
#!/usr/bin/env bash
# Runs inside the unpacked SystemRescue root — build.sh chroots into it.
#   chroot.sh PACKAGES_FILE
# Every edit of a SystemRescue file first checks the file still looks the way
# this script expects, and stops the build if not: a new SystemRescue release
# must fail loudly rather than ship an image that silently lacks a change.
set -euo pipefail
packages_file=$1
export HOME=/root

say() { printf '  -> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "pacman: archive snapshot only"
servers=$(pacman-conf --repo=extra Server)
[ -n "$servers" ] || die "pacman has no server for [extra]"
if grep -qv '^https://archive.archlinux.org/repos/' <<<"$servers"; then
	die "pacman does not point at the archive snapshot: $servers"
fi

say "installing packages"
mapfile -t packages < <(grep -v '^\s*\(#\|$\)' "$packages_file")
pacman -Sy --noconfirm
pacman -S --needed --noconfirm "${packages[@]}"

say "services"
systemctl enable tailscaled.service rescue-usb-smoke.service

say "firewall: accept tailscale0"
for f in /etc/iptables/iptables.rules /etc/iptables/ip6tables.rules; do
	grep -qx -- '-A INPUT -j LOGDROP' "$f" || die "$f: no '-A INPUT -j LOGDROP' to insert before"
	sed -i 's/^-A INPUT -j LOGDROP$/-A INPUT -i tailscale0 -j ACCEPT\n&/' "$f"
done

say "XFCE: terminal is rescue-terminal"
x=/root/.config/xfce4
grep -q '^WebBrowser=' "$x/helpers.rc" || die "$x/helpers.rc looks different"
printf 'TerminalEmulator=custom-TerminalEmulator\n' >>"$x/helpers.rc"
launcher=$(grep -l '^Exec=xfce4-terminal$' "$x"/panel/launcher-*/*.desktop) ||
	die "no panel launcher runs xfce4-terminal"
sed -i -e 's|^Exec=xfce4-terminal$|Exec=/usr/local/bin/rescue-terminal|' \
	-e 's|^Name=Xfce Terminal$|Name=Terminal|' "$launcher"
kb="$x/xfconf/xfce-perchannel-xml/xfce4-keyboard-shortcuts.xml"
grep -q 'value="xfce4-terminal"' "$kb" || die "$kb: no xfce4-terminal shortcut"
sed -i 's|value="xfce4-terminal"|value="exo-open --launch TerminalEmulator"|' "$kb"

say "Claude Code"
curl -fsSL https://claude.ai/install.sh | bash
/root/.local/bin/claude --version

say "toolbox"
(cd /root/toolbox && PATH="/root/.local/bin:/root/.bun/bin:$PATH" ./install.sh --no-adoc)

say "cleaning caches (package databases stay)"
rm -rf /var/cache/pacman/pkg/* /root/.cache /root/.bun/install/cache
```

- [ ] **Step 3: `docker-build.sh`**

```bash
#!/usr/bin/env bash
# Runs build.sh on this Mac: in an x86_64 Arch Linux container (Rosetta under
# Docker Desktop), privileged for chroot and bind mounts. Scratch space is the
# docker volume rescue-usb-work — unpacking onto the Mac's case-insensitive
# disk would break the image. The ISO lands in iso/rescue-usb/out/.
#   docker-build.sh [build.sh arguments]     FAST=1 is passed through
#   docker volume rm rescue-usb-work         frees the ~10 GB it holds
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
mkdir -p "$HERE/out"
exec docker run --rm --privileged --platform linux/amd64 \
	-v "$REPO:/src:ro" -v rescue-usb-work:/work -v "$HERE/out:/out" \
	-e WORK=/work -e OUT=/out -e FAST="${FAST:-}" \
	archlinux:latest /src/iso/rescue-usb/build.sh "$@"
```

- [ ] **Step 4: lint**

```bash
chmod 755 iso/rescue-usb/build.sh iso/rescue-usb/chroot.sh iso/rescue-usb/docker-build.sh
docker run --rm -v "$PWD/iso/rescue-usb:/r:ro" koalaman/shellcheck:stable /r/build.sh /r/chroot.sh /r/docker-build.sh
```

Expected: no findings (fix any, don't silence).

- [ ] **Step 5: verification works — the good case**

Run: `iso/rescue-usb/docker-build.sh --verify-only`
Expected: `==> SystemRescue 13.02` (or newer), `systemrescue-13.02-amd64.iso: sha512 and signature ok`, exit 0.

- [ ] **Step 6: verification refuses a tampered ISO**

```bash
docker run --rm --platform linux/amd64 -v rescue-usb-work:/work archlinux:latest \
	sh -c 'printf x >>/work/cache/systemrescue-13.02-amd64.iso'
iso/rescue-usb/docker-build.sh --verify-only 13.02; echo "exit=$?"
```

Expected: `error: …does not match its sha512 — delete it to download again`, `exit=1`. Then remove the damaged file and re-verify:

```bash
docker run --rm --platform linux/amd64 -v rescue-usb-work:/work archlinux:latest rm /work/cache/systemrescue-13.02-amd64.iso
iso/rescue-usb/docker-build.sh --verify-only 13.02
```

Expected: downloads again, `sha512 and signature ok`.

(The signature path is exercised too: temporarily set `KEY_FPR` in a copy of `build.sh` to another fingerprint, run `--verify-only`, expect `signed, but not by …`. Don't commit the copy.)

- [ ] **Step 7: commit the scripts, then the full build**

Commit first — the image clones the committed toolbox, so Tasks 1–3 must be in `HEAD`:

```bash
git add iso/rescue-usb/build.sh iso/rescue-usb/chroot.sh iso/rescue-usb/docker-build.sh
git commit -m "feat(rescue-usb): build script — verified SystemRescue plus my packages and tools"
FAST=1 iso/rescue-usb/docker-build.sh
ls -lh iso/rescue-usb/out/
```

Expected: last line `==> done: /out/rescue-usb-13.02-<today>.iso`; the file is in `iso/rescue-usb/out/`, roughly 1.9–2.3 GB with `FAST=1`. Any `error:` from `chroot.sh` is a real finding: fix the script, commit, rebuild.

---

### Task 5: `qemu.sh` — boot the ISO on the Mac, smoke and by eye

**Files:**
- Create: `iso/rescue-usb/qemu.sh`

**Interfaces:**
- Consumes: the ISO from Task 4; the smoke unit from Task 3 (`rescue_usb_smoke=1` → `SMOKE OK`/`SMOKE FAILED` on ttyS0, then poweroff).
- Produces: `qemu.sh ISO` (window) and `qemu.sh --smoke ISO` (exit 0 only on `SMOKE OK`; env `TIMEOUT` seconds, default 1800). Used again by CI (Task 6).

- [ ] **Step 1: `qemu.sh`**

```bash
#!/usr/bin/env bash
# Boots a rescue-usb ISO in QEMU (x86_64). KVM when /dev/kvm is usable (CI),
# plain emulation otherwise — on Apple Silicon that means minutes to a desktop.
#
#   qemu.sh ISO            a window with the desktop, 4 GB RAM, user-mode network
#   qemu.sh --smoke ISO    headless: boots with rescue_usb_smoke=1, prints the
#                          serial console, exits 0 only if the image says SMOKE OK
#
#   TIMEOUT=1800   seconds --smoke waits before giving up
set -euo pipefail

smoke=
[ "${1:-}" = --smoke ] && { smoke=1; shift; }
case "${1:-}" in -h | --help | "") sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$0"; exit 0 ;; esac
iso=$1
[ -f "$iso" ] || { echo "error: no such ISO: $iso" >&2; exit 1; }

if [ -w /dev/kvm ]; then
	accel=(-accel kvm -cpu host)
else
	accel=(-accel tcg,thread=multi -cpu max)
fi
common=("${accel[@]}" -m 4096 -smp 4 -cdrom "$iso" -nic user,model=virtio-net-pci -vga std)

if [ -z "$smoke" ]; then
	exec qemu-system-x86_64 "${common[@]}" -boot d
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar=$(command -v bsdtar || command -v tar)
"$tar" -xf "$iso" -C "$tmp" sysresccd/boot/x86_64/vmlinuz sysresccd/boot/x86_64/sysresccd.img \
	sysresccd/boot/syslinux/sysresccd_sys.cfg
label=$(grep -m1 -o 'archisolabel=[^ ]*' "$tmp/sysresccd/boot/syslinux/sysresccd_sys.cfg")

qemu-system-x86_64 "${common[@]}" -display none -serial stdio -no-reboot \
	-kernel "$tmp/sysresccd/boot/x86_64/vmlinuz" -initrd "$tmp/sysresccd/boot/x86_64/sysresccd.img" \
	-append "archisobasedir=sysresccd $label iomem=relaxed console=tty0 console=ttyS0,115200n8 rescue_usb_smoke=1" \
	</dev/null | tee "$tmp/serial.log" &
pid=$!
( sleep "${TIMEOUT:-1800}"; pkill -f "rescue_usb_smoke=1" ) 2>/dev/null &
watchdog=$!
wait "$pid" || true
kill "$watchdog" 2>/dev/null || true
if grep -q 'SMOKE OK' "$tmp/serial.log"; then
	echo "==> smoke: ok"
else
	echo "==> smoke: FAILED (see the FAIL lines above, or the timeout hit)" >&2
	exit 1
fi
```

- [ ] **Step 2: lint**

```bash
chmod 755 iso/rescue-usb/qemu.sh
docker run --rm -v "$PWD/iso/rescue-usb:/r:ro" koalaman/shellcheck:stable /r/qemu.sh
```

- [ ] **Step 3: smoke run on the Mac**

Run: `iso/rescue-usb/qemu.sh --smoke iso/rescue-usb/out/rescue-usb-*.iso` (in the background; it takes minutes under TCG)
Expected: kernel log on the console, then `SMOKE OK`, `==> smoke: ok`, exit 0. Each `FAIL …` line is a finding: fix `chroot.sh`/`rootfs`, commit, rebuild (`FAST=1`), rerun.

- [ ] **Step 4: look at it with the user**

Run: `iso/rescue-usb/qemu.sh iso/rescue-usb/out/rescue-usb-*.iso`
Checklist, done together with the user (screenshots through computer-use if they want me to look):
- XFCE comes up without a login prompt.
- Ctrl+Alt+T and the panel's Terminal launcher open a terminal — ghostty if it gets OpenGL under std VGA, otherwise xfce4-terminal (both acceptable; which one it was goes in the report).
- The prompt is starship's; `ls`, `cat`, `cd` are the aliases; `hx`, `zellij`, `btop` start.
- Super+Space switches us/ru.
- `tailscale status` says "Logged out" (tailscaled up, no key); `claude --version` prints a version.
- `pacman -S --noconfirm nginx` installs without `-Sy`.

- [ ] **Step 5: Commit**

```bash
git add iso/rescue-usb/qemu.sh
git commit -m "feat(rescue-usb): boot the image in QEMU, with a headless smoke run"
```

---

### Task 6: CI workflow and docs

**Files:**
- Create: `.github/workflows/rescue-usb.yml`
- Modify: `README.md` (new `## Images` section, `zsh` in the Configs paragraph)
- Modify: `CLAUDE.md` (Layout table: `iso/<image>/` row; a paragraph under "Working on the tools")

**Interfaces:**
- Consumes: `build.sh` (Task 4), `qemu.sh --smoke` (Task 5).
- Produces: a manually dispatched workflow uploading artifact `rescue-usb` that holds `rescue-usb-<ver>-<date>.iso`.

- [ ] **Step 1: the workflow**

```yaml
name: rescue-usb

on:
  workflow_dispatch:
    inputs:
      version:
        description: SystemRescue version, e.g. 13.02 (empty = newest)
        required: false
        default: ""

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Free disk space
        run: sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL && df -h /

      - name: Build
        env:
          VERSION: ${{ inputs.version }}
        run: |
          mkdir -p out "$RUNNER_TEMP/work"
          docker run --rm --privileged \
            -v "$PWD:/src:ro" -v "$RUNNER_TEMP/work:/work" -v "$PWD/out:/out" \
            -e WORK=/work -e OUT=/out \
            archlinux:latest /src/iso/rescue-usb/build.sh "$VERSION"

      - name: Smoke test
        run: |
          sudo apt-get update -q && sudo apt-get install -yq qemu-system-x86 libarchive-tools
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm
          TIMEOUT=900 iso/rescue-usb/qemu.sh --smoke out/*.iso

      - uses: actions/upload-artifact@v7
        with:
          name: rescue-usb
          path: out/*.iso
          compression-level: 0
          if-no-files-found: error
```

(`"$VERSION"` empty → `build.sh ""` → `${1:-}` empty → newest. The input goes through `env`, never straight into the script.)

Check it parses: `docker run --rm -v "$PWD:/r:ro" rhysd/actionlint:latest -color /r/.github/workflows/rescue-usb.yml` → no findings.

- [ ] **Step 2: README**

In the `## Configs` paragraph, `ghostty`, `helix` and `zellij` → `ghostty`, `helix`, `zellij` and `zsh`, and add after it:

```markdown
`config/zsh/zshrc` is the half of the shell setup every machine shares — the Mac's
own `~/.zshrc` (tokens, Homebrew, work variables) sources it, and so does the
rescue image.
```

New section before `## Raycast`:

```markdown
## Images

| | |
|---|---|
| `iso/rescue-usb` | SystemRescue for the Ventoy stick with my packages, this toolbox, tailscale and Claude Code baked in. `docker-build.sh` builds it on the Mac, `qemu.sh` boots it; the `rescue-usb` workflow (run by hand) builds and smoke-tests it and leaves the ISO as an artifact. |
```

- [ ] **Step 3: CLAUDE.md**

Layout table row after `skills/<name>/`:

```markdown
| `iso/<image>/` | Bootable images built from this checkout. Not linked anywhere by `install.sh`; each has its own build script and workflow. |
```

Under "Working on the tools", a paragraph:

```markdown
`iso/rescue-usb` builds on SystemRescue instead of from scratch: `build.sh`
verifies the SystemRescue ISO against the committed signing key, unsquashes its
root, chroots in with `chroot.sh`, and repacks. Everything comes from
SystemRescue's archive snapshot, never rolling Arch. `chroot.sh` checks each
SystemRescue file before editing it, so a new release that moved something stops
the build — fix the check, don't loosen it. The image clones the toolbox commit
being built, so commit before `docker-build.sh`. The smoke check lives in the
image (`rootfs/usr/local/lib/rescue-usb/smoke`) and runs on
`rescue_usb_smoke=1`; `qemu.sh --smoke` is how both the Mac and CI run it.
```

- [ ] **Step 4: Commit, then hand over**

```bash
git add .github/workflows/rescue-usb.yml README.md CLAUDE.md
git commit -m "feat(rescue-usb): manual workflow that builds, smoke-tests and uploads the image"
```

Pushing and dispatching the workflow is the user's call: ask, then `git push` and `gh workflow run rescue-usb.yml`, and watch with `gh run watch`. Expected: green run, artifact `rescue-usb` with one ISO.

- [ ] **Step 5: by hand on the stick (with the user)**

Copy the ISO onto the Ventoy stick and check: boots from the Ventoy menu; boots with Secure Boot on after enrolling Ventoy's key; with a `vtoycow` persistence file (Ventoy `persistence` plugin) a file created in `/root` survives a reboot; `tailscale up` logs in; `claude` logs in. Results go into the final report — failures here are findings, not blockers of the build.
