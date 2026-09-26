#!/usr/bin/env bash
# Builds the rescue-usb image: the newest SystemRescue with the packages,
# configs and tools from this directory baked in (see packages.txt, rootfs/,
# chroot.sh, sysrescue.d/). Runs as root inside an x86_64 Arch Linux container:
# docker-build.sh on a Mac, .github/workflows/rescue-usb.yml in CI.
#
#   build.sh [VERSION]                build; VERSION defaults to the newest SystemRescue
#   build.sh --verify-only [VERSION]  download and verify the SystemRescue ISO, nothing else
#
#   WORK=/work   scratch space, ~10 GB; the downloaded ISO is cached in $WORK/cache
#   OUT=…/out    where the finished ISO goes
#   FAST=1       zstd instead of xz for the root filesystem: quicker, ~20% bigger
#
# The SystemRescue ISO must carry a valid signature by Francois Dupoux's key
# (systemrescue-signing-key.pem, primary 0FF11AF0…8320B897), or nothing is built.
# The toolbox baked into the image is the commit checked out here, so commit first.
set -euo pipefail
shopt -s inherit_errexit # fetch_verified runs inside $(…)

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
# pacman's download sandbox needs seccomp, which x86 emulation on Apple Silicon
# (Rosetta under Docker Desktop) does not provide
PACMAN_OPTS=()
if grep -q VirtualApple /proc/cpuinfo 2>/dev/null; then
	PACMAN_OPTS=(--disable-sandbox)
fi

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# download URL DEST — DEST appears only once the download is complete
download() {
	curl -fsSL --retry 3 -o "$2.part" "$1" || { rm -f "$2.part"; die "download failed: $1"; }
	mv "$2.part" "$2"
}

latest_version() {
	curl -fsSL "$TAGS_API" | jq -r '.[].name' | grep -E '^[0-9]+\.[0-9]+$' | sort -V | tail -1
}

# fetch_verified VERSION — prints the path of a checksummed, signature-checked ISO
fetch_verified() {
	local ver=$1 iso="systemrescue-$1-amd64.iso" dir="$WORK/cache"
	mkdir -p "$dir"
	if [ ! -s "$dir/$iso" ]; then
		say "downloading $iso" >&2
		download "$CDN/$ver/$iso" "$dir/$iso"
	fi
	download "$CDN/$ver/$iso.sha512" "$dir/$iso.sha512"
	download "$CDN/$ver/$iso.asc" "$dir/$iso.asc"
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
	if [ -n "${ROOT:-}" ]; then umount -R "$ROOT" 2>/dev/null || true; fi
}

main() {
	local verify_only=
	if [ "${1:-}" = --verify-only ]; then verify_only=1; shift; fi
	case "${1:-}" in -h | --help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "$0"; exit 0 ;; esac

	[ "$(id -u)" = 0 ] || die "run as root (inside the build container)"
	say "installing build dependencies"
	pacman "${PACMAN_OPTS[@]}" -Syu --needed --noconfirm "${DEPS[@]}" >/dev/null

	local ver="${1:-}"
	[ -n "$ver" ] || ver=$(latest_version) || true
	[ -n "$ver" ] || die "could not find the newest SystemRescue version ($TAGS_API)"
	say "SystemRescue $ver"
	local out
	out="$OUT/rescue-usb-$ver-$(date -u +%F).iso"
	# an ISO of today's name from an earlier run must not outlive a failed build
	[ -n "$verify_only" ] || rm -f "$out" "$out.part"
	local iso
	iso=$(fetch_verified "$ver")
	[ -z "$verify_only" ] || return 0

	local build="$WORK/build" customize="$WORK/sysrescue-customize-$ver"
	[ -s "$customize" ] || download "$SOURCES/-/raw/$ver/airootfs/usr/share/sysrescue/bin/sysrescue-customize" "$customize"
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
	# --no-perms: directories SystemRescue already has keep their mode (/root is 0750)
	rsync -a --no-perms --chown=root:root "$HERE/rootfs/" "$ROOT/"
	local repo
	repo=$(git -c safe.directory='*' -C "$HERE" rev-parse --show-toplevel)
	git -c safe.directory='*' clone --quiet --no-local "$repo" "$ROOT/root/toolbox"
	git -C "$ROOT/root/toolbox" remote set-url origin https://github.com/pashokitsme/toolbox
	# not /tmp: arch-chroot mounts a fresh tmpfs over it
	local stage=/var/tmp/rescue-usb
	install -D -m 0644 "$HERE/packages.txt" "$ROOT$stage/packages.txt"
	install -D -m 0755 "$HERE/chroot.sh" "$ROOT$stage/chroot.sh"

	say "customizing inside the image"
	mount --bind "$ROOT" "$ROOT"
	arch-chroot "$ROOT" "$stage/chroot.sh" "$stage/packages.txt" "${PACMAN_OPTS[@]}"
	umount -R "$ROOT"
	rm -rf "${ROOT:?}$stage"

	say "repacking the root filesystem (${SFS_OPTS[*]})"
	rm "$sfs"
	mksquashfs "$ROOT" "$sfs" -noappend -quiet "${SFS_OPTS[@]}"
	(cd "$(dirname "$sfs")" && sha512sum airootfs.sfs >airootfs.sha512)
	rm -rf "$ROOT"

	install -m 0644 "$HERE"/sysrescue.d/*.yaml "$build/iso/filesystem/sysrescue.d/"
	mkdir -p "$OUT"
	bash "$customize" --rebuild -s "$build/iso" -d "$out.part"
	mv "$out.part" "$out"
	rm -rf "$build"
	say "done: $out"
}

main "$@"
