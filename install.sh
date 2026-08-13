#!/usr/bin/env bash
# Links every tool in bin/ into $PREFIX/bin (default ~/.local/bin) and prepares
# whatever the multi-file tools in lib/ need.
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   -n, --dry-run    Print what would happen, change nothing
#   -f, --force      Replace regular files that sit on a target name
#       --uninstall  Remove the links this script created
#       --prefix DIR Install under DIR instead of ~/.local
#   -h, --help       Show this help and exit
#
# Links are relative to nothing — they point at this checkout, so editing a
# tool here takes effect immediately, and moving the checkout breaks them
# (re-run the script after a move).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
DRY_RUN=0
FORCE=0
UNINSTALL=0

usage() {
	sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	-n | --dry-run) DRY_RUN=1 ;;
	-f | --force) FORCE=1 ;;
	--uninstall) UNINSTALL=1 ;;
	--prefix)
		PREFIX="${2:?--prefix needs a directory}"
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "install: unknown option $1" >&2
		usage >&2
		exit 2
		;;
	esac
	shift
done

BIN="$PREFIX/bin"

say() { printf '%s\n' "$*"; }
# result lines are noise in a dry run — `run` already printed the command
note() { [ "$DRY_RUN" = 1 ] || say "$*"; }
run() {
	if [ "$DRY_RUN" = 1 ]; then
		say "  would: $*"
	else
		"$@"
	fi
}

# Every link this script ever made points into $REPO, so the install directory
# itself is the list — no need to consult bin/, which may no longer hold the
# tool a stale link was made for.
ours() {
	[ -d "$BIN" ] || return 0
	for link in "$BIN"/*; do
		[ -L "$link" ] || continue
		case "$(readlink "$link")" in
		"$REPO"/*) printf '%s\n' "$link" ;;
		esac
	done
}

# ------------------------------------------------------------------ uninstall

if [ "$UNINSTALL" = 1 ]; then
	say "removing links in $BIN that point into $REPO"
	removed=0
	while IFS= read -r link; do
		[ -n "$link" ] || continue
		run rm "$link"
		note "  removed  $(basename "$link")"
		removed=$((removed + 1))
	done <<<"$(ours)"
	say "done: $removed removed"
	exit 0
fi

# -------------------------------------------------------------------- install

say "installing tools from $REPO into $BIN"
[ -d "$BIN" ] || run mkdir -p "$BIN"

linked=0
skipped=0
for target in "$REPO"/bin/*; do
	name="$(basename "$target")"
	link="$BIN/$name"

	if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
		say "  ok       $name (already linked)"
		linked=$((linked + 1))
		continue
	fi

	# a plain file on the target name is someone's own copy — do not eat it
	if [ -e "$link" ] && [ ! -L "$link" ] && [ "$FORCE" != 1 ]; then
		say "  skip     $name — $link exists and is not a link; re-run with --force"
		skipped=$((skipped + 1))
		continue
	fi

	run ln -sfn "$target" "$link"
	note "  linked   $name"
	linked=$((linked + 1))
done

# a tool that left bin/ leaves a dangling link behind — sweep those too
pruned=0
while IFS= read -r link; do
	[ -n "$link" ] || continue
	[ -e "$link" ] && continue
	run rm "$link"
	note "  pruned   $(basename "$link") (gone from bin/)"
	pruned=$((pruned + 1))
done <<<"$(ours)"

# glab-mrs is a Bun package: its type definitions live in node_modules
if [ -f "$REPO/lib/glab-mrs/package.json" ]; then
	if command -v bun >/dev/null 2>&1; then
		say "installing glab-mrs dependencies with bun"
		if [ "$DRY_RUN" = 1 ]; then
			say "  would: bun install --cwd $REPO/lib/glab-mrs"
		else
			(cd "$REPO/lib/glab-mrs" && bun install --silent)
		fi
	else
		say "  warn     bun is missing — glab-mrs will not run"
	fi
fi

# an older standalone copy of glab-mrs shadows nothing, but it does confuse
if [ -d "$HOME/.local/lib/glab-mrs" ] && [ "$HOME/.local/lib/glab-mrs" != "$REPO/lib/glab-mrs" ]; then
	say "  note     $HOME/.local/lib/glab-mrs is an older copy; this checkout is the live one now"
fi

# ------------------------------------------------------------------- checkups

say "checking what the tools need"
check() { # check <command> <who needs it>
	if command -v "$1" >/dev/null 2>&1; then
		say "  ok       $1 — $2"
	else
		say "  missing  $1 — $2"
	fi
}
check bun "glab-mrs"
check glab "glab-mrs"
check claude "git-ai-commit"
check git "git-ai-commit"
check prlctl "tauri-win, prl-win-run"
check cargo "tauri-win"

case ":$PATH:" in
*":$BIN:"*) ;;
*) say "  warn     $BIN is not in PATH" ;;
esac

say "done: $linked linked, $skipped skipped, $pruned pruned"
