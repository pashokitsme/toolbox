// Shell integration.
//
// One variable: CLAUDE_CONFIG_DIR. It picks the config home, and through it the
// Keychain item — Claude Code names the item `Claude Code-credentials` when the
// variable is unset and `Claude Code-credentials-<sha256(dir)[0..8]>` when it is
// set, so with the variable every profile has a slot of its own and nothing else
// to arrange. The unsuffixed item belongs to no profile on purpose: it is what
// every context without the variable writes to, the Desktop app's child sessions
// included, and a profile pinned there would be overwritten by whatever logged
// in last through such a context. That is exactly the bug the first version of
// ccp had.
//
// The ~/.claude symlink settles the config for no-variable contexts, but nothing
// about a symlink reaches the credential slot, which is why the init snippet
// exports the current profile at shell start — except for the Desktop app. It
// sources the shell at launch to learn PATH, would inherit the export into every
// session it spawns, and brings a login of its own; keeping it out of the
// profile's slot is what keeps the profile's login intact.

import { profileDir } from "./paths.ts";
import { emit, shq } from "./term.ts";

// Pure shell, no subprocess: this runs in every interactive shell. It reads the
// current profile afresh each time, so `ccp use` reaches new shells with no re-init.
export const SHELL_INIT = `ccp() {
	local __ccp_out
	__ccp_out="$(command ccp "$@")" || return $?
	[ -n "$__ccp_out" ] && eval "$__ccp_out"
	return 0
}

if [ -z "\${CLAUDE_CONFIG_DIR:-}" ] && [ "\${__CFBundleIdentifier:-}" != "com.anthropic.claudefordesktop" ] && [ -r "$HOME/.claude-profiles/.current" ]; then
	__ccp_current=$(cat "$HOME/.claude-profiles/.current" 2>/dev/null)
	if [ -n "$__ccp_current" ] && [ -d "$HOME/.claude-profiles/$__ccp_current" ]; then
		export CLAUDE_CONFIG_DIR="$HOME/.claude-profiles/$__ccp_current"
	fi
	unset __ccp_current
fi`;

/** Put this shell on `name`. */
export function emitUse(name: string): void {
	emit(`export CLAUDE_CONFIG_DIR=${shq(profileDir(name))}`);
	// An earlier ccp exported this to pin credential slots; a stale value from
	// such a shell would still steer the slot, so clear it.
	emit("unset CLAUDE_SECURESTORAGE_CONFIG_DIR");
}
