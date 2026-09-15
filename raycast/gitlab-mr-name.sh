#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title GitLab: MR Name
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🦊
# @raycast.packageName toolbox
# @raycast.argument1 { "type": "text", "placeholder": "merge request link" }

# Documentation:
# @raycast.description Copy a merge request link under its title — glmr -y from Raycast
# @raycast.author Pavel Smirnov

# `glmr -y <link>` with the link typed into Raycast. The link carries everything:
# host, project and number, so it works for any GitLab instance and does not
# care which directory Raycast runs it from. Anything after the number — /diffs,
# #note_123 — is ignored. What lands on the clipboard is the rich kind: the title
# of the merge request as a link, "title — url" in a plain-text field.
#
# Raycast starts a script with PATH=/usr/bin:/bin:/usr/sbin:/sbin and none of
# ~/.zshrc, so glmr (~/.local/bin), bun (its shebang) and glab (Homebrew) are put
# on PATH here. The GITLAB_TOKEN of the shell does not reach this far either:
# glab takes the token for the link's host from its own config, which is what
# `glab auth login --hostname <host>` writes.
#
# compact rather than silent: only compact shows the last line of a failed run,
# so stderr goes to stdout and the toast says why nothing was copied.

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

for cmd in glmr bun glab; do
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "$cmd is not installed — run install.sh in toolbox"
		exit 1
	fi
done

# a link pasted with a stray space or newline around it is still the link
link="${1#"${1%%[![:space:]]*}"}"
link="${link%"${link##*[![:space:]]}"}"

exec glmr -y "$link" 2>&1
