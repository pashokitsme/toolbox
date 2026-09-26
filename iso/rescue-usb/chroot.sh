#!/usr/bin/env bash
# Runs inside the unpacked SystemRescue root — build.sh chroots into it.
#   chroot.sh PACKAGES_FILE [PACMAN_OPTION…]
# Every edit of a SystemRescue file first checks the file still looks the way
# this script expects, and stops the build if not: a new SystemRescue release
# must fail loudly rather than ship an image that silently lacks a change.
set -euo pipefail
packages_file=$1
shift
pacman_opts=("$@")
export HOME=/root

say() { printf '  -> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "pacman: archive snapshot only"
# every server must be a dated Arch Linux Archive path (…/repos/YYYY/MM/DD/…);
# SystemRescue lists archive.archlinux.org and its mirrors
servers=$(pacman-conf --repo=extra Server)
[ -n "$servers" ] || die "pacman has no server for [extra]"
if grep -qvE '^https://[^/]+/repos/[0-9]{4}/[0-9]{2}/[0-9]{2}/' <<<"$servers"; then
	die "pacman does not point at a dated archive snapshot: $servers"
fi

say "installing packages"
mapfile -t packages < <(grep -v '^\s*\(#\|$\)' "$packages_file")
pacman "${pacman_opts[@]}" -Sy --noconfirm
pacman "${pacman_opts[@]}" -S --needed --noconfirm "${packages[@]}"

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
