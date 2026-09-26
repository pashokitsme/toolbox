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

say "mirrors: Russian ones first for rolling Arch, one more archive mirror for the snapshot"
# No Russian mirror carries the Arch Linux Archive, so the snapshot only gains
# mirror.surf as a fallback after SystemRescue's own; pacman moves on to the
# next server when one fails. The rolling list (pacman-rolling.conf) gets the
# Russian mirrors from archlinux.org's mirror status ahead of SystemRescue's.
snapshot=/etc/pacman.d/mirrorlist-snapshot
date=$(grep -m1 -oE '/repos/[0-9]{4}/[0-9]{2}/[0-9]{2}/' "$snapshot") ||
	die "$snapshot: no dated archive server to take the snapshot date from"
# shellcheck disable=SC2016 # $repo and $arch are pacman's to expand
printf 'Server = https://mirror.surf/archlinux-archive%s$repo/os/$arch\n' "$date" >>"$snapshot"
ru_mirrors=(
	https://mirror.yandex.ru/archlinux
	https://mirror.truenetwork.ru/archlinux
	https://mirror.nw-sys.ru/archlinux
	https://mirror.kpfu.ru/archlinux
	https://repository.su/archlinux
	https://mirror.cachy-arch.ru/archlinux
	https://ru.mirrors.cicku.me/archlinux
	https://mirror.kamtv.ru/archlinux
)
rolling=/etc/pacman.d/mirrorlist
[ -f "$rolling" ] || die "$rolling is missing"
{
	echo "# Russian mirrors first (rescue-usb)"
	# shellcheck disable=SC2016 # $repo and $arch are pacman's to expand
	printf 'Server = %s/$repo/os/$arch\n' "${ru_mirrors[@]}"
	cat "$rolling"
} >"$rolling.new"
mv "$rolling.new" "$rolling"

say "installing packages"
mapfile -t packages < <(grep -v '^\s*\(#\|$\)' "$packages_file")
pacman "${pacman_opts[@]}" -Sy --noconfirm
# --ask 4 says yes to replacing a conflicting package (mesa-minimal by mesa),
# which --noconfirm alone would refuse
pacman "${pacman_opts[@]}" -S --needed --noconfirm --ask 4 "${packages[@]}"

say "helix answers to hx, as on the Mac (Arch names the binary helix)"
[ -x /usr/bin/helix ] || die "/usr/bin/helix is missing"
ln -sf /usr/bin/helix /usr/local/bin/hx

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

say "bun, baseline build"
# Arch's bun needs AVX2, which old CPUs (and Rosetta) lack; a rescue stick meets
# old CPUs. Checked against the SHASUMS256.txt of the same release.
bun_url=https://github.com/oven-sh/bun/releases/latest/download
bun_tmp=$(mktemp -d)
curl -fsSL -o "$bun_tmp/bun-linux-x64-baseline.zip" "$bun_url/bun-linux-x64-baseline.zip"
curl -fsSL -o "$bun_tmp/SHASUMS256.txt" "$bun_url/SHASUMS256.txt"
(cd "$bun_tmp" && grep ' bun-linux-x64-baseline.zip$' SHASUMS256.txt | sha256sum --quiet -c -) ||
	die "bun-linux-x64-baseline.zip does not match SHASUMS256.txt"
bsdtar -xf "$bun_tmp/bun-linux-x64-baseline.zip" -C "$bun_tmp"
install -m 0755 "$bun_tmp/bun-linux-x64-baseline/bun" /usr/local/bin/bun
ln -sf bun /usr/local/bin/bunx
rm -rf "$bun_tmp"
bun --version

say "Claude Code"
curl -fsSL https://claude.ai/install.sh | bash
/root/.local/bin/claude --version

say "toolbox"
(cd /root/toolbox && PATH="/root/.local/bin:/root/.bun/bin:$PATH" ./install.sh --no-adoc)

say "cleaning caches (package databases stay)"
rm -rf /var/cache/pacman/pkg/* /root/.cache /root/.bun/install/cache
