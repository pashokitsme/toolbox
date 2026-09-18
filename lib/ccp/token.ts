// A profile's OAuth token: reading it from the Keychain, and renewing it when
// it has run out.
//
// The access token Claude Code keeps lives eight hours, and only a `claude`
// started in that profile renews it — Desktop-app sessions run on the app's own
// token and never touch a profile's Keychain item. So a profile used mostly
// through the app has an expired token nearly all the time, although its
// refresh token is good for weeks. ccp renews it the way Claude Code does, so
// that `ccp ls` can ask for the account and the limits:
//
//   - under the same two locks Claude Code takes for a refresh:
//     <profile>/.oauth_refresh.lock and <realpath(profile)>.lock — directories
//     in proper-lockfile's format (mkdir to take, mtime as a heartbeat, stale
//     after 60 s, rmdir to release) — so ccp and a running `claude` never
//     post the same refresh token;
//   - re-reading the item once the locks are held: if somebody renewed it in
//     the meantime, their token is used and nothing is posted;
//   - POST https://platform.claude.com/v1/oauth/token with Claude Code's client
//     id and the scopes the token already has;
//   - writing back only if the item still holds the refresh token that was
//     posted (a compare-and-swap, as Claude Code does), through `security -i`
//     so the secret stays off the command line, every other field of the item
//     kept as it was.
//
// A running `claude` on that profile copes with this: before and after a
// refresh of its own it re-reads the item, and a changed access token counts
// as "refreshed by somebody else". The token is never printed, stored anywhere
// but the profile's own Keychain item, or sent anywhere but Anthropic.

import { realpathSync } from "node:fs";
import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { profileDir } from "./paths.ts";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Claude Code renews a token this long before it runs out. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** proper-lockfile's settings in Claude Code: stale after a minute, heartbeat every 5 s. */
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;
/** How long to wait for a lock somebody else holds before giving up. */
const LOCK_WAIT_MS = 8_000;
/** Longest line `security -i` reads; a longer command goes through argv, as in Claude Code. */
const SECURITY_LINE_MAX = 4032;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The Keychain item Claude Code uses for a config home it was started with. */
export function keychainService(dir: string): string {
	const hash = new Bun.CryptoHasher("sha256")
		.update(dir.normalize("NFC"))
		.digest("hex")
		.slice(0, 8);
	return `Claude Code-credentials-${hash}`;
}

/** What the item holds: the whole JSON, so a write-back keeps what ccp does not know about. */
export type Stored = { item: Json; oauth: Json };

function readItem(service: string): Stored | undefined {
	const r = Bun.spawnSync(
		["security", "find-generic-password", "-s", service, "-w"],
		{ stderr: "ignore" },
	);
	if (r.exitCode !== 0) return undefined;
	try {
		const item = JSON.parse(r.stdout.toString()) as unknown;
		if (!isObj(item) || !isObj(item.claudeAiOauth)) return undefined;
		return { item, oauth: item.claudeAiOauth };
	} catch {
		return undefined;
	}
}

/** The item's account attribute: `-U` updates only an item with the same one. */
function itemAccount(service: string): string {
	const r = Bun.spawnSync(
		["security", "find-generic-password", "-s", service],
		{
			stderr: "ignore",
		},
	);
	const m = /"acct"<blob>="([^"\\]*)"/.exec(r.stdout.toString());
	return m?.[1] ?? userInfo().username;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A profile's Keychain item as it is, without renewing anything. */
export function storedToken(name: string): Stored | undefined {
	return readItem(keychainService(profileDir(name)));
}

function needsRenewal(oauth: Json, now = Date.now()): boolean {
	const at = num(oauth.expiresAt);
	return at !== undefined && at <= now + EXPIRY_MARGIN_MS;
}

export type TokenState = {
	/** The item as it is now, renewed or not. */
	stored?: Stored;
	/** Set when the token is still (or again) not usable. */
	problem?: string;
	/** True when this call renewed the token, or found it renewed by somebody else. */
	renewed?: boolean;
};

// ---- locks, in proper-lockfile's format ------------------------------------

type Lock = { release: () => Promise<void> };

async function mtimeOf(path: string): Promise<number | undefined> {
	return stat(path).then(
		(s) => s.mtimeMs,
		() => undefined,
	);
}

async function takeLock(
	path: string,
	deadline: number,
): Promise<Lock | undefined> {
	for (;;) {
		try {
			await mkdir(path);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const mtime = await mtimeOf(path);
		// A holder that stopped its heartbeat a minute ago is gone; proper-lockfile takes such a lock over.
		if (
			mtime !== undefined &&
			Date.now() - mtime > LOCK_STALE_MS &&
			(await rmdir(path).then(
				() => true,
				() => false,
			))
		)
			continue;
		if (Date.now() >= deadline) return undefined;
		await Bun.sleep(250);
	}
	// Own the lock by its mtime, as proper-lockfile does: once it differs, somebody
	// took the lock over as stale, and it is theirs to touch and to remove.
	const now = new Date();
	await utimes(path, now, now).catch(() => {});
	let mine = await mtimeOf(path);
	let lost = false;
	const stillMine = async () => {
		if (lost) return false;
		const m = await mtimeOf(path);
		lost = m === undefined || m !== mine;
		return !lost;
	};
	let beating: Promise<void> = Promise.resolve();
	const beat = setInterval(() => {
		beating = (async () => {
			if (!(await stillMine())) return;
			const t = new Date();
			await utimes(path, t, t).catch(() => {});
			mine = await mtimeOf(path);
		})();
	}, LOCK_HEARTBEAT_MS);
	return {
		release: async () => {
			clearInterval(beat);
			await beating;
			if (await stillMine()) await rmdir(path).catch(() => {});
		},
	};
}

/** Both of Claude Code's refresh locks for a config home, the new one first, as it takes them. */
async function takeRefreshLocks(dir: string): Promise<Lock | undefined> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	const inner = await takeLock(join(dir, ".oauth_refresh.lock"), deadline);
	if (!inner) return undefined;
	let real = dir;
	try {
		real = realpathSync(dir);
	} catch {}
	let legacy: Lock | undefined;
	try {
		legacy = await takeLock(`${real}.lock`, deadline);
	} catch (err) {
		await inner.release();
		throw err;
	}
	if (!legacy) {
		await inner.release();
		return undefined;
	}
	return {
		release: async () => {
			await legacy.release();
			await inner.release();
		},
	};
}

// ---- the refresh itself ----------------------------------------------------

type Refreshed = {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	refreshTokenExpiresAt?: number;
	scopes?: string[];
};

type Posted = { ok: true; tokens: Refreshed } | { ok: false; why: string };

async function postRefresh(oauth: Json, refreshToken: string): Promise<Posted> {
	const scopes = Array.isArray(oauth.scopes)
		? oauth.scopes.filter((s): s is string => typeof s === "string")
		: [];
	const body: Json = {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: str(oauth.clientId) ?? CLIENT_ID,
	};
	if (scopes.length) body.scope = scopes.join(" ");
	let res: Response;
	try {
		res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		return {
			ok: false,
			why:
				err instanceof Error && err.name === "TimeoutError"
					? "renewal timed out"
					: "renewal failed — offline?",
		};
	}
	const data = (await res.json().catch(() => undefined)) as unknown;
	if (!res.ok) {
		const code = isObj(data) ? str(data.error) : undefined;
		return {
			ok: false,
			why:
				code === "invalid_grant"
					? "the refresh token is no longer valid"
					: `renewal refused (HTTP ${res.status}${code ? `, ${code}` : ""})`,
		};
	}
	const accessToken = isObj(data) ? str(data.access_token) : undefined;
	const expiresIn = isObj(data) ? num(data.expires_in) : undefined;
	if (!isObj(data) || !accessToken || expiresIn === undefined)
		return { ok: false, why: "the renewal answer held no token" };
	const now = Date.now();
	const rtIn = num(data.refresh_token_expires_in);
	const scope = str(data.scope);
	return {
		ok: true,
		tokens: {
			accessToken,
			refreshToken: str(data.refresh_token),
			expiresAt: now + expiresIn * 1000,
			refreshTokenExpiresAt: rtIn !== undefined ? now + rtIn * 1000 : undefined,
			scopes: scope ? scope.split(" ").filter(Boolean) : undefined,
		},
	};
}

async function writeItem(service: string, item: Json): Promise<boolean> {
	const account = itemAccount(service);
	const hex = Buffer.from(JSON.stringify(item), "utf8").toString("hex");
	const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
	const viaStdin =
		line.length <= SECURITY_LINE_MAX && !/["\\\n]/.test(account + service);
	const proc = viaStdin
		? Bun.spawn(["security", "-i"], {
				stdin: "pipe",
				stdout: "ignore",
				stderr: "ignore",
			})
		: Bun.spawn(
				[
					"security",
					"add-generic-password",
					"-U",
					"-a",
					account,
					"-s",
					service,
					"-X",
					hex,
				],
				{
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				},
			);
	if (viaStdin && proc.stdin) {
		proc.stdin.write(line);
		await proc.stdin.end();
	}
	return (await proc.exited) === 0;
}

/**
 * The profile's token, renewed first if it has run out (or is about to).
 * Never throws: whatever goes wrong comes back as `problem`.
 */
export async function usableToken(name: string): Promise<TokenState> {
	const dir = profileDir(name);
	const service = keychainService(dir);
	const first = readItem(service);
	if (!first)
		return {
			problem: `no token in the Keychain — \`ccp use ${name}\` then /login`,
		};
	if (!needsRenewal(first.oauth)) return { stored: first };
	if (!str(first.oauth.refreshToken))
		return {
			stored: first,
			problem: `token expired and holds no refresh token — /login in ${name}`,
		};

	let lock: Lock | undefined;
	try {
		lock = await takeRefreshLocks(dir);
	} catch {
		return {
			stored: first,
			problem: "token expired — could not take the refresh lock",
		};
	}
	if (!lock) {
		// Somebody else (a `claude` in that profile) is renewing it right now; their result is as good as ours.
		const after = readItem(service);
		if (after && !needsRenewal(after.oauth))
			return { stored: after, renewed: true };
		return {
			stored: after ?? first,
			problem:
				"token expired — Claude Code is renewing it, try again in a moment",
		};
	}

	try {
		const locked = readItem(service);
		if (!locked)
			return {
				problem: `no token in the Keychain — \`ccp use ${name}\` then /login`,
			};
		// Renewed while ccp waited for the lock.
		if (!needsRenewal(locked.oauth)) return { stored: locked, renewed: true };
		const posted = str(locked.oauth.refreshToken);
		if (!posted)
			return {
				stored: locked,
				problem: `token expired and holds no refresh token — /login in ${name}`,
			};

		const answer = await postRefresh(locked.oauth, posted);
		if (!answer.ok) {
			const after = readItem(service);
			if (
				after &&
				str(after.oauth.accessToken) !== str(locked.oauth.accessToken) &&
				!needsRenewal(after.oauth)
			)
				return { stored: after, renewed: true };
			const hint = answer.why.startsWith("the refresh token")
				? ` — /login in ${name}`
				: "";
			return { stored: locked, problem: `token expired; ${answer.why}${hint}` };
		}

		const t = answer.tokens;
		const savedNow = () => {
			const saved = readItem(service);
			return saved && str(saved.oauth.accessToken) === t.accessToken
				? saved
				: undefined;
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt) await Bun.sleep(100 * attempt);
			// Compare-and-swap: write only over the refresh token that was posted.
			const current = readItem(service);
			if (!current) continue;
			if (str(current.oauth.refreshToken) !== posted) {
				const saved = savedNow();
				if (saved) return { stored: saved, renewed: true };
				return needsRenewal(current.oauth)
					? { stored: current, problem: "token expired — somebody else replaced it meanwhile, try again" }
					: { stored: current, renewed: true };
			}
			const oauth: Json = {
				...current.oauth,
				accessToken: t.accessToken,
				refreshToken: t.refreshToken ?? posted,
				expiresAt: t.expiresAt,
			};
			if (t.refreshTokenExpiresAt !== undefined)
				oauth.refreshTokenExpiresAt = t.refreshTokenExpiresAt;
			if (t.scopes?.length) oauth.scopes = t.scopes;
			const item = { ...current.item, claudeAiOauth: oauth };
			if (await writeItem(service, item)) {
				const saved = savedNow();
				if (saved) return { stored: saved, renewed: true };
			}
		}
		const saved = savedNow();
		if (saved) return { stored: saved, renewed: true };
		// The server may have rotated the refresh token already; the old one in the item is then dead.
		return {
			stored: locked,
			problem:
				t.refreshToken && t.refreshToken !== posted
					? `renewed, but the Keychain write failed and the old refresh token is spent — /login in ${name}`
					: "renewed, but the Keychain write failed",
		};
	} finally {
		await lock.release();
	}
}
