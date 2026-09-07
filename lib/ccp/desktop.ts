// The Claude Desktop app's login, and how ccp moves it between profiles.
//
// The app does not authenticate the way the CLI does: it signs into claude.ai
// with a web session and hands the resulting OAuth token to every CLI session it
// spawns. Its state lives in ~/Library/Application Support/Claude, and the
// account-bearing part of it is a handful of entries: the cookie jar (the
// claude.ai `sessionKey`), config.json (`lastKnownAccountUuid` and the token
// cache the child CLIs get), and the three browser stores. Everything else there
// — preferences, caches, the per-account session registries, the bundled CLI —
// is account-neutral and stays put.
//
// So a profile keeps a snapshot of those entries under <profile>/desktop/, and
// `ccp use` swaps them: quit the app, move the live entries into the outgoing
// profile's snapshot, move the incoming profile's snapshot into place, start the
// app again. A profile with no snapshot yet gets the app with no login at all,
// so the user signs in there once and the files are kept from then on. Which
// profile the live entries belong to is recorded in ~/.claude-profiles/.desktop;
// when that is missing, `lastKnownAccountUuid` is matched against the profiles'
// own account ids.
//
// The app's session list — the sidebar — is a second thing it keeps per account:
// one directory of entries under claude-code-sessions/<account>/<organization>/,
// each entry naming a transcript in the shared history. The transcripts are
// already common to both profiles; the lists are not, so the same session shows
// up in one account and not the other. ccp copies the entries so that every list
// holds all of them, and does it while the app is closed, at every switch.
//
// Copying rather than one shared directory behind symlinks: the app refuses to
// read or write through a symlink inside its own directory — "components under
// the config root may not be symlinks" — and goes quiet about it, loading no
// sessions at all and persisting none. Only the whole config root may be moved.
// So the lists stay real directories that ccp keeps equal. A deletion wins over
// a copy, so removing a session in one account removes it everywhere; entries
// carry the MCP configuration of the account that made them, and under the other
// account that part is stale and the app is left to cope.
//
// The app must not be running while its files move — it holds them open and
// writes on quit. "Running" is decided by a helper process carrying
// `--user-data-dir=<that directory>`, so a test against another HOME never sees
// the real app, and never quits it.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_FILE, HOME, profileDir } from "./paths.ts";
import { type Check, listNames, readAccount } from "./profile.ts";

export const APP_DIR = join(HOME, "Library", "Application Support", "Claude");
const APP_NAME = "Claude";

/** The entries that carry the login. Order does not matter; all move together. */
const ENTRIES = ["Cookies", "Cookies-journal", "config.json", "Local Storage", "Session Storage", "IndexedDB"] as const;

export function snapshotDir(name: string): string {
	return join(profileDir(name), "desktop");
}

export function appInstalled(): boolean {
	return existsSync(APP_DIR);
}

export function hasSnapshot(name: string): boolean {
	return existsSync(join(snapshotDir(name), "config.json"));
}

/** The account the app was last signed into, by its own record. */
export function appAccountUuid(): string | undefined {
	try {
		const cfg = JSON.parse(readFileSync(join(APP_DIR, "config.json"), "utf8")) as Record<string, unknown>;
		return typeof cfg.lastKnownAccountUuid === "string" ? cfg.lastKnownAccountUuid : undefined;
	} catch {
		return undefined;
	}
}

/** The profile whose account the app is signed into, if any profile has that account. */
export function profileForAppAccount(): string | undefined {
	const uuid = appAccountUuid();
	if (!uuid) return undefined;
	return listNames().find((n) => readAccount(n)?.uuid === uuid);
}

/** Whose files are live in the app directory: the record first, the app's own account otherwise. */
export function liveProfile(): string | undefined {
	try {
		const name = readFileSync(DESKTOP_FILE, "utf8").trim();
		if (name && existsSync(profileDir(name))) return name;
	} catch {
		// not recorded yet
	}
	return profileForAppAccount();
}

export function recordLive(name: string): void {
	writeFileSync(DESKTOP_FILE, `${name}\n`);
}

function helperPids(): number[] {
	const ps = Bun.spawnSync(["ps", "-Ao", "pid=,args="]);
	const marker = `--user-data-dir=${APP_DIR}`;
	const pids: number[] = [];
	for (const line of ps.stdout.toString().split("\n")) {
		if (!line.includes(marker)) continue;
		const pid = Number(line.trim().split(/\s+/)[0]);
		if (Number.isInteger(pid)) pids.push(pid);
	}
	return pids;
}

export function appRunning(): boolean {
	return helperPids().length > 0;
}

function sleep(ms: number): void {
	Bun.sleepSync(ms);
}

/** Ask the app to quit and wait for it; throws if it is still there after the deadline. */
export function quitApp(): void {
	Bun.spawnSync(["osascript", "-e", `quit app "${APP_NAME}"`]);
	for (let waited = 0; waited < 20_000; waited += 250) {
		if (!appRunning()) {
			sleep(500); // let the last file writes land
			return;
		}
		sleep(250);
	}
	throw new Error("Claude Desktop did not quit — close it yourself and run `ccp use` again");
}

export function launchApp(): void {
	Bun.spawn(["open", "-a", APP_NAME], { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

export type AppSwitch =
	| { kind: "no-app" } // not installed here
	| { kind: "same" } // already on that profile
	| { kind: "unknown" } // whose login is live cannot be told; nothing moved
	| { kind: "switched"; from: string; relaunched: boolean; synced: number }
	| { kind: "fresh"; from: string; relaunched: boolean; synced: number }; // target had no snapshot: app starts signed out

/**
 * Put the app on `target`. Quits it if it is running, and starts it again after.
 */
export function switchApp(target: string): AppSwitch {
	if (!appInstalled()) return { kind: "no-app" };
	const from = liveProfile();
	if (from === target) return { kind: "same" };
	if (!from) return { kind: "unknown" };

	const running = appRunning();
	if (running) quitApp();

	const out = snapshotDir(from);
	mkdirSync(out, { recursive: true, mode: 0o700 });
	for (const e of ENTRIES) {
		const live = join(APP_DIR, e);
		if (!existsSync(live)) continue;
		const kept = join(out, e);
		rmSync(kept, { recursive: true, force: true });
		renameSync(live, kept);
	}
	const fresh = !hasSnapshot(target);
	if (!fresh) {
		const inDir = snapshotDir(target);
		for (const e of ENTRIES) {
			const kept = join(inDir, e);
			if (existsSync(kept)) renameSync(kept, join(APP_DIR, e));
		}
	}
	recordLive(target);
	const synced = syncSessionLists(); // with the app down, this is the moment the lists can move
	if (running) launchApp();
	return fresh ? { kind: "fresh", from, relaunched: running, synced } : { kind: "switched", from, relaunched: running, synced };
}

const APP_SESSIONS = join(APP_DIR, "claude-code-sessions");

function isDir(p: string): boolean {
	try {
		return lstatSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Every <account>/<organization> list the app keeps. */
function sessionLists(): string[] {
	if (!existsSync(APP_SESSIONS)) return [];
	const out: string[] = [];
	for (const account of readdirSync(APP_SESSIONS)) {
		const dir = join(APP_SESSIONS, account);
		if (!isDir(dir)) continue;
		for (const org of readdirSync(dir)) {
			const list = join(dir, org);
			if (isDir(list)) out.push(list);
		}
	}
	return out;
}

const ENTRY = /^local_.+\.json$/;
const MARKER = /^deleted_/;

type SessionSync = { copy: { from: string; to: string }[]; remove: string[] };

/**
 * What it would take for every list to hold the same sessions: the newest copy
 * of each entry everywhere, every deletion marker everywhere, and no entry that
 * some account has deleted.
 */
function planSessionSync(): SessionSync {
	const lists = sessionLists();
	if (lists.length < 2) return { copy: [], remove: [] };

	const newest = new Map<string, { path: string; mtime: number }>();
	const markers = new Map<string, string>();
	const deleted = new Set<string>();
	const present = new Map<string, Set<string>>();

	for (const list of lists) {
		for (const name of readdirSync(list)) {
			const path = join(list, name);
			if (MARKER.test(name)) {
				deleted.add(name.slice("deleted_".length));
				if (!markers.has(name)) markers.set(name, path);
			} else if (!ENTRY.test(name)) {
				continue; // whatever else the app keeps there stays with its account
			} else {
				const mtime = statSync(path).mtimeMs;
				const best = newest.get(name);
				if (!best || mtime > best.mtime) newest.set(name, { path, mtime });
			}
			present.set(name, (present.get(name) ?? new Set()).add(list));
		}
	}

	const plan: SessionSync = { copy: [], remove: [] };
	for (const [name, best] of newest) {
		const id = name.slice("local_".length, -".json".length);
		if (deleted.has(id)) {
			for (const list of present.get(name) ?? []) plan.remove.push(join(list, name));
			continue;
		}
		for (const list of lists) {
			const here = join(list, name);
			if (here === best.path) continue;
			if (existsSync(here) && statSync(here).mtimeMs >= best.mtime) continue;
			plan.copy.push({ from: best.path, to: here });
		}
	}
	for (const [name, from] of markers)
		for (const list of lists) {
			const here = join(list, name);
			if (!existsSync(here)) plan.copy.push({ from, to: here });
		}
	return plan;
}

/** How many files are out of step between the lists. */
export function sessionSyncPending(): number {
	const plan = planSessionSync();
	return plan.copy.length + plan.remove.length;
}

/** Make every list hold the same sessions. Only with the app closed. */
export function syncSessionLists(): number {
	const plan = planSessionSync();
	for (const path of plan.remove) rmSync(path, { force: true });
	for (const { from, to } of plan.copy) {
		copyFileSync(from, to);
		const src = statSync(from);
		// The mtime is what "which copy is newer" means here, so it has to survive
		// exactly: passing Dates truncates to whole milliseconds and the copy then
		// reads as older than its source for good, syncing the same file every time.
		utimesSync(to, src.atimeMs / 1000, src.mtimeMs / 1000);
	}
	return plan.copy.length + plan.remove.length;
}

export function desktopChecks(): Check[] {
	if (!appInstalled()) return [];
	const recorded = (() => {
		try {
			return readFileSync(DESKTOP_FILE, "utf8").trim() || undefined;
		} catch {
			return undefined;
		}
	})();
	const detected = profileForAppAccount();
	if (recorded && detected && recorded !== detected)
		return [
			{
				ok: false,
				label: `Desktop app: recorded as ${recorded}, signed in as ${detected}'s account`,
				detail: "sign in there as the right account, or `ccp app " + detected + "`",
			},
		];
	const on = recorded ?? detected;
	const pending = sessionSyncPending();
	return [
		{
			ok: on !== undefined,
			label: "Desktop app: which profile it is on",
			detail: on ?? "unknown — `ccp app <name>`",
		},
		{
			ok: pending === 0,
			label: "Desktop app: every account sees every session",
			detail: pending ? `${pending} entries out of step — quit the app and run \`ccp relink\`` : undefined,
		},
	];
}

