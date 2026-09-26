# rescue-usb — SystemRescue with my tools, for a Ventoy stick

## Goal

A ready-to-use x86_64 live image that sits on the Ventoy stick next to other
ISOs: boots into a desktop with network and disk diagnostics, my configs and
tools already in place, `tailscale` and `claude` installed and waiting for a
login. No secrets in the image — it is built in the public toolbox repository.

## Decisions

| Question | Decision |
|---|---|
| Base | Latest **SystemRescue** release (Arch-based, XFCE). Already carries mtr, nmap, iperf3, smartmontools, nvme-cli, gparted, testdisk, ddrescue, tmux, htop, ncdu, firefox-esr. |
| Why not archiso / KDE | Considered and dropped: SystemRescue gives most of the toolset for free, XFCE is enough. |
| Packages | SystemRescue's **snapshot** repository (Arch Linux Archive frozen at the release date). Everything added comes from the same snapshot, so nothing is a partial upgrade. The synced package databases stay in the image: `pacman -S foo` works right after boot without `-Sy`. Versions lag current Arch by the age of the SystemRescue release. `/etc/pacman-rolling.conf` stays available by hand. |
| User | root, like SystemRescue itself: autologin, X started by `dostartx`, no display manager. Dotfiles and toolbox live in `/root`. |
| Terminal | ghostty by default in XFCE, xfce4-terminal as the fallback. |
| Tailscale | `tailscaled` enabled, no auth key; `tailscale up` by hand. Incoming traffic on `tailscale0` allowed in SystemRescue's firewall at build time. |
| Claude Code | Native installer into `/root/.local/bin` (it is not in the Arch repositories). Login by hand. `IS_SANDBOX=1` is set for root, so the `claude --dangerously-skip-permissions` alias from my zshrc works (Claude Code refuses that flag as root otherwise). |
| Shell | My zshrc works in the image: its portable half moves into toolbox as `config/zsh/zshrc`, and `/root/.zshrc` only sources it. Secrets and macOS-only setup stay in `~/.zshrc` on the Mac and never enter the repository or the image. |
| Toolbox | Cloned into `/root/toolbox` at build time, `install.sh` run as root. macOS-only tools (`tauri-win`, `prl-win-run`, `mcz`'s file dialog) end up on `PATH` and simply go unused. |
| Version | Latest SystemRescue tag by default, resolved at build time; overridable. The signing key is the one thing pinned in the repository. |
| Where | `iso/rescue-usb/` in toolbox. |
| CI | GitHub Actions, `workflow_dispatch` only, ISO uploaded as a workflow artifact. No releases. |
| Persistence | Nice to have: Ventoy's `vtoycow` file with archiso's `cow_label`. Verified by hand, not required for the build to pass. |

## Layout

```
iso/rescue-usb/
  build.sh              entry point; runs inside an x86_64 Arch container
  chroot.sh             runs inside the unpacked SystemRescue root
  packages.txt          extra packages, grouped and commented
  rootfs/               files copied over the SystemRescue root before chroot.sh
  sysrescue.d/          YAML added to the ISO root (boot-time configuration)
  systemrescue-signing-key.pem
  qemu.sh               boots a built ISO on this Mac (interactive or smoke)
.github/workflows/rescue-usb.yml
```

`bin/` does not get an entry: the image is not a command on `PATH`.

## Build flow (`build.sh`)

1. **Resolve the version.** `$1` if given, else the newest tag of
   `gitlab.com/systemrescue/systemrescue-sources` via the GitLab API
   (tags are plain `13.02`).
2. **Fetch and verify.** `systemrescue-<ver>-amd64.iso`, `.sha512` and `.asc`
   from `fastly-cdn.system-rescue.org/releases/<ver>/`. Check the sha512, then
   `gpg --verify` against `systemrescue-signing-key.pem` in a throwaway
   `GNUPGHOME`, and require the signature to come from primary key
   `0FF11AF081E98345594812037091115F8320B897` (the release is signed by its
   signing subkey `62989046EB5C7E985ECDF5DD3B0FEA9BE13CA3C9`). Any mismatch
   stops the build.
3. **Unpack.** `sysrescue-customize` taken from the same tag of
   `systemrescue-sources`, `--unpack` into a work directory.
4. **Overlay.** Copy `rootfs/` over the unpacked root filesystem.
5. **Customize.** Bind-mount `/proc`, `/sys`, `/dev`, resolv.conf; run
   `chroot.sh` inside the root; unmount (in a trap, so a failure does not
   leave mounts behind).
6. **Rebuild.** Add `sysrescue.d/*.yaml` to the ISO tree, `--rebuild` into
   `out/rescue-usb-<ver>-<yyyy-mm-dd>.iso`.

`build.sh` is the same script locally and in CI. It needs root inside the
container (chroot, bind mounts), so the container runs `--privileged`.

## Inside the image (`chroot.sh`)

1. `pacman -Sy` with SystemRescue's snapshot configuration (keyring problems
   are handled with SystemRescue's own `pacman-faketime`), then
   `pacman -S --needed` everything in `packages.txt`.
2. `systemctl enable tailscaled`.
3. Claude Code through its native installer, with `HOME=/root`.
4. `git clone https://github.com/pashokitsme/toolbox /root/toolbox`, then
   `./install.sh` with `HOME=/root` (links `bin/`, `config/`, `skills/`,
   runs `bun install` in `lib/`, installs `adoc`).
5. `pacman -Scc` — drop the package cache, keep `/var/lib/pacman/sync`.

### packages.txt

- **Network:** tailscale, wireshark-cli, nethogs, arp-scan, lldpd, mosh.
- **Disk:** fio, gdu.
- **Everyday:** ghostty, helix, zellij, starship, btop, fzf, ripgrep, fd, bat,
  eza, git-delta, github-cli, glab, bun, jq, ttf-jetbrains-mono-nerd.
- **For my zshrc:** zsh-syntax-highlighting, zsh-autosuggestions, zoxide,
  lazygit, ffmpeg, imagemagick.

All of them are in `extra`, and all were present in the archive snapshot of
2026-07-28 that SystemRescue 13.02 is built on.

### rootfs/

- Firewall rule accepting input on `tailscale0` (in whichever mechanism
  SystemRescue's firewall uses — iptables or nftables — checked when writing it).
- `/root/.zshrc`: `source ~/.config/zsh/zshrc` and nothing else.
- `IS_SANDBOX=1` in root's environment (`/etc/profile.d/` or the zshrc
  loaded before it — whichever reaches both the terminal and XFCE-launched
  programs).
- XFCE default terminal: a custom exo helper for ghostty, xfce4-terminal left
  installed as the fallback.
- The smoke check (see Testing), plus a unit that runs it only when the kernel
  command line carries `rescue_usb_smoke=1`.

### sysrescue.d/500-toolbox.yaml

`rootshell: /bin/zsh`, `dostartx: true`, keyboard layouts us + ru.

## Toolbox changes that come with this

- `install.sh`: `gh skill install` of the adoc skill must not abort the run.
  Under `set -e` a `gh` that is installed but not logged in currently kills
  `install.sh` on any machine; it becomes a warning, like a missing `bun`.
- `config/zsh/zshrc` (new, linked to `~/.config/zsh` by `install.sh` like any
  other config): the portable half of my current `~/.zshrc` — aliases (`ls`,
  `cat`, `grep`, `cd`, `lg`, `npm`, `claude`, `clear`, `cls`, `rmf`),
  completion setup, key bindings, zsh-syntax-highlighting and
  zsh-autosuggestions, starship, zoxide, bun completion, `EDITOR=hx`,
  `ccp --shell-init`, `LANG`/`LC_ALL`, `~/.local/bin` and `~/.bun/bin` on
  `PATH`, and the functions `reload`, `ffmpeg-compress`, `magick-compress`,
  `rustfmt-init`. Plugin paths and anything else platform-bound are picked by
  platform (`/opt/homebrew/share/...` on macOS, `/usr/share/zsh/plugins/...`
  on Arch); a missing tool is skipped, never an error at shell start.
- `~/.zshrc` on the Mac (not in the repository): keeps brew, llvm, emsdk,
  solana, dotnet, `HELIX_RUNTIME`, `kill-audio`, every exported token and the
  work variables, and gains `source ~/.config/zsh/zshrc`. Backed up to
  `~/.zshrc.bak` before the edit; a fresh shell on the Mac must behave as
  before.
- `config/ghostty/config`: a second `font-family` (JetBrains Mono Nerd Font)
  after `menlo`, so ghostty on Linux has a font it actually finds.
- `README.md`: one row for `iso/rescue-usb`.

## Testing

**Smoke check** (baked into the image, runs on `rescue_usb_smoke=1`):
`command -v` for every tool added, `systemctl is-active tailscaled`, the
`tailscale0` firewall rule present, `pacman -Si ghostty` succeeding without a
`-Sy`, `/root/toolbox` and `claude` present, `zsh -i -c exit` printing
nothing on stderr, and the zshrc aliases resolving (`z`, `eza`, `bat`, `rg`,
`lazygit`, `ccp`). Writes `SMOKE OK` or the failures
to the serial console and powers off.

**Locally first, on this Mac (arm64):**

- Build: `docker run --rm --privileged --platform linux/amd64 archlinux`
  with the repository mounted, running `build.sh`. Docker Desktop runs it
  under Rosetta. The work directory needs about 10 GB.
- `qemu.sh <iso>` — interactive: `qemu-system-x86_64` (TCG, no acceleration
  for x86 on Apple Silicon — slow, minutes to boot), 4 GB RAM, cocoa window,
  to look at XFCE and ghostty by eye.
- `qemu.sh --smoke <iso>` — headless: direct kernel boot of the ISO's kernel
  and initramfs with `rescue_usb_smoke=1` appended, serial console to stdout,
  exits non-zero unless `SMOKE OK` appears before the timeout.

CI is written only after the local build and both QEMU runs pass.

**CI:** the same `build.sh` in an `archlinux` container on `ubuntu-latest`,
then `qemu.sh --smoke` with KVM. A failing smoke check fails the job and no
artifact is uploaded. Artifact retention is left at the default.

**By hand on the stick:** boot through Ventoy; boot with Secure Boot on after
enrolling Ventoy's key; persistence with a `vtoycow` file; `tailscale up`;
`claude`.

## Known risks

- SystemRescue changing its layout or `sysrescue-customize` between releases —
  the build or the smoke check fails, and `version` pins the previous release.
- Signing key rotation — the signature check fails loudly; the new key is
  committed after checking it on the SystemRescue site.
- SystemRescue through Ventoy with Secure Boot had an open `shim_lock` issue in
  2022; unverified for 13.x.
- `ccp` is written for macOS (Claude Desktop state under `~/Library`); only
  `ccp --shell-init` has to work on Linux, and the smoke check covers it.
- The image is ~2 GB (SystemRescue itself is 1.3 GB).
