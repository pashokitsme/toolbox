#!/usr/bin/env bash
# Links every tool in bin/ into $PREFIX/bin (default ~/.local/bin), every
# directory in config/ into $XDG_CONFIG_HOME (default ~/.config), every skill in
# skills/ into ~/.claude/skills, and prepares whatever the multi-file tools in
# lib/ need.
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   -n, --dry-run        Print what would happen, change nothing
#   -f, --force          Move aside whatever sits on a target name, as <name>.bak
#       --uninstall      Remove the links this script created
#       --prefix DIR     Install tools under DIR instead of ~/.local
#       --config-dir DIR Link configs into DIR instead of ~/.config
#       --no-config      Leave the config directory alone
#       --skills-dir DIR Link skills into DIR instead of ~/.claude/skills
#       --no-skills      Leave the skills directory alone
#   -h, --help           Show this help and exit
#
# Links are relative to nothing — they point at this checkout, so editing a
# tool or a config here takes effect immediately, and moving the checkout
# breaks them (re-run the script after a move).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
SKILLS_DIR="$HOME/.claude/skills"
DRY_RUN=0
FORCE=0
UNINSTALL=0
WITH_CONFIG=1
WITH_SKILLS=1

usage() {
	sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	-n | --dry-run) DRY_RUN=1 ;;
	-f | --force) FORCE=1 ;;
	--uninstall) UNINSTALL=1 ;;
	--no-config) WITH_CONFIG=0 ;;
	--no-skills) WITH_SKILLS=0 ;;
	--prefix)
		PREFIX="${2:?--prefix needs a directory}"
		shift
		;;
	--config-dir)
		CONFIG_DIR="${2:?--config-dir needs a directory}"
		shift
		;;
	--skills-dir)
		SKILLS_DIR="${2:?--skills-dir needs a directory}"
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

# Every link this script ever made points into $REPO, so the destination
# directory itself is the list — no need to consult bin/ or config/, which may
# no longer hold the entry a stale link was made for.
ours() { # ours <directory>
	local dir="$1" link
	[ -d "$dir" ] || return 0
	for link in "$dir"/*; do
		[ -L "$link" ] || continue
		case "$(readlink "$link")" in
		"$REPO"/*) printf '%s\n' "$link" ;;
		esac
	done
}

linked=0
skipped=0
pruned=0

# One link per entry of <source>, named after it. Directories are linked whole:
# ~/.config/helix becomes a link to config/helix, so new files inside it land in
# this checkout rather than beside it.
link_tree() { # link_tree <source dir> <destination dir> <what left behind means>
	local src="$1" dst="$2" gone="$3" target name link
	[ -d "$dst" ] || run mkdir -p "$dst"

	for target in "$src"/*; do
		[ -e "$target" ] || continue
		name="$(basename "$target")"
		link="$dst/$name"

		if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
			say "  ok       $name (already linked)"
			linked=$((linked + 1))
			continue
		fi

		# anything real on the target name is the user's own copy — do not eat it
		if [ -e "$link" ] && [ ! -L "$link" ]; then
			if [ "$FORCE" != 1 ]; then
				say "  skip     $name — $link exists and is not a link; re-run with --force"
				skipped=$((skipped + 1))
				continue
			fi
			if [ -e "$link.bak" ]; then
				say "  skip     $name — $link.bak is in the way; move it away first"
				skipped=$((skipped + 1))
				continue
			fi
			run mv "$link" "$link.bak"
			note "  saved    $name (kept the old one as $link.bak)"
		fi

		run ln -sfn "$target" "$link"
		note "  linked   $name"
		linked=$((linked + 1))
	done

	# an entry that left the checkout leaves a dangling link behind — sweep those
	while IFS= read -r link; do
		[ -n "$link" ] || continue
		[ -e "$link" ] && continue
		run rm "$link"
		note "  pruned   $(basename "$link") ($gone)"
		pruned=$((pruned + 1))
	done <<<"$(ours "$dst")"
}

# ------------------------------------------------------------------ uninstall

if [ "$UNINSTALL" = 1 ]; then
	removed=0
	unlink_tree() { # unlink_tree <directory>
		say "removing links in $1 that point into $REPO"
		while IFS= read -r link; do
			[ -n "$link" ] || continue
			run rm "$link"
			note "  removed  $(basename "$link")"
			removed=$((removed + 1))
		done <<<"$(ours "$1")"
	}
	unlink_tree "$BIN"
	if [ "$WITH_CONFIG" = 1 ]; then unlink_tree "$CONFIG_DIR"; fi
	if [ "$WITH_SKILLS" = 1 ]; then unlink_tree "$SKILLS_DIR"; fi
	say "done: $removed removed"
	exit 0
fi

# -------------------------------------------------------------------- install

say "installing tools from $REPO into $BIN"
link_tree "$REPO/bin" "$BIN" "gone from bin/"

if [ "$WITH_CONFIG" = 1 ] && [ -d "$REPO/config" ]; then
	say "linking configs from $REPO/config into $CONFIG_DIR"
	link_tree "$REPO/config" "$CONFIG_DIR" "gone from config/"
fi

if [ "$WITH_SKILLS" = 1 ] && [ -d "$REPO/skills" ]; then
	say "linking skills from $REPO/skills into $SKILLS_DIR"
	link_tree "$REPO/skills" "$SKILLS_DIR" "gone from skills/"
fi

# every lib/ entry with a package.json is a Bun package: its type definitions
# live in node_modules, so the checkout needs them before tsc says anything useful
for pkg in "$REPO"/lib/*/package.json; do
	[ -e "$pkg" ] || continue
	dir="$(dirname "$pkg")"
	name="$(basename "$dir")"
	if command -v bun >/dev/null 2>&1; then
		say "installing $name dependencies with bun"
		if [ "$DRY_RUN" = 1 ]; then
			say "  would: bun install --cwd $dir"
		else
			(cd "$dir" && bun install --silent)
		fi
	else
		say "  warn     bun is missing — $name will not run"
	fi
done

# an older standalone copy of glab-mrs shadows nothing, but it does confuse
if [ -d "$HOME/.local/lib/glab-mrs" ] && [ "$HOME/.local/lib/glab-mrs" != "$REPO/lib/glab-mrs" ]; then
	say "  note     $HOME/.local/lib/glab-mrs is an older copy; this checkout is the live one now"
fi

# adoc is not part of this checkout: it is its own tool, installed from its
# repository. bun links the binary; the agent skill comes from the same repo
# through gh. Both are skipped when their command is missing — the checkups
# below then say so.
if command -v adoc >/dev/null 2>&1; then
	say "  ok       adoc (already installed)"
elif command -v bun >/dev/null 2>&1; then
	say "installing adoc with bun"
	run bun install -g github:pashokitsme/adoc
fi

if [ "$WITH_SKILLS" = 1 ] && [ ! -e "$SKILLS_DIR/adoc" ] && command -v gh >/dev/null 2>&1; then
	say "installing the adoc skill with gh"
	run gh skill install pashokitsme/adoc adoc --agent claude-code --scope user --force
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
check bun "glab-mrs, adoc"
check glab "glab-mrs"
check claude "git-ai-commit"
check git "git-ai-commit"
check obscura "ofetch"
check shasum "ofetch"
check prlctl "tauri-win, prl-win-run"
check cargo "tauri-win"

case ":$PATH:" in
*":$BIN:"*) ;;
*) say "  warn     $BIN is not in PATH" ;;
esac

say "done: $linked linked, $skipped skipped, $pruned pruned"
