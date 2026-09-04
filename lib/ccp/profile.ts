// Reading, creating and selecting profiles. Everything here assumes the layout
// described in paths.ts already exists; `migrate.ts` is what builds it.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	CONFIG_LINK,
	CURRENT_FILE,
	GLOBAL_CONFIG,
	GLOBAL_CONFIG_LINK,
	PROFILES_DIR,
	SHARED_DIR,
	SETTINGS_SNAPSHOT,
	isIgnored,
	isPrivate,
	profileConfig,
	profileDir,
} from "./paths.ts";

// Keys of .claude.json that belong to one account. Every other key — MCP
// servers, per-project trust and permissions, onboarding flags — is a setting
// the user expects to be the same whichever account is in use, so `syncConfig`
// carries those between profiles and `createProfile` seeds them.
const ACCOUNT_SCOPED_KEYS = new Set([
	"oauthAccount",
	"userID",
	"anonymousId",
	"hasAvailableSubscription",
	"subscriptionNoticeCount",
	"modelAccessCache",
	"orgModelDefaultCache",
	"additionalModelCostsCache",
	"additionalModelOptionsCache",
	"overageCreditGrantCache",
	"passesEligibilityCache",
	"passesLastSeenRemaining",
	"s1mAccessCache",
	"cachedExtraUsageDisabledReason",
	"cachedStatsigGates",
	"cachedGrowthBookFeatures",
	"cachedGrowthBookFeaturesAt",
	"cachedExperimentData",
	"cachedExperimentFeatures",
	"metricsStatusCache",
	"clientDataCacheSlots",
]);

export type Account = {
	email: string;
	plan: string;
	uuid: string;
};

export type Profile = {
	name: string;
	dir: string;
	account?: Account;
	isCurrent: boolean;
	isActive: boolean;
};

export function isMigrated(): boolean {
	return existsSync(PROFILES_DIR) && isLink(CONFIG_LINK);
}

export function isLink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function mtimeMs(p: string): number | undefined {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return undefined;
	}
}

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
	} catch {
		return undefined;
	}
}

/** Temp file plus rename, so a session reading the file never sees half of it. */
function writeJson(path: string, value: Json): void {
	const tmp = `${path}.ccp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

function settingsOf(config: Json): Json {
	const out: Json = {};
	for (const [k, v] of Object.entries(config)) if (!ACCOUNT_SCOPED_KEYS.has(k)) out[k] = v;
	return out;
}

export function readAccount(name: string): Account | undefined {
	const oauth = readJson(profileConfig(name))?.oauthAccount as Json | undefined;
	if (!oauth || typeof oauth.emailAddress !== "string") return undefined;
	return {
		email: oauth.emailAddress,
		plan: planLabel(oauth),
		uuid: typeof oauth.accountUuid === "string" ? oauth.accountUuid : "?",
	};
}

function planLabel(oauth: Json): string {
	const type = String(oauth.organizationType ?? "");
	const base = type === "claude_max" ? "Max" : type === "claude_pro" ? "Pro" : type || "?";
	const mult = /max_(\d+)x/.exec(String(oauth.organizationRateLimitTier ?? ""))?.[1];
	return mult ? `${base} ${mult}x` : base;
}

/** The profile the machine is on: what the links point at and new shells pick up. */
export function readCurrent(): string | undefined {
	try {
		const name = readFileSync(CURRENT_FILE, "utf8").trim();
		return name || undefined;
	} catch {
		return undefined;
	}
}

/** Which profile this shell is on: the env var wins, otherwise the machine-wide one. */
export function activeName(): string | undefined {
	const env = process.env.CLAUDE_CONFIG_DIR;
	if (env) {
		const dir = resolve(env);
		if (dirname(dir) === PROFILES_DIR) return basename(dir);
		return undefined; // pointed somewhere ccp does not manage
	}
	return readCurrent();
}

export function listNames(): string[] {
	if (!existsSync(PROFILES_DIR)) return [];
	return readdirSync(PROFILES_DIR)
		.filter((e) => !e.startsWith("."))
		.filter((e) => {
			try {
				return lstatSync(join(PROFILES_DIR, e)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

export function list(): Profile[] {
	const current = readCurrent();
	const active = activeName();
	return listNames().map((name) => ({
		name,
		dir: profileDir(name),
		account: readAccount(name),
		isCurrent: name === current,
		isActive: name === active,
	}));
}

/** Profiles logged into the same account: a `/login` that landed in the wrong one. */
export function duplicateAccounts(): { email: string; names: string[] }[] {
	const byEmail = new Map<string, string[]>();
	for (const p of list()) {
		if (!p.account) continue;
		byEmail.set(p.account.email, [...(byEmail.get(p.account.email) ?? []), p.name]);
	}
	return [...byEmail].filter(([, names]) => names.length > 1).map(([email, names]) => ({ email, names }));
}

function linksTo(link: string, target: string): boolean {
	try {
		return resolve(join(link, ".."), readlinkSync(link)) === target;
	} catch {
		return false;
	}
}

/**
 * Give `dir` a link for every entry of ~/.claude-shared that it does not have
 * yet. Existing correct links are left alone; a real file or directory sitting
 * on a shared name is reported rather than replaced, because it may be the only
 * copy of something — `adoptUnshared` is the command that resolves those.
 */
export function wireShared(dir: string): string[] {
	const problems: string[] = [];
	for (const entry of readdirSync(SHARED_DIR)) {
		if (isPrivate(entry) || isIgnored(entry)) continue;
		const src = join(SHARED_DIR, entry);
		const dst = join(dir, entry);
		if (isLink(dst)) {
			if (linksTo(dst, src)) continue;
			problems.push(`${dst} pointed at ${readlinkSync(dst)}; now at ${src}`);
			unlinkSync(dst);
		} else if (existsSync(dst)) {
			problems.push(`${dst} is a real ${statSync(dst).isDirectory() ? "directory" : "file"}, not a link to ${src}`);
			continue;
		}
		symlinkSync(src, dst);
	}
	return problems;
}

/** Real, non-private entries of a profile: things a session created there instead of in the shared home. */
export function unsharedEntries(dir: string): string[] {
	return readdirSync(dir)
		.filter((e) => !isPrivate(e) && !isIgnored(e) && !isLink(join(dir, e)))
		.sort();
}

/**
 * Move every unshared entry of `dir` into ~/.claude-shared and link it back.
 * An entry that already exists in the shared home under the same name is left
 * where it is and reported: merging two real copies is a decision, not a rename.
 */
export function adoptUnshared(dir: string): { adopted: string[]; problems: string[] } {
	const adopted: string[] = [];
	const problems: string[] = [];
	for (const entry of unsharedEntries(dir)) {
		const src = join(dir, entry);
		const dst = join(SHARED_DIR, entry);
		if (existsSync(dst)) {
			problems.push(`${src} and ${dst} are both real — merge them by hand, then remove one`);
			continue;
		}
		renameSync(src, dst);
		symlinkSync(dst, src);
		adopted.push(entry);
	}
	return { adopted, problems };
}

/** Settings-only copy of a profile's .claude.json as of the last sync. */
function snapshotPath(name: string): string {
	return join(profileDir(name), SETTINGS_SNAPSHOT);
}

function readSnapshot(name: string): Json | undefined {
	return readJson(snapshotPath(name));
}

/**
 * Bring `target`'s settings up to date with what changed in the other profiles.
 *
 * "Changed" is measured against a per-profile snapshot of the settings keys
 * taken at the last sync, not against mtime: Claude Code rewrites .claude.json
 * on every run for its account-scoped caches, so a file being newer says
 * nothing about its settings. A key that differs from the snapshot in some
 * other profile is copied into `target` (a key removed there is removed here);
 * keys `target` changed itself are kept unless the same key changed elsewhere.
 * The source's snapshot is then brought up to date, `target`'s is not — so with
 * a third profile the change travels on at the next switch. Returns the names
 * the changes came from.
 */
export function syncConfig(target: string): string[] {
	const to = readJson(profileConfig(target));
	if (!to) return [];
	const merged: Json = { ...to };
	const from: string[] = [];
	const sources = listNames()
		.filter((n) => n !== target)
		.map((n) => ({ n, t: mtimeMs(profileConfig(n)) ?? 0 }))
		.sort((a, b) => a.t - b.t); // oldest first, so the newest change wins a conflict
	for (const { n } of sources) {
		const config = readJson(profileConfig(n));
		if (!config) continue;
		const now = settingsOf(config);
		const before = readSnapshot(n);
		if (!before) {
			// First sight of this profile: everything it has is worth carrying.
			writeJson(snapshotPath(n), now);
			for (const [k, v] of Object.entries(now)) if (!(k in merged)) merged[k] = v;
			if (Object.keys(now).some((k) => !(k in to))) from.push(n);
			continue;
		}
		let changed = false;
		for (const k of new Set([...Object.keys(now), ...Object.keys(before)])) {
			if (JSON.stringify(now[k]) === JSON.stringify(before[k])) continue;
			changed = true;
			if (k in now) merged[k] = now[k];
			else delete merged[k];
		}
		if (changed) {
			from.push(n);
			writeJson(snapshotPath(n), now);
		}
	}
	if (JSON.stringify(merged) !== JSON.stringify(to)) writeJson(profileConfig(target), merged);
	return from;
}

export function createProfile(name: string, seedFrom?: string): void {
	const dir = profileDir(name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const seed = seedFrom ? readJson(profileConfig(seedFrom)) : undefined;
	const settings = seed ? settingsOf(seed) : {};
	writeJson(profileConfig(name), settings);
	writeJson(snapshotPath(name), settings);
	wireShared(dir);
}

function assertRetargetable(link: string): void {
	if (existsSync(link) && !isLink(link))
		throw new Error(`${link} is a real ${statSync(link).isDirectory() ? "directory" : "file"}, not the symlink ccp maintains — see \`ccp doctor\``);
}

/** Replace a symlink in place: create it under a temp name, then rename over. */
function retarget(link: string, target: string): void {
	const tmp = `${link}.ccp-${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(target, tmp);
	renameSync(tmp, link);
}

export function setCurrent(name: string): void {
	// Both checks before either change, so a refusal leaves the pair consistent.
	assertRetargetable(CONFIG_LINK);
	assertRetargetable(GLOBAL_CONFIG_LINK);
	retarget(CONFIG_LINK, profileDir(name));
	retarget(GLOBAL_CONFIG_LINK, join(profileDir(name), GLOBAL_CONFIG));
	writeFileSync(CURRENT_FILE, `${name}\n`);
}

export type Check = { ok: boolean; label: string; detail?: string };

export function doctor(): Check[] {
	const checks: Check[] = [];
	const current = readCurrent();

	checks.push({
		ok: existsSync(SHARED_DIR),
		label: "~/.claude-shared exists",
		detail: existsSync(SHARED_DIR) ? undefined : "run `ccp migrate <name>` first",
	});
	checks.push({ ok: current !== undefined, label: "a current profile is recorded", detail: current });

	for (const [link, want] of [
		[CONFIG_LINK, current ? profileDir(current) : undefined],
		[GLOBAL_CONFIG_LINK, current ? join(profileDir(current), GLOBAL_CONFIG) : undefined],
	] as const) {
		if (!isLink(link)) {
			checks.push({ ok: false, label: `${link} is a symlink`, detail: "it is a real file or missing" });
			continue;
		}
		checks.push({
			ok: want !== undefined && linksTo(link, want),
			label: `${link} points at the current profile`,
			detail: readlinkSync(link),
		});
	}

	const shared = existsSync(SHARED_DIR)
		? readdirSync(SHARED_DIR).filter((e) => !isPrivate(e) && !isIgnored(e))
		: [];

	for (const name of listNames()) {
		const dir = profileDir(name);
		// A credentials file must be a real file: Claude Code refuses to follow a
		// symlink there, and says so by name.
		const creds = join(dir, ".credentials.json");
		if (isLink(creds))
			checks.push({ ok: false, label: `${name}: .credentials.json is a symlink`, detail: "replace it with the file itself" });

		const missing = shared.filter((e) => !linksTo(join(dir, e), join(SHARED_DIR, e)));
		checks.push({
			ok: missing.length === 0,
			label: `${name}: every shared entry is linked`,
			detail: missing.length ? `not linked: ${missing.join(", ")} — run \`ccp relink\`` : `${shared.length} entries`,
		});

		const unshared = unsharedEntries(dir);
		checks.push({
			ok: unshared.length === 0,
			label: `${name}: nothing created outside the shared home`,
			detail: unshared.length ? `${unshared.join(", ")} — run \`ccp relink\`` : undefined,
		});

		if (!readAccount(name))
			checks.push({ ok: false, label: `${name}: logged in`, detail: `run \`ccp use ${name}\` then \`/login\`` });
	}

	for (const d of duplicateAccounts())
		checks.push({
			ok: false,
			label: `${d.names.join(" and ")} are both logged in as ${d.email}`,
			detail: "a /login landed in the wrong profile: sign into the right account at claude.ai, then /login again there",
		});

	if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined)
		checks.push({
			ok: false,
			label: "CLAUDE_SECURESTORAGE_CONFIG_DIR is set in this shell",
			detail: "left over from an earlier ccp; it overrides the credential slot — open a new shell",
		});

	return checks;
}
