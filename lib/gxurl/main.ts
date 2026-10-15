#!/usr/bin/env bun
// gxurl — a Gramax link in, its enterprise or regular form or the article's
// path out.
//
//   gxurl -e <link>    https://app.gram.ax/<storage>/… → $GXURL_ENTERPRISE_URL/…
//   gxurl -r <link>    $GXURL_ENTERPRISE_URL/… → https://app.gram.ax/$GXURL_STORAGE/…
//   gxurl -p <link>    the article's path inside the catalog
//   gxurl <link>       ask which, in a small picker
//
// --help is the documentation. url.ts holds the rewrites, picker.ts the picker.

import { type Choice, choose, KEYS } from "./picker.ts";
import { C, colorful, paint, printable } from "./term.ts";
import { convert, DEFAULT_APP, type Env, LinkError, type Mode, sameLink } from "./url.ts";

const USAGE = `gxurl — turn a Gramax link into its enterprise or regular form, or a path

usage: gxurl [-e | -r | -p] [link...]

  https://app.gram.ax/gitlab.example.com/docs/handbook/master/-/guides/install
  -e  https://app-acme.gram.ax/docs/handbook/master/-/guides/install
  -p  guides/install

  https://app-acme.gram.ax/docs/handbook/master/-/guides/install
  -r  https://app.gram.ax/gitlab.example.com/docs/handbook/master/-/guides/install

Without -e, -r or -p a picker asks which, showing what each makes of the
first link, with the cursor on the first one that changes it. Without links
they are read from stdin when it is not a terminal, and from the clipboard
when it is or when stdin is empty. Each result goes to stdout on its own line
and onto the clipboard; a terminal sees a ✓ before each one that was copied.
When there is nothing to copy with, or copying fails, that is a warning and
the results still print.

options
  -e, --enterprise   the same page in the enterprise app at $GXURL_ENTERPRISE_URL
  -r, --regular      the same page in the regular app, https://app.gram.ax
  -p, --path         the article's path inside the catalog
  -h, --help         this text

enterprise
  The enterprise app knows a single storage, so its links have no storage
  segment: <storage>/<group>/<repo>/<branch>/<catalog>/… loses <storage>, the
  #heading and the query stay. A link that already is in that short form only
  moves to the enterprise address. With GXURL_STORAGE set, a link from another
  storage is an error, since the enterprise app would not open it; without it
  such a link converts all the same.

regular
  The other way: the enterprise app's short link gets its storage back from
  GXURL_STORAGE, and moves to GXURL_APP_URL. A long link — from the regular app,
  or the enterprise app's own long form — keeps its storage and only moves; one
  with "-" in the storage slot gets GXURL_STORAGE as well.

path
  What follows the catalog slot (the "-", or the catalog's name when it differs
  from the repository's), decoded: Cyrillic and spaces come out as they are. It
  is the article's logical path, not a file name — the article lives in
  <path>.md or <path>/_index.md, under the directory that holds the catalog's
  .doc-root.yaml, which is the repository root unless the catalog moved it. A
  link to the catalog itself has no path and is an error. Short-form links work
  here too.

env
  GXURL_ENTERPRISE_URL   address of the enterprise app, such as
                         https://app-acme.gram.ax; needed for -e only
  GXURL_STORAGE          the storage the enterprise app serves, such as
                         gitlab.example.com; -r needs it for short links, -e
                         checks links against it when it is set
  GXURL_APP_URL          address of the regular app for -r;
                         ${DEFAULT_APP} when unset

clipboard
  pbcopy and pbpaste on macOS; elsewhere wl-copy and wl-paste under Wayland,
  then xclip, then xsel.

exit status
  0 when every link converted; 1 when one did not (the rest still print) or on
  an error; 2 for a bad command line; 130 when the picker is left without a
  choice.

${KEYS}
`;

const err = colorful(process.stderr);

const die = (message: string, code = 1, hint?: string): never => {
	process.stderr.write(
		`gxurl: ${printable(message)}\n${hint ? `       ${hint}\n` : ""}`,
	);
	process.exit(code);
};

const usage = (message: string): never => die(message, 2, "see gxurl --help");

// ------------------------------------------------------------- command line

type Options = { mode?: Mode; links: string[] };

function parseArgs(argv: string[]): Options {
	const opts: Options = { links: [] };
	const setMode = (mode: Mode) => {
		if (opts.mode && opts.mode !== mode) usage("-e, -r and -p do not go together");
		opts.mode = mode;
	};
	const LONG: Record<string, () => void> = {
		"--enterprise": () => setMode("enterprise"),
		"--regular": () => setMode("regular"),
		"--path": () => setMode("path"),
		"--help": () => {
			process.stdout.write(USAGE);
			process.exit(0);
		},
	};
	const SHORT: Record<string, string> = {
		e: "--enterprise",
		r: "--regular",
		p: "--path",
		h: "--help",
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--") {
			opts.links.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const run = LONG[arg];
			if (!run) usage(`unknown option ${arg}`);
			run?.();
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (const ch of arg.slice(1)) {
				const long = SHORT[ch];
				if (!long) usage(`unknown option -${ch}`);
				LONG[long as string]?.();
			}
		} else opts.links.push(arg);
	}
	return opts;
}

// ---------------------------------------------------------------- clipboard

type Tool = { copy: string[]; paste: string[] };

function clipboardTool(): Tool | null {
	const tools: Tool[] =
		process.platform === "darwin"
			? [{ copy: ["pbcopy"], paste: ["pbpaste"] }]
			: [
					...(process.env.WAYLAND_DISPLAY
						? [{ copy: ["wl-copy"], paste: ["wl-paste", "--no-newline"] }]
						: []),
					{
						copy: ["xclip", "-selection", "clipboard"],
						paste: ["xclip", "-selection", "clipboard", "-o"],
					},
					{ copy: ["xsel", "--clipboard", "--input"], paste: ["xsel", "--clipboard", "--output"] },
				];
	return tools.find((t) => Bun.which(t.copy[0] as string)) ?? null;
}

const NO_CLIPBOARD = "no clipboard tool found (pbcopy, wl-copy, xclip or xsel)";

function readClipboard(): string {
	const tool = clipboardTool() ?? die(NO_CLIPBOARD);
	const run = Bun.spawnSync(tool.paste, { stderr: "pipe" });
	if (!run.success)
		die(`${tool.paste[0]} failed: ${run.stderr.toString().trim() || `exit ${run.exitCode}`}`);
	return run.stdout.toString();
}

/** Null when the text is on the clipboard, otherwise why it is not. */
function writeClipboard(text: string): string | null {
	const tool = clipboardTool();
	if (!tool) return NO_CLIPBOARD;
	const run = Bun.spawnSync(tool.copy, { stdin: Buffer.from(text), stderr: "pipe" });
	if (run.success) return null;
	return `${tool.copy[0]} failed: ${run.stderr.toString().trim() || `exit ${run.exitCode}`}`;
}

// --------------------------------------------------------------------- main

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

const ENV: Env = {
	enterprise: process.env.GXURL_ENTERPRISE_URL,
	app: process.env.GXURL_APP_URL,
	storage: process.env.GXURL_STORAGE,
};

/** One link's result, or the reason it has none. */
function attempt(link: string, mode: Mode): { ok: string } | { error: string } {
	try {
		return { ok: convert(link, mode, ENV) };
	} catch (e) {
		if (e instanceof LinkError) return { error: e.message };
		throw e;
	}
}

async function pickMode(first: string, more: number): Promise<Mode> {
	if (!process.stdin.isTTY || !process.stderr.isTTY)
		usage("choose -e, -r or -p: the picker needs stdin and stderr on a terminal");
	const modes: [Mode, string][] = [
		["enterprise", "e"],
		["regular", "r"],
		["path", "p"],
	];
	const choices: Choice[] = modes.map(([mode, key]) => {
		const r = attempt(first, mode);
		return "ok" in r
			? { key, label: mode, preview: r.ok }
			: { key, label: mode, preview: r.error.split("\n")[0] as string, error: true };
	});
	const title = more > 0 ? `${first}  (+${more} more)` : first;
	// an enterprise link would come back from -e as it is: start where it changes
	const start = choices.findIndex((c) => !c.error && !sameLink(c.preview, first));
	const index = await choose(title, choices, start);
	if (index === null) process.exit(130);
	return (modes[index] as [Mode, string])[0];
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));

	let links = opts.links;
	if (links.length === 0) {
		// an empty stdin is what a launcher or a script hands over, not a choice
		if (!process.stdin.isTTY) links = words(await Bun.stdin.text());
		if (links.length === 0) links = words(readClipboard());
		if (links.length === 0) die("no link given, and the clipboard holds none", 2, "see gxurl --help");
	}

	const mode = opts.mode ?? (await pickMode(links[0] as string, links.length - 1));

	const results: string[] = [];
	let failed = false;
	for (const link of links) {
		const r = attempt(link, mode);
		if ("ok" in r) {
			results.push(r.ok);
		} else {
			failed = true;
			process.stderr.write(
				`${paint(err, C.red, "gxurl:")} ${r.error.split("\n").map(printable).join("\n       ")}\n`,
			);
		}
	}

	// a clipboard that fails only warns: the results print all the same
	const problem = results.length > 0 ? writeClipboard(results.join("\n")) : null;
	if (problem)
		process.stderr.write(`${paint(err, C.yellow, "gxurl:")} not copied: ${printable(problem)}\n`);
	// what was copied, one line each, with the check glab-mrs puts in front of
	// a copied merge request; a pipe gets the bare results
	const mark = !problem && colorful(process.stdout) ? `${C.green}✓${C.reset} ` : "";
	for (const result of results) process.stdout.write(`${mark}${result}\n`);
	process.exit(failed ? 1 : 0);
}

await main();
