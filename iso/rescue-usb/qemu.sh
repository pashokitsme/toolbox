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
if [ "${1:-}" = --smoke ]; then smoke=1; shift; fi
case "${1:-}" in -h | --help | "") sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "$0"; exit 0 ;; esac
iso=$1
[ -f "$iso" ] || { echo "error: no such ISO: $iso" >&2; exit 1; }

if [ -w /dev/kvm ]; then
	accel=(-accel kvm -cpu host)
else
	accel=(-accel "tcg,thread=multi" -cpu max)
fi
common=("${accel[@]}" -m 4096 -smp 4 -cdrom "$iso" -nic "user,model=virtio-net-pci" -vga std)

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
(
	sleep "${TIMEOUT:-1800}"
	pkill -f "rescue_usb_smoke=1"
) 2>/dev/null &
watchdog=$!
wait "$pid" || true
pkill -P "$watchdog" 2>/dev/null || true # its sleep, so it cannot fire later
kill "$watchdog" 2>/dev/null || true
if grep -q 'SMOKE OK' "$tmp/serial.log"; then
	echo "==> smoke: ok"
else
	echo "==> smoke: FAILED (see the FAIL lines above, or the timeout hit)" >&2
	exit 1
fi
