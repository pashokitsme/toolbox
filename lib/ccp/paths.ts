// The layout ccp maintains, and the rule for what two accounts share.
//
//   ~/.claude-shared/            the one real config home: history, settings,
//                                skills, plugins, runtime state — everything
//   ~/.claude-profiles/<name>/   one entry per account: a real .claude.json,
//                                private credential state, and a symlink into
//                                ~/.claude-shared for every other entry
//   ~/.claude-profiles/.current  name of the profile the two links below point at
//   ~/.claude       -> ~/.claude-profiles/<current>
//   ~/.claude.json  -> ~/.claude-profiles/<current>/.claude.json
//
// Two links, not one, because Claude Code keeps its account in two places
// depending on how it was started: with CLAUDE_CONFIG_DIR set the global config
// file is <configHome>/.claude.json, and without it the file is $HOME/.claude.json,
// outside the config home entirely. Retargeting only ~/.claude would switch
// skills and history but leave every no-env-var context (the Desktop app's child
// CLI, launchd, cron) on the old account. Both links are verified to survive:
// Claude Code writes through them and does not replace them with real files.
//
// Shared is the default; private is the exception. A profile exists to change
// the account and nothing else, so a new entry Claude Code grows in a future
// version is shared the moment `ccp relink` (or any `ccp use`) sees it in
// ~/.claude-shared, and an entry a session creates inside a profile is reported
// by `ccp doctor` and moved over by `ccp relink`.

import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const PROFILES_DIR = join(HOME, ".claude-profiles");
export const SHARED_DIR = join(HOME, ".claude-shared");
export const CURRENT_FILE = join(PROFILES_DIR, ".current");
/** Name of the profile whose Desktop-app login is the live one (see desktop.ts). */
export const DESKTOP_FILE = join(PROFILES_DIR, ".desktop");
/** The Desktop app's session list, shared between accounts (see desktop.ts). */
export const APP_SESSIONS_SHARED = join(PROFILES_DIR, ".app-sessions");

/** The two symlinks `ccp use` retargets. */
export const CONFIG_LINK = join(HOME, ".claude");
export const GLOBAL_CONFIG_LINK = join(HOME, ".claude.json");

/** Basename of the global config file inside a profile. */
export const GLOBAL_CONFIG = ".claude.json";

/** Settings-only copy of .claude.json as of the last `ccp use`; what syncConfig diffs against. */
export const SETTINGS_SNAPSHOT = ".ccp-settings.json";

/**
 * Entries that stay inside a profile. Everything that identifies or
 * authenticates the account, plus the daemon, which holds a login of its own.
 */
export function isPrivate(entry: string): boolean {
	return (
		entry === GLOBAL_CONFIG ||
		entry.startsWith(`${GLOBAL_CONFIG}.`) || // .claude.json.backup, .pre-ccp
		entry === "backups" || // Claude Code's own copies of .claude.json
		entry === ".credentials.json" || // plaintext fallback for the Keychain
		entry === "daemon" ||
		entry.startsWith("daemon.") ||
		entry.startsWith("daemon-") ||
		entry === "stats-cache.json" ||
		entry === "desktop" || // the Desktop app's login, kept by ccp
		entry.startsWith(".ccp-")
	);
}

/** Noise that is neither shared nor worth reporting. */
export function isIgnored(entry: string): boolean {
	return entry === ".DS_Store";
}

// Words that can never be a profile name, because `ccp <name>` is shorthand for
// `ccp use <name>` and a subcommand has to win the collision.
export const RESERVED = new Set(["use", "ls", "list", "new", "app", "doctor", "relink", "migrate", "help"]);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function nameError(name: string): string | undefined {
	if (!NAME_RE.test(name))
		return `"${name}" is not a usable profile name: start with a letter or digit, then letters, digits, dot, dash or underscore`;
	if (RESERVED.has(name)) return `"${name}" is a ccp subcommand, so it cannot name a profile`;
	return undefined;
}

export function profileDir(name: string): string {
	return join(PROFILES_DIR, name);
}

export function profileConfig(name: string): string {
	return join(profileDir(name), GLOBAL_CONFIG);
}
