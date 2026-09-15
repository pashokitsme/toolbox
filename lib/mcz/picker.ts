// The full-screen file list: walk directories, mark photos and videos, hand the
// marked paths back. Nothing here compresses — main does that once the screen
// is gone, so progress and results land in the terminal's own history.

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isCompressedName, kindByExt } from "./compress.ts";
import {
	AltScreen,
	C,
	decodeKeys,
	disableKittyKeys,
	displayWidth,
	enableKittyKeys,
	fitTo,
	hideCursor,
	humanSize,
	type Key,
	padTo,
	printable,
	showCursor,
	tildify,
	truncateStart,
} from "./term.ts";

export const KEYS = `keys
  j k  up down       move                     g G  home end   top, bottom
  pgup pgdn          a page at a time
  l  right  enter    open the directory       h  left  backspace   parent
  space              mark or unmark, then move down
  a                  mark every photo and video listed; again to unmark them
  enter on a file    compress the marked files, or this one when none are
  /  .               filter: type words; enter or down keeps it, esc clears it
  H                  show or hide dot files
  ?                  this help; j k space pgup pgdn g G scroll it
  q  esc             quit without compressing (esc clears a kept filter first)
  ctrl-c             quit without compressing, with exit status 130

Marks stay when you change directories; the header counts them. The filter
matches names by substring, every word has to appear, and it is cleared on a
directory change. Dim rows are not photos or videos and cannot be marked; a
dim name ending in .compressed.EXT is an earlier result and still can be.

Commands follow the physical key, not the character it types, so they keep
working with a Cyrillic layout on: о is j, л is k, р is h, Р is H, д is l,
ф is a, п is g, й is q. "." opens the filter just like "/": on ЙЦУКЕН the "/"
key types ".", and ю, on the US "." key, does the same. Terminals that speak
the kitty keyboard protocol report the real base-layout key, so every other
layout works there as well.

env
  MCZ_KITTY_KEYS=off   do not ask the terminal for kitty keyboard reporting
`;

const HELP_LINES = KEYS.trimEnd().split("\n");

type Entry = {
	name: string;
	path: string;
	kind: "parent" | "dir" | "file";
	media: "img" | "vid" | null;
	size: number | null;
};

const byName = (a: Entry, b: Entry) =>
	a.name.localeCompare(b.name, undefined, {
		numeric: true,
		sensitivity: "base",
	});

/** One directory as rows: `..`, directories, then files, each sorted the way
 *  people number things (beach2 before beach10). Links are followed, so a link
 *  to a folder is a folder; a broken link is a file nothing can be done with.
 *  Throws when the directory cannot be read. */
export function listDirectory(dir: string): Entry[] {
	const dirs: Entry[] = [];
	const files: Entry[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(path);
		} catch {
			files.push({ name, path, kind: "file", media: null, size: null });
			continue;
		}
		if (stat.isDirectory()) {
			dirs.push({ name, path, kind: "dir", media: null, size: null });
			continue;
		}
		const kind = stat.isFile() ? kindByExt(name) : null;
		files.push({
			name,
			path,
			kind: "file",
			media: kind === "image" ? "img" : kind === "video" ? "vid" : null,
			size: stat.size,
		});
	}
	dirs.sort(byName);
	files.sort(byName);
	const parent: Entry[] =
		dir === "/"
			? []
			: [
					{
						name: "..",
						path: dirname(dir),
						kind: "parent",
						media: null,
						size: null,
					},
				];
	return [...parent, ...dirs, ...files];
}

/** Every space-separated word appears in the name, case aside. macOS hands out
 *  names in decomposed form, so both sides are composed before comparing. */
export function matchesFilter(name: string, filter: string): boolean {
	const hay = name.normalize("NFC").toLowerCase();
	return filter
		.normalize("NFC")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => hay.includes(word));
}

/** A name ready for a row: composed, and with its control characters shown. */
const shownName = (name: string): string => printable(name.normalize("NFC"));

/** The command a key stands for: its US-layout key when it types something. */
const commandOf = (key: Key): string =>
	key.name === "char" ? (key.base ?? key.char ?? "") : key.name;

/** Opens the list in `dir` and resolves with the absolute paths to compress —
 *  nothing when the user quits, null when that was ctrl-c. */
export function pick(dir: string, profile: string): Promise<string[] | null> {
	return new Picker(dir, profile).run();
}

const PREFIX = 10; // " [x] img  " in front of every name
const SIZE = 8; // "999.9 MB"

class Picker {
	private readonly screen = new AltScreen();
	private entries: Entry[] = [];
	private view: Entry[] = [];
	private cursor = 0;
	private top = 0;
	private filter = "";
	private filtering = false;
	private showHidden = false;
	private helpOpen = false;
	private helpScroll = 0;
	private message = "";
	private readonly marks = new Set<string>();
	private finished = false;
	private up = false;
	private resolve: (paths: string[] | null) => void = () => {};
	private reject: (err: unknown) => void = () => {};

	constructor(
		private dir: string,
		private readonly profile: string,
	) {}

	async run(): Promise<string[] | null> {
		this.entries = listDirectory(this.dir);
		this.refilter();

		const onData = (data: Buffer) => {
			try {
				for (const key of decodeKeys(data)) {
					if (this.finished) break;
					this.onKey(key);
				}
			} catch (err) {
				this.finished = true;
				this.reject(err);
			}
		};
		const onResize = () => this.render();
		const onExit = () => this.restore();

		hideCursor();
		this.screen.enter();
		enableKittyKeys();
		process.stdin.setRawMode(true);
		process.stdin.resume();
		this.up = true;
		process.stdin.on("data", onData);
		process.stdout.on("resize", onResize);
		// process.exit from anywhere — a signal handler included — still gives
		// the terminal back
		process.on("exit", onExit);

		try {
			const done = new Promise<string[] | null>((resolve, reject) => {
				this.resolve = resolve;
				this.reject = reject;
			});
			this.render();
			return await done;
		} finally {
			process.stdin.off("data", onData);
			process.stdout.off("resize", onResize);
			process.off("exit", onExit);
			this.restore();
			process.stdin.pause();
		}
	}

	private restore(): void {
		if (!this.up) return;
		this.up = false;
		disableKittyKeys();
		this.screen.exit();
		showCursor();
		process.stdin.setRawMode(false);
	}

	private finish(paths: string[] | null): void {
		this.finished = true;
		this.resolve(paths);
	}

	// ------------------------------------------------------------------ state

	private get listHeight(): number {
		return Math.max(1, this.screen.rows - 2);
	}

	private get helpPage(): number {
		return Math.max(1, this.screen.rows - 1);
	}

	private get current(): Entry | undefined {
		return this.view[this.cursor];
	}

	/** Recomputes the visible rows. The cursor stays on `keep` when it is still
	 *  listed, and otherwise goes to the first entry past `..`. */
	private refilter(keep?: string): void {
		this.view = this.entries.filter(
			(e) =>
				e.kind === "parent" ||
				((this.showHidden || !e.name.startsWith(".")) &&
					matchesFilter(e.name, this.filter)),
		);
		const kept =
			keep === undefined ? -1 : this.view.findIndex((e) => e.path === keep);
		if (kept !== -1) this.cursor = kept;
		else
			this.cursor =
				this.view[0]?.kind === "parent" && this.view.length > 1 ? 1 : 0;
	}

	private move(delta: number): void {
		this.cursor = Math.max(
			0,
			Math.min(this.view.length - 1, this.cursor + delta),
		);
	}

	private open(path: string, landOn?: string): void {
		let entries: Entry[];
		try {
			entries = listDirectory(path);
		} catch (err) {
			const code =
				(err as NodeJS.ErrnoException).code ?? (err as Error).message;
			this.message = `${C.red}cannot open ${shownName(basename(path) || path)}: ${code}${C.reset}`;
			return;
		}
		this.dir = path;
		this.entries = entries;
		this.filter = "";
		this.top = 0;
		this.refilter(landOn);
	}

	private parent(): void {
		if (this.dir === "/") return;
		this.open(dirname(this.dir), this.dir);
	}

	private toggleMark(): void {
		const entry = this.current;
		if (entry?.kind === "file" && entry.media) {
			if (this.marks.has(entry.path)) this.marks.delete(entry.path);
			else this.marks.add(entry.path);
		}
		this.move(1);
	}

	private markAll(): void {
		const media = this.view.filter((e) => e.kind === "file" && e.media);
		if (media.length === 0) {
			this.message = `${C.yellow}no photos or videos here${C.reset}`;
			return;
		}
		const unmark = media.every((e) => this.marks.has(e.path));
		for (const e of media) {
			if (unmark) this.marks.delete(e.path);
			else this.marks.add(e.path);
		}
	}

	private activate(): void {
		const entry = this.current;
		if (!entry) return;
		if (entry.kind === "parent") return this.parent();
		if (entry.kind === "dir") return this.open(entry.path);
		if (this.marks.size > 0) return this.finish([...this.marks]);
		if (entry.media) return this.finish([entry.path]);
		this.message = `${C.yellow}${shownName(entry.name)} is not a photo or video${C.reset}`;
	}

	// ------------------------------------------------------------------- keys

	private onKey(key: Key): void {
		if (key.name === "ctrl-c") return this.finish(null);
		if (this.helpOpen) {
			this.helpKey(key);
			return this.render();
		}
		this.message = "";
		if (this.filtering) {
			this.filterKey(key);
			return this.render();
		}

		switch (commandOf(key)) {
			case "up":
			case "k":
				this.move(-1);
				break;
			case "down":
			case "j":
				this.move(1);
				break;
			case "pageup":
				this.move(-this.listHeight);
				break;
			case "pagedown":
				this.move(this.listHeight);
				break;
			case "home":
			case "g":
				this.cursor = 0;
				break;
			case "end":
			case "G":
				this.cursor = Math.max(0, this.view.length - 1);
				break;
			case "right":
			case "l": {
				const entry = this.current;
				if (entry?.kind === "parent") this.parent();
				else if (entry?.kind === "dir") this.open(entry.path);
				break;
			}
			case "enter":
				this.activate();
				break;
			case "left":
			case "h":
			case "backspace":
				this.parent();
				break;
			case " ":
				this.toggleMark();
				break;
			case "a":
				this.markAll();
				break;
			// "." is where ЙЦУКЕН puts the "/" key, so it filters too
			case "/":
			case ".":
				this.filtering = true;
				break;
			case "H":
				this.showHidden = !this.showHidden;
				this.refilter(this.current?.path);
				break;
			case "?":
				this.helpOpen = true;
				this.helpScroll = 0;
				break;
			case "escape":
				// a kept filter goes first, so esc does not throw the marks away with it
				if (this.filter) {
					this.filter = "";
					this.refilter(this.current?.path);
					break;
				}
				return this.finish([]);
			case "q":
				return this.finish([]);
		}
		this.render();
	}

	private filterKey(key: Key): void {
		switch (key.name) {
			case "escape":
				this.filter = "";
				this.filtering = false;
				this.refilter(this.current?.path);
				break;
			case "enter":
			case "down":
				this.filtering = false;
				break;
			case "backspace":
				this.filter = [...this.filter].slice(0, -1).join("");
				this.refilter();
				break;
			case "ctrl-u":
				this.filter = "";
				this.refilter();
				break;
			case "char":
				this.filter += key.char ?? "";
				this.refilter();
				break;
		}
	}

	private helpKey(key: Key): void {
		const page = this.helpPage;
		const last = Math.max(0, HELP_LINES.length - page);
		switch (commandOf(key)) {
			case "up":
			case "k":
				this.helpScroll -= 1;
				break;
			case "down":
			case "j":
				this.helpScroll += 1;
				break;
			case " ":
			case "pagedown":
				this.helpScroll += page;
				break;
			case "pageup":
				this.helpScroll -= page;
				break;
			case "home":
			case "g":
				this.helpScroll = 0;
				break;
			case "end":
			case "G":
				this.helpScroll = last;
				break;
			default:
				this.helpOpen = false;
		}
		this.helpScroll = Math.max(0, Math.min(last, this.helpScroll));
	}

	// ----------------------------------------------------------------- render

	private render(): void {
		if (!this.up || this.finished) return;
		const cols = this.screen.cols;
		const height = this.listHeight;

		if (this.helpOpen) {
			const page = this.helpPage;
			const rows = HELP_LINES.slice(this.helpScroll, this.helpScroll + page);
			while (rows.length < page) rows.push("");
			let footer = `${C.gray}any key returns${C.reset}`;
			if (HELP_LINES.length > page) {
				const end = Math.min(HELP_LINES.length, this.helpScroll + page);
				footer = `${C.gray}j k space scroll, any other key returns   ${this.helpScroll + 1}-${end} of ${HELP_LINES.length}${C.reset}`;
			}
			rows.push(footer);
			this.screen.draw(rows);
			return;
		}

		if (this.cursor < this.top) this.top = this.cursor;
		if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
		this.top = Math.max(0, Math.min(this.top, this.view.length - height));

		const rows = [this.header(cols)];
		const slice = this.view.slice(this.top, this.top + height);
		for (const [i, entry] of slice.entries())
			rows.push(this.row(entry, this.top + i === this.cursor, cols));
		if (this.view.every((e) => e.kind === "parent")) {
			rows.push(
				`${C.gray}${" ".repeat(PREFIX)}${this.filter ? "nothing matches" : "empty"}${C.reset}`,
			);
		}
		while (rows.length < height + 1) rows.push("");
		rows.length = height + 1;
		rows.push(this.footer());
		this.screen.draw(rows);
	}

	private header(cols: number): string {
		const count = this.marks.size;
		let tail = `  ${C.gray}profile:${C.reset} ${printable(this.profile)}  ${count ? C.yellow : C.gray}${count} marked${C.reset}`;
		if (this.filter && !this.filtering)
			tail += `  ${C.gray}filter:${C.reset} ${printable(this.filter)}`;
		const lead = `${C.bold}mcz${C.reset}  `;
		const room = Math.max(8, cols - displayWidth(lead) - displayWidth(tail));
		return `${lead}${C.cyan}${truncateStart(shownName(tildify(this.dir)), room)}${C.reset}${tail}`;
	}

	private row(entry: Entry, selected: boolean, cols: number): string {
		const nameWidth = Math.max(4, cols - PREFIX - SIZE - 3);
		let line: string;
		if (entry.kind !== "file") {
			const label =
				entry.kind === "parent" ? ".." : `${shownName(entry.name)}/`;
			line = `${" ".repeat(PREFIX)}${C.blue}${fitTo(label, nameWidth)}${C.reset}`;
		} else {
			const name = fitTo(shownName(entry.name), nameWidth);
			const size = (entry.size === null ? "" : humanSize(entry.size)).padStart(
				SIZE,
			);
			if (entry.media) {
				const box = this.marks.has(entry.path)
					? `${C.green}[x]${C.reset}`
					: "[ ]";
				const dim = isCompressedName(entry.name) ? C.dim : "";
				line = ` ${box} ${C.gray}${entry.media}${C.reset}  ${dim}${name}  ${size}${C.reset}`;
			} else {
				line = `${C.dim}${" ".repeat(PREFIX)}${name}  ${size}${C.reset}`;
			}
		}
		if (!selected) return line;
		// every reset inside the row would end the highlight, so it is renewed after each
		return `${C.invert}${padTo(line, cols).replaceAll(C.reset, `${C.reset}${C.invert}`)}${C.reset}`;
	}

	private footer(): string {
		if (this.filtering) {
			return `${C.yellow}/${C.reset}${printable(this.filter)}${C.invert} ${C.reset}   ${C.gray}enter keep  esc clear${C.reset}`;
		}
		if (this.message) return this.message;
		return `${C.gray}space mark  a all  enter compress  / filter  H dot files  ? keys  q quit${C.reset}`;
	}
}
