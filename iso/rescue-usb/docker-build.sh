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
