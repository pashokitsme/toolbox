// The one command that rearranges an existing installation. Everything it does
// is a rename inside one filesystem plus two symlinks, so it is fast on a large
// ~/.claude and undoable — but it moves the directory Claude Code is reading, so
// it refuses to run while a session is registered against that directory.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_LINK,
	CURRENT_FILE,
	DESKTOP_FILE,
	GLOBAL_CONFIG,
	GLOBAL_CONFIG_LINK,
	HOME,
	PROFILES_DIR,
	SETTINGS_SNAPSHOT,
	SHARED_DIR,
	isIgnored,
	isPrivate,
	profileDir,
} from "./paths.ts";
import { isLink, isMigrated, listNames, setCurrent, unsharedEntries, wireShared } from "./profile.ts";
import { appRunning, unshareSessionLists } from "./desktop.ts";
import { C, emit, fail, say } from "./term.ts";

type Step = { describe: string; run: () => void; undo: () => void };

/** Remove a directory only if it is empty — the safety we want when unwinding. */
function rmdirIfEmpty(dir: string): void {
	try {
		rmdirSync(dir);
	} catch {
		// still holds something the user put there; leaving it is the safe answer
	}
}

/**
 * Sessions currently holding the config directory we are about to move.
 *
 * Claude Code registers every running session as <configHome>/sessions/<pid>.json,
 * so this is scoped to exactly the directory at risk rather than to "is any
 * Claude running anywhere" — and a file whose pid is gone is just stale.
 */
export function liveSessions(configHome: string): { pid: number; what: string }[] {
	const dir = join(configHome, "sessions");
	if (!existsSync(dir)) return [];
	const found: { pid: number; what: string }[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		const pid = Number(entry.slice(0, -".json".length));
		if (!Number.isInteger(pid) || pid <= 0) continue;
		try {
			process.kill(pid, 0); // liveness probe only; sends no signal
		} catch {
			continue; // stale registration
		}
		let what = "claude";
		try {
			const info = JSON.parse(readFileSync(join(dir, entry), "utf8")) as Record<string, unknown>;
			const parts = [info.entrypoint, info.cwd].filter((v) => typeof v === "string");
			if (parts.length) what = parts.join("  ");
		} catch {
			// an unreadable registration still counts as live
		}
		found.push({ pid, what });
	}
	return found;
}

/** Not a blocker: the app re-resolves the links for each session it spawns. */
function desktopRunning(): boolean {
	const ps = Bun.spawnSync(["ps", "-Ao", "args="]);
	return ps.stdout.toString().includes("/Claude.app/Contents/MacOS/");
}

function refuseIfInUse(configHome: string): void {
	const live = liveSessions(configHome);
	if (!live.length) return;
	say(`${C.red("ccp:")} ${live.length} Claude session${live.length === 1 ? " is" : "s are"} using ${configHome} — quit them first:`);
	for (const p of live.slice(0, 8)) say(`      ${C.dim(String(p.pid).padStart(6))}  ${p.what}`);
	if (live.length > 8) say(`      ${C.dim(`… and ${live.length - 8} more`)}`);
	process.exit(1);
}

function assertReady(): void {
	if (process.env.CLAUDECODE)
		fail(
			"refusing to migrate from inside a Claude Code session",
			"quit Claude entirely, then run `ccp migrate` from a plain terminal",
		);
	if (isMigrated()) fail("already migrated", "use `ccp new <name>` to add a profile, `ccp ls` to see them");
	if (existsSync(PROFILES_DIR)) fail(`${PROFILES_DIR} already exists`, "move it aside and try again");
	if (existsSync(SHARED_DIR)) fail(`${SHARED_DIR} already exists`, "move it aside and try again");

	if (!existsSync(CONFIG_LINK)) fail(`${CONFIG_LINK} does not exist`, "nothing to migrate");
	if (isLink(CONFIG_LINK)) fail(`${CONFIG_LINK} is already a symlink`, "ccp did not put it there");
	if (!statSync(CONFIG_LINK).isDirectory()) fail(`${CONFIG_LINK} is not a directory`);

	if (isLink(GLOBAL_CONFIG_LINK)) fail(`${GLOBAL_CONFIG_LINK} is already a symlink`, "ccp did not put it there");

	if (statSync(CONFIG_LINK).dev !== statSync(HOME).dev)
		fail(
			`${CONFIG_LINK} sits on a different filesystem than ${HOME}`,
			"the migration relies on rename, which cannot cross devices",
		);

	refuseIfInUse(CONFIG_LINK);

	if (desktopRunning())
		say(
			`${C.yellow("!")} Claude Desktop is open with no active session. Quit it too — it could start one mid-migration.`,
		);
}

function plan(name: string): Step[] {
	const dir = profileDir(name);
	const steps: Step[] = [];

	steps.push({
		describe: `create ${PROFILES_DIR} and ${SHARED_DIR}`,
		run: () => {
			mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
			mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
		},
		undo: () => {
			rmdirIfEmpty(SHARED_DIR);
			rmdirIfEmpty(PROFILES_DIR);
		},
	});

	const shared = readdirSync(CONFIG_LINK).filter((e) => !isPrivate(e) && !isIgnored(e)).sort();
	for (const entry of shared) {
		const from = join(CONFIG_LINK, entry);
		const to = join(SHARED_DIR, entry);
		steps.push({
			describe: `move ~/.claude/${entry} -> ~/.claude-shared/${entry}`,
			run: () => renameSync(from, to),
			undo: () => renameSync(to, from),
		});
	}

	steps.push({
		describe: `move ~/.claude -> ~/.claude-profiles/${name} (keeping what is private to the account)`,
		run: () => renameSync(CONFIG_LINK, dir),
		undo: () => renameSync(dir, CONFIG_LINK),
	});

	if (existsSync(GLOBAL_CONFIG_LINK)) {
		const stub = join(dir, GLOBAL_CONFIG);
		const kept = join(dir, `${GLOBAL_CONFIG}.pre-ccp`);
		// ~/.claude/.claude.json exists too, but it is the newer, near-empty
		// location; the live account lives in the HOME-level file. Keep the
		// small one rather than let the move silently drop it. One rename per
		// step, so a failure between the two rolls back exactly what happened.
		// The profile directory does not exist yet at planning time: look inside ~/.claude.
		if (existsSync(join(CONFIG_LINK, GLOBAL_CONFIG)))
			steps.push({
				describe: `set the old ~/.claude/.claude.json aside as .claude.json.pre-ccp`,
				run: () => renameSync(stub, kept),
				undo: () => renameSync(kept, stub),
			});
		steps.push({
			describe: `move ~/.claude.json into the profile`,
			run: () => renameSync(GLOBAL_CONFIG_LINK, stub),
			undo: () => renameSync(stub, GLOBAL_CONFIG_LINK),
		});
	}

	steps.push({
		describe: `link the shared entries into the profile`,
		run: () => {
			const problems = wireShared(dir);
			if (problems.length) throw new Error(problems.join("; "));
		},
		undo: () => {
			for (const entry of shared) rmSync(join(dir, entry), { force: true });
		},
	});

	steps.push({
		describe: `point ~/.claude and ~/.claude.json at the profile`,
		run: () => {
			try {
				symlinkSync(dir, CONFIG_LINK);
				symlinkSync(join(dir, GLOBAL_CONFIG), GLOBAL_CONFIG_LINK);
				setCurrent(name);
			} catch (err) {
				// A half-made step is not in `done`; leave nothing behind for the undo of the previous steps to trip on.
				for (const link of [CONFIG_LINK, GLOBAL_CONFIG_LINK]) if (isLink(link)) unlinkSync(link);
				rmSync(CURRENT_FILE, { force: true });
				throw err;
			}
		},
		undo: () => {
			unlinkSync(CONFIG_LINK);
			unlinkSync(GLOBAL_CONFIG_LINK);
			rmSync(CURRENT_FILE, { force: true });
		},
	});

	return steps;
}

export function migrate(name: string, dryRun: boolean): void {
	assertReady();
	const steps = plan(name);

	if (dryRun) {
		say(`${C.bold("ccp migrate")} ${C.cyan(name)} ${C.dim("(dry run — nothing changed)")}`);
		for (const s of steps) say(`  ${C.dim("·")} ${s.describe}`);
		return;
	}

	const done: Step[] = [];
	try {
		for (const s of steps) {
			s.run();
			done.push(s);
		}
	} catch (err) {
		say(`${C.red("ccp:")} migration failed at step ${done.length + 1}: ${err instanceof Error ? err.message : String(err)}`);
		say(`${C.yellow("     rolling back…")}`);
		for (const s of done.reverse()) {
			try {
				s.undo();
			} catch (e) {
				say(`${C.red("     rollback failed:")} ${s.describe}: ${e instanceof Error ? e.message : String(e)}`);
				say(`${C.red("     stopping — fix this by hand before running Claude again")}`);
				process.exit(2);
			}
		}
		say(`${C.green("     rolled back; nothing changed")}`);
		process.exit(1);
	}

	say(`${C.green("✓")} migrated into profile ${C.cyan(name)}`);
	say();
	say(`  ${C.dim("its login now lives in a Keychain item of its own, so once:")} ${C.bold("ccp use " + name)} ${C.dim("then")} ${C.bold("claude")} ${C.dim("and")} ${C.bold("/login")}`);
	say(`  ${C.dim("then")} ${C.bold("ccp new <other-name>")} ${C.dim("and /login in that one too")}`);
}

/**
 * Reverse a migration. Only meaningful while exactly one profile exists.
 * Everything that can go wrong is checked before the first change, because
 * this path has no rollback: it starts by removing the two links in HOME.
 */
export function undoMigration(): void {
	if (process.env.CLAUDECODE) fail("refusing to undo from inside a Claude Code session", "quit Claude first");
	if (!isMigrated()) fail("not migrated", "nothing to undo");
	const names = listNames();
	if (names.length !== 1)
		fail(
			`${names.length} profiles exist (${names.join(", ")})`,
			"undo only handles a single profile — delete the others first",
		);
	const name = names[0] as string;
	const dir = profileDir(name);
	const stub = join(dir, GLOBAL_CONFIG);
	const kept = join(dir, `${GLOBAL_CONFIG}.pre-ccp`);

	if (!isLink(GLOBAL_CONFIG_LINK)) fail(`${GLOBAL_CONFIG_LINK} is not a symlink`, "ccp did not leave it like that; see `ccp doctor`");
	if (!existsSync(stub)) fail(`${stub} is missing`, "the profile has no account file to put back");
	const unshared = unsharedEntries(dir);
	if (unshared.length)
		fail(`${name} holds ${unshared.join(", ")} outside the shared home`, "run `ccp relink` first, so nothing is overwritten");
	refuseIfInUse(CONFIG_LINK);
	if (appRunning()) fail("the Claude Desktop app is running", "quit it first: its session list has to be handed back to each account");

	unshareSessionLists();
	unlinkSync(CONFIG_LINK);
	unlinkSync(GLOBAL_CONFIG_LINK);
	for (const entry of readdirSync(dir)) if (!isPrivate(entry) && isLink(join(dir, entry))) unlinkSync(join(dir, entry));
	renameSync(stub, GLOBAL_CONFIG_LINK);
	if (existsSync(kept)) renameSync(kept, stub);
	renameSync(dir, CONFIG_LINK);
	for (const entry of readdirSync(SHARED_DIR)) renameSync(join(SHARED_DIR, entry), join(CONFIG_LINK, entry));
	rmSync(join(CONFIG_LINK, SETTINGS_SNAPSHOT), { force: true });
	rmSync(CURRENT_FILE, { force: true });
	rmSync(DESKTOP_FILE, { force: true }); // the app's login stays where it is; only the record goes
	rmdirIfEmpty(SHARED_DIR);
	rmdirIfEmpty(PROFILES_DIR);
	// This runs through the shell function, so the shell that asked is cleaned up here;
	// the others still export the profile's path and have to be told.
	emit("unset CLAUDE_CONFIG_DIR");
	say(`${C.green("✓")} undone — ~/.claude is a real directory again`);
	say(C.dim("  other open shells still have CLAUDE_CONFIG_DIR set to the old profile: `unset CLAUDE_CONFIG_DIR` there, or open new ones"));
}
