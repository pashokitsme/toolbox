#!/usr/bin/env bun
// ccp — Claude Code account profiles: several logins on one machine that share
// everything else, and no logging out and back in to move between them.
//
// Usage:
//   ccp                     list profiles (same as `ccp ls`)
//   ccp ls                  list profiles: account, plan, limits, which one is current
//   ccp <name>              switch to a profile: this shell now, and every new
//                           shell and no-variable context from here on
//   ccp use <name>          the same, and never ambiguous with a subcommand
//   ccp use --no-app <name> the same, leaving the Desktop app alone
//   ccp app <name>          tell ccp which profile the Desktop app is signed into
//   ccp new <name>          create a profile, then log into it with /login
//   ccp relink              share anything a session created inside a profile
//   ccp doctor              check the layout and report what is wrong
//   ccp migrate <name>      one-time: turn an existing ~/.claude into this layout
//   ccp migrate --dry-run <name>   print that plan without doing it
//   ccp migrate --undo      reverse that, while only one profile exists
//   ccp --shell-init        print the shell function (see Setup)
//   ccp --help              this text
//
// Setup:
//   Add to ~/.zshrc, after ccp is on PATH:
//       eval "$(ccp --shell-init)"
//   Then, with Claude fully quit, from a plain terminal:
//       ccp migrate max     (name it after the account ~/.claude is logged into)
//       ccp use max && claude   → /login as that account (once; see Credentials)
//       ccp new pro
//       ccp use pro && claude   → /login as the second account
//
// Switching: `ccp use <name>` is the whole interface. It moves the shell it runs
// in, retargets the two links below so every new shell and every no-variable
// context follows, and stays current until the next `ccp use`. A shell that was
// on another profile stays there until it runs `ccp use` itself.
//
// The Desktop app switches too. Its login is a few files under
// ~/Library/Application Support/Claude (the claude.ai cookie, config.json with
// the token it hands to its CLI sessions, the browser stores); each profile keeps
// its own copy under <profile>/desktop/, and `ccp use` quits the app, swaps the
// copies, and starts it again — so a running app closes, sessions included. A
// profile whose copy does not exist yet gets the app signed out; sign in there
// once and it is kept from then on. `--no-app` skips all of this — at a cost:
// the app's sessions use the current profile's config with the app's own
// credentials, and once a day record the app's account there, so a profile
// left current under an app on another account soon names that account. Which profile
// the app is on is read from the app's own record of its account; if that does
// not match any profile (the profile is not logged in on the CLI yet), say it
// with `ccp app <name>`.
//
// The app also keeps its session list — the sidebar — per account. ccp copies
// entries between those lists so every account shows every session; `ccp use`
// does it with the app closed mid-switch, `ccp relink` whenever it is not
// running, and accounts added later are picked up the same way. Delete a session
// in one account and it goes from the others too. The lists have to stay real
// directories — the app refuses symlinks under its own config root and then
// silently stops loading and saving sessions — so this is a copy, not a link,
// and the two lists are equal as of the last switch rather than continuously.
//
// Layout it maintains:
//   ~/.claude-shared/            the one real config home
//   ~/.claude-profiles/<name>/   a real .claude.json per account, links for the rest
//   ~/.claude       -> ~/.claude-profiles/<current>
//   ~/.claude.json  -> ~/.claude-profiles/<current>/.claude.json
//
// A profile changes the account and nothing else. Sessions, settings, CLAUDE.md,
// skills, plugins, hooks, history — every entry of the config home is shared by
// default, including ones Claude Code adds in a future version: `ccp relink` (and
// every `ccp use`) links whatever is in ~/.claude-shared into each profile, and
// `ccp doctor` reports anything a session created inside a profile instead.
// Private to a profile: the account file (.claude.json), the credentials, the
// daemon, and the usage cache. Because .claude.json also carries settings — MCP
// servers, per-project trust — `ccp use` carries over whatever settings keys
// changed in another profile since the last switch (it keeps a snapshot per
// profile to tell), so a change made under one account shows up under the other.
//
// Why two symlinks: Claude Code keeps the account in <configHome>/.claude.json
// when CLAUDE_CONFIG_DIR is set, and in $HOME/.claude.json when it is not.
// Retargeting only ~/.claude would leave every no-variable context — launchd,
// cron, the Desktop app — on the previous account.
//
// Credentials: Claude Code keeps the OAuth token in the login Keychain, in an
// item named `Claude Code-credentials` when CLAUDE_CONFIG_DIR is unset and
// `Claude Code-credentials-<sha256(dir)[0..8]>` when it is set. So with the
// variable, every profile owns a Keychain item of its own, and that is the whole
// mechanism — the shell function exports the variable, nothing more. The
// unsuffixed item belongs to no profile: every context that runs without the
// variable writes to it, the Desktop app's sessions included, so a profile
// pinned there would lose its login to whatever ran last. This is why the
// profile `ccp migrate` creates has to be logged into once more, and why the
// shell snippet does not export the variable into the Desktop app.
//
// /login uses the account the browser is signed into at claude.ai. A profile
// that shows the other profile's email in `ccp ls` got a /login from the wrong
// browser session: sign into the right account there (or use a private window)
// and /login again.
//
// What this does NOT do: it does not switch the account inside the Claude Desktop
// app. The app authenticates with its own web session and hands the token to the
// CLI it spawns — its sessions land in the shared history like everyone else's,
// but the account is the app's own, changed by logging out and in there.
//
// Limits: `ccp ls` shows every logged-in profile's plan windows — the 5-hour one
// and the weekly ones — as percent used and left, with the reset time both as a
// date and as a countdown; `ccp use` shows them for the profile it switched to.
// They come live from the same endpoint Claude Code's /usage reads, which takes
// the profile's OAuth access token, so ccp reads that token from the Keychain for
// the one request: never printed, stored, refreshed or sent anywhere but
// api.anthropic.com. An expired token is not refreshed — that rotates the
// refresh token, which is Claude Code's to do — and the numbers then come from
// Claude Code's own cached copy, labelled with its age.
//
// ccp never writes or moves a token. `ccp new` gets you as far as an empty
// profile; logging it in is `/login`, done by you.

import { existsSync } from "node:fs";
import { migrate, undoMigration } from "./migrate.ts";
import { nameError, profileDir } from "./paths.ts";
import {
	activeName,
	adoptUnshared,
	createProfile,
	doctor,
	isMigrated,
	list,
	listNames,
	readAccount,
	readCurrent,
	setCurrent,
	syncConfig,
	wireShared,
} from "./profile.ts";
import { appInstalled, appRunning, desktopChecks, hasSnapshot, liveProfile, profileForAppAccount, recordLive, sessionSyncPending, switchApp, syncSessionLists } from "./desktop.ts";
import { SHELL_INIT, emitUse } from "./shell.ts";
import { C, emit, fail, say } from "./term.ts";
import { accountNotes, formatUsage, inspect, trustedAccount } from "./usage.ts";

const HELP = `${C.bold("ccp")} — Claude Code account profiles

  ${C.cyan("ccp")}                  list profiles
  ${C.cyan("ccp ls")}               list profiles: account, plan, limits, which one is current
  ${C.cyan("ccp <name>")}           switch to a profile — this shell, new shells, everything
  ${C.cyan("ccp use <name>")}       the same, unambiguous with subcommands
  ${C.cyan("ccp use --no-app <name>")}  switch the command line only, leave the Desktop app alone
  ${C.cyan("ccp app <name>")}       tell ccp which profile the Desktop app is signed into
  ${C.cyan("ccp new <name>")}       create a profile (log into it with /login)
  ${C.cyan("ccp relink")}           share anything a session created inside a profile
  ${C.cyan("ccp doctor")}           check the layout
  ${C.cyan("ccp migrate <name>")}   one-time conversion of an existing ~/.claude (${C.dim("--dry-run")} to see the plan)
  ${C.cyan("ccp migrate --undo")}   reverse it, while only one profile exists
  ${C.cyan("ccp --shell-init")}     print the shell function for ~/.zshrc

${C.dim('Setup: eval "$(ccp --shell-init)" in ~/.zshrc, then, with Claude quit,')}
${C.dim("`ccp migrate <name>` from a plain terminal; /login once in each profile.")}

${C.dim("Profiles differ in the account only; everything else is shared.")}
${C.dim("Switching quits and restarts the Claude Desktop app with the profile's login;")}
${C.dim("a profile the app has never signed into starts it signed out — sign in once there.")}`;

function requireMigrated(): void {
	if (!isMigrated())
		fail(
			"not set up yet",
			"quit Claude, then run `ccp migrate <name>` from a plain terminal (see `ccp --help`)",
		);
}

function requireProfile(name: string): void {
	const err = nameError(name);
	if (err) fail(err);
	if (!existsSync(profileDir(name)))
		fail(`no profile named "${name}"`, `existing: ${listNames().join(", ") || "none"}`);
}

/** What every switch does first: pick up new shared entries, carry settings over. */
function refresh(name: string): void {
	for (const p of wireShared(profileDir(name))) say(`${C.yellow("!")} ${p}`);
	syncConfig(name);
}

/** Profiles on one account, judged by what each one's token says where it could say anything. */
function warnDuplicates(accounts: { name: string; email?: string }[]): void {
	const byEmail = new Map<string, string[]>();
	for (const a of accounts) if (a.email) byEmail.set(a.email, [...(byEmail.get(a.email) ?? []), a.name]);
	for (const [email, names] of byEmail) {
		if (names.length < 2) continue;
		say();
		say(`${C.yellow("!")} ${names.join(" and ")} are both logged in as ${email}`);
		say(C.dim("   a /login landed in the wrong profile: sign into the right account at claude.ai, then /login again there"));
	}
}

async function cmdList(): Promise<void> {
	requireMigrated();
	const profiles = list();
	if (!profiles.length) {
		say(C.dim("no profiles"));
		return;
	}
	// Every profile at once: a slow answer costs its own timeout, not the sum of them.
	const views = await Promise.all(profiles.map((p) => inspect(p.name, p.account?.uuid)));
	const width = Math.max(...profiles.map((p) => p.name.length));
	const indent = " ".repeat(width + 5);
	profiles.forEach((p, i) => {
		const view = views[i];
		// Only an account ccp can vouch for goes in the column: a config the token contradicts is not one.
		const shown = trustedAccount(p.account, view);
		const loggedIn = !!(shown || p.account || view?.tokenPlan);
		const mark = p.isActive ? C.green("*") : " ";
		const name = p.isCurrent ? C.bold(p.name.padEnd(width)) : p.name.padEnd(width);
		const account = shown
			? `${shown.email}  ${C.dim(shown.plan)}`
			: loggedIn
				? `${C.yellow("account unknown")}${view?.tokenPlan ? `  ${C.dim(view.tokenPlan)}` : ""}`
				: C.yellow("not logged in");
		const tag = p.isCurrent ? C.dim("  (current)") : "";
		say(` ${mark} ${name}  ${account}${tag}`);
		if (!view) return;
		for (const note of accountNotes(p.account, view)) say(`${indent}${note}`);
		if (loggedIn) for (const line of formatUsage(view.usage)) say(`${indent}${line}`);
	});
	const active = activeName();
	if (active && active !== readCurrent()) say(C.dim(`\n   this shell is still on ${active}; \`ccp use ${readCurrent()}\` brings it over`));
	if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined)
		say(C.yellow("\n   CLAUDE_SECURESTORAGE_CONFIG_DIR is set — left over from an earlier ccp; open a new shell"));
	if (appInstalled()) {
		const on = liveProfile();
		const kept = profiles.filter((p) => p.name !== on && hasSnapshot(p.name)).map((p) => p.name);
		say(
			C.dim(
				`\n   Desktop app: ${on ? `on ${on}` : "on an account no profile has — `ccp app <name>`"}${kept.length ? `; login kept for ${kept.join(", ")}` : ""}${appRunning() ? "" : " (not running)"}`,
			),
		);
		// The app's sessions run on the app's credentials but with ~/.claude.json, i.e. the current
		// profile's config, and rewrite the account recorded there once a day. Out of step, that
		// is how a profile ends up naming the other account.
		const current = readCurrent();
		if (on && current && on !== current)
			say(
				C.yellow(
					`   the app is on ${on} while ${current} is current — its sessions record ${on}'s account in ${current}'s config; \`ccp use ${current}\` brings the app in step`,
				),
			);
	}
	warnDuplicates(profiles.map((p, i) => ({ name: p.name, email: trustedAccount(p.account, views[i])?.email })));
}

/** Switch to a profile: this shell now, and the machine-wide current for everything else. */
async function cmdUse(name: string, app: boolean): Promise<void> {
	requireMigrated();
	requireProfile(name);
	refresh(name);
	setCurrent(name);
	emitUse(name);
	const file = readAccount(name);
	const view = await inspect(name, file?.uuid);
	const shown = trustedAccount(file, view);
	const loggedIn = !!(shown || file || view.tokenPlan);
	const who = shown
		? `  ${shown.email}  ${C.dim(shown.plan)}`
		: loggedIn
			? `  ${C.yellow("account unknown")}${view.tokenPlan ? `  ${C.dim(view.tokenPlan)}` : ""}`
			: "";
	say(`${C.green("→")} ${C.cyan(name)}${who}`);
	for (const note of accountNotes(file, view)) say(`   ${note}`);
	if (loggedIn) for (const line of formatUsage(view.usage)) say(`   ${line}`);
	if (app) {
		reportApp(switchApp(name), name);
		syncSessionListsIfClosed(); // switchApp does it too, unless it had nothing to switch
	} else if (appInstalled()) {
		const on = liveProfile();
		if (on && on !== name)
			say(C.yellow(`   the Desktop app stays on ${on} — its sessions will record ${on}'s account in ${name}'s config`));
	}
}

/** The app keeps one session list per account; even them up whenever it is not running. */
function syncSessionListsIfClosed(): boolean {
	if (!appInstalled() || !sessionSyncPending()) return true;
	if (appRunning()) {
		say(`${C.yellow("!")} Desktop app: its accounts hold different session lists — quit it and run \`ccp relink\``);
		return false;
	}
	const n = syncSessionLists();
	if (n) say(`  ${C.green("+")} Desktop app: ${n} session list ${n === 1 ? "entry" : "entries"} evened up`);
	return true;
}

function reportApp(result: ReturnType<typeof switchApp>, name: string): void {
	switch (result.kind) {
		case "no-app":
		case "same":
			return;
		case "unknown":
			say(`${C.yellow("!")} Desktop app left alone: cannot tell which profile it is signed into`);
			say(C.dim("   say so with `ccp app <name>`, then `ccp use` again — or `ccp use --no-app` to keep it that way"));
			return;
		case "switched":
			say(
				`${C.green("✓")} Desktop app: ${result.from} → ${C.cyan(name)}${result.relaunched ? C.dim("  (restarted)") : ""}${result.synced ? C.dim(`, ${result.synced} session entries evened up`) : ""}`,
			);
			return;
		case "fresh":
			say(`${C.green("✓")} Desktop app: ${result.from}'s login set aside${result.relaunched ? ", restarted" : ""} — it is signed out now`);
			say(C.dim(`   sign in there as ${name}'s account once; ccp keeps that login with the profile from then on`));
			return;
	}
}

/** Record which profile the Desktop app is signed into, for when ccp cannot tell. */
function cmdApp(name: string): void {
	requireMigrated();
	requireProfile(name);
	if (!appInstalled()) fail("no Desktop app state on this machine");
	const detected = profileForAppAccount();
	if (detected && detected !== name)
		fail(`the app says it is signed in as ${detected}'s account`, "sign out and in there, or name that profile");
	recordLive(name);
	say(`${C.green("✓")} the Desktop app is on ${C.cyan(name)}`);
}

function cmdNew(name: string): void {
	requireMigrated();
	const err = nameError(name);
	if (err) fail(err);
	if (existsSync(profileDir(name))) fail(`profile "${name}" already exists`);
	createProfile(name, readCurrent());
	say(`${C.green("✓")} created ${C.cyan(name)}`);
	say();
	say(`  ${C.bold(`ccp use ${name}`)} then ${C.bold("claude")} and ${C.bold("/login")}`);
	say(`  ${C.dim("(/login signs in as whoever the browser is signed in at claude.ai)")}`);
}

function cmdDoctor(): void {
	requireMigrated();
	const checks = [...doctor(), ...desktopChecks()];
	let bad = 0;
	for (const c of checks) {
		if (!c.ok) bad++;
		const mark = c.ok ? C.green("✓") : C.red("✗");
		say(` ${mark} ${c.label}${c.detail ? `  ${C.dim(c.detail)}` : ""}`);
	}
	if (bad) {
		say();
		say(C.yellow(`${bad} problem${bad === 1 ? "" : "s"}`));
		process.exit(1);
	}
}

function cmdRelink(): void {
	requireMigrated();
	const names = listNames();
	const problems: string[] = [];
	// Adopt everywhere first, then link everywhere: a directory adopted out of
	// the last profile has to show up in the first one too.
	for (const name of names) {
		const { adopted, problems: p } = adoptUnshared(profileDir(name));
		for (const e of adopted) say(`  ${C.green("+")} ${name}/${e} ${C.dim("-> shared")}`);
		problems.push(...p);
	}
	for (const name of names) problems.push(...wireShared(profileDir(name)));
	for (const p of problems) say(`${C.yellow("!")} ${p}`);
	if (!syncSessionListsIfClosed()) problems.push("app session lists");
	say(`${C.green("✓")} shared links refreshed${problems.length ? C.yellow(` (${problems.length} left for you)`) : ""}`);
	if (problems.length) process.exit(1);
}

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;

	switch (cmd) {
		case undefined:
		case "ls":
		case "list":
			return cmdList();
		case "-h":
		case "--help":
		case "help":
			return say(HELP);
		case "--shell-init":
			return emit(SHELL_INIT);
		case "use": {
			const app = !rest.includes("--no-app");
			const name = rest.find((a) => !a.startsWith("-"));
			if (!name) fail("`ccp use` needs a profile name", `existing: ${listNames().join(", ") || "none"}`);
			return cmdUse(name, app);
		}
		case "app": {
			const name = rest[0];
			if (!name) fail("`ccp app` needs the profile the Desktop app is signed into", `existing: ${listNames().join(", ") || "none"}`);
			return cmdApp(name);
		}
		case "new": {
			const name = rest[0];
			if (!name) fail("`ccp new` needs a name for the profile");
			return cmdNew(name);
		}
		case "doctor":
			return cmdDoctor();
		case "relink":
			return cmdRelink();
		case "migrate": {
			if (rest.includes("--undo")) return undoMigration();
			const dry = rest.includes("--dry-run") || rest.includes("-n");
			const name = rest.find((a) => !a.startsWith("-"));
			if (!name)
				fail(
					"`ccp migrate` needs a name for the profile ~/.claude becomes",
					"name it after the account it is logged into, e.g. `ccp migrate max`",
				);
			const err = nameError(name);
			if (err) fail(err);
			return migrate(name, dry);
		}
		default: {
			if (cmd.startsWith("-")) fail(`unknown option ${cmd}`, "see `ccp --help`");
			return cmdUse(cmd, !rest.includes("--no-app")); // `ccp max` is shorthand for `ccp use max`
		}
	}
}

await main(process.argv.slice(2));
