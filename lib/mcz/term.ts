// Terminal primitives: colors, width-aware string ops, key decoding and the
// alternate-screen surface the picker draws on. A trimmed copy of
// lib/glab-mrs/term.ts — packages here do not import each other.

import { homedir } from "node:os";

const ESC = "\x1b";
export const CSI = `${ESC}[`;

export const C = {
	reset: `${CSI}0m`,
	bold: `${CSI}1m`,
	dim: `${CSI}2m`,
	invert: `${CSI}7m`,
	red: `${CSI}31m`,
	green: `${CSI}32m`,
	yellow: `${CSI}33m`,
	blue: `${CSI}34m`,
	cyan: `${CSI}36m`,
	gray: `${CSI}90m`,
};

/** Colors only for a terminal, and never when NO_COLOR is set. */
export const colorful = (stream: NodeJS.WriteStream): boolean =>
	Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;

export const paint = (on: boolean, color: string, s: string): string =>
	on ? `${color}${s}${C.reset}` : s;

const ANSI_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the point
	/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1b[()][0-9A-B]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

// C0, DEL and C1 controls, plus the bidi overrides that reorder what follows them
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u202A-\u202E\u2066-\u2069]/g;

/**
 * A file name as it can safely reach the terminal. Names are whatever the file
 * system allows, and that includes newlines, which break a row, and escape
 * sequences, which the terminal would run rather than show. Each control
 * character becomes a visible stand-in: ␊ for a newline, ␛ for ESC, ␡ for DEL,
 * � for the rest. Apply it to names and paths only — never to text that
 * carries this program's own colors.
 */
export function printable(s: string): string {
	return s.replace(CONTROL_RE, (ch) => {
		const code = ch.charCodeAt(0);
		if (code < 0x20) return String.fromCharCode(0x2400 + code);
		if (code === 0x7f) return "␡";
		return "�";
	});
}

/** Plain words stay bare; anything a shell would read differently is quoted.
 *  A name with control characters gets $'…' with escapes, which bash and zsh
 *  read back as the same bytes and which is safe to print. */
export function shellQuote(s: string): string {
	if (/^[\w@%+=:,./-]+$/.test(s)) return s;
	CONTROL_RE.lastIndex = 0;
	if (!CONTROL_RE.test(s)) return `'${s.replaceAll("'", `'\\''`)}'`;
	let out = "$'";
	for (const ch of s) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\\" || ch === "'") out += `\\${ch}`;
		else if (code < 0x20 || code === 0x7f)
			out += `\\x${code.toString(16).padStart(2, "0")}`;
		else if (
			(code >= 0x80 && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		)
			out += `\\u${code.toString(16).padStart(4, "0")}`;
		else out += ch;
	}
	return `${out}'`;
}

const WIDE_RANGES: [number, number][] = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f680, 0x1f6ff],
	[0x1f900, 0x1f9ff],
	[0x20000, 0x3fffd],
];

const ZERO_RANGES: [number, number][] = [
	[0x0300, 0x036f],
	[0x0483, 0x0489],
	[0x200b, 0x200f],
	[0xfe00, 0xfe0f],
	[0xfe20, 0xfe2f],
];

const inRanges = (cp: number, ranges: [number, number][]) =>
	ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

export function charWidth(cp: number): number {
	if (cp === 0x200d) return 0; // zero-width joiner
	if (inRanges(cp, ZERO_RANGES)) return 0;
	if (inRanges(cp, WIDE_RANGES)) return 2;
	return 1;
}

export function displayWidth(s: string): number {
	let w = 0;
	for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

/** Cuts a string to `max` columns, keeping escape sequences intact. */
export function truncateToWidth(
	s: string,
	max: number,
	ellipsis = "…",
): string {
	if (displayWidth(s) <= max) return s;
	const limit = Math.max(0, max - displayWidth(ellipsis));

	let out = "";
	let width = 0;
	let i = 0;
	while (i < s.length) {
		ANSI_RE.lastIndex = i;
		const m = ANSI_RE.exec(s);
		if (m && m.index === i) {
			out += m[0];
			i += m[0].length;
			continue;
		}
		const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (width + cw > limit) break;
		out += ch;
		width += cw;
		i += ch.length;
	}
	return `${out}${C.reset}${ellipsis}`;
}

/** Cuts plain text from the front, so the end of a long path stays readable. */
export function truncateStart(s: string, max: number, ellipsis = "…"): string {
	if (displayWidth(s) <= max) return s;
	const limit = Math.max(0, max - displayWidth(ellipsis));
	const chars = [...s];
	let width = 0;
	let start = chars.length;
	while (start > 0) {
		const cw = charWidth(chars[start - 1]?.codePointAt(0) ?? 0);
		if (width + cw > limit) break;
		width += cw;
		start -= 1;
	}
	return `${ellipsis}${chars.slice(start).join("")}`;
}

export const padTo = (s: string, width: number): string =>
	s + " ".repeat(Math.max(0, width - displayWidth(s)));

export const fitTo = (s: string, width: number): string =>
	padTo(truncateToWidth(s, width), width);

// ----------------------------------------------------------------- formatting

/** 4.2 MB — decimal units, the way Finder counts. */
export function humanSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	// 999.96 KB would print as "1000.0 KB", so the step up happens just below 1000
	while (unit < units.length - 1 && value >= (unit === 0 ? 1000 : 999.95)) {
		value /= 1000;
		unit += 1;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function tildify(path: string, home = homedir()): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// ------------------------------------------------------------------- keyboard

export type Key = {
	name: string; // up|down|left|right|enter|escape|backspace|pageup|pagedown|home|end|char|ctrl-<c>
	char?: string; // what the key typed, in the layout the user is actually using
	base?: string; // the same physical key on a US layout — commands match on this
};

/**
 * Physical key positions for the layouts that share the ЙЦУКЕН/QWERTY frame.
 * Terminals deliver characters, not scan codes, so a Cyrillic "о" is the only
 * evidence we get that the j key was pressed. The kitty keyboard protocol below
 * reports the real base-layout key when the terminal speaks it; this table is
 * the fallback that works everywhere else.
 */
const US_POSITION: Record<string, string> = {
	// ЙЦУКЕН, top row
	й: "q",
	ц: "w",
	у: "e",
	к: "r",
	е: "t",
	н: "y",
	г: "u",
	ш: "i",
	щ: "o",
	з: "p",
	х: "[",
	ъ: "]",
	// home row
	ф: "a",
	ы: "s",
	в: "d",
	а: "f",
	п: "g",
	р: "h",
	о: "j",
	л: "k",
	д: "l",
	ж: ";",
	э: "'",
	// bottom row
	я: "z",
	ч: "x",
	с: "c",
	м: "v",
	и: "b",
	т: "n",
	ь: "m",
	б: ",",
	ю: ".",
	ё: "`",
	// Ukrainian and Belarusian variants of the same positions
	і: "s",
	ї: "]",
	є: "'",
	ґ: "\\",
	ў: "e",
};

/** What each US key types with shift held. Letters just go upper-case. */
const US_SHIFT: Record<string, string> = {
	"`": "~",
	"1": "!",
	"2": "@",
	"3": "#",
	"4": "$",
	"5": "%",
	"6": "^",
	"7": "&",
	"8": "*",
	"9": "(",
	"0": ")",
	"-": "_",
	"=": "+",
	"[": "{",
	"]": "}",
	"\\": "|",
	";": ":",
	"'": '"',
	",": "<",
	".": ">",
	"/": "?",
};

/** The US key with shift: "/" is "?", "h" is "H". Already shifted keys stay. */
export const shiftedUs = (key: string): string =>
	Object.hasOwn(US_SHIFT, key) ? (US_SHIFT[key] as string) : key.toUpperCase();

/** The US-layout key behind a typed character, if we can tell. */
export function usLayoutKey(ch: string): string | undefined {
	const lower = ch.toLowerCase();
	if (!Object.hasOwn(US_POSITION, lower)) return undefined;
	const mapped = US_POSITION[lower] as string;
	// an upper-case letter was typed with shift, so it is the shifted US key:
	// Р is H, Ю is ">" — and G and g stay different commands
	return ch === lower ? mapped : shiftedUs(mapped);
}

// The kitty keyboard protocol reports the base-layout key alongside the typed
// one, which is exactly what layout-independent shortcuts need. Terminals that
// do not support it ignore the request and keep sending legacy keys.
const KITTY_FLAGS = 0b1101; // disambiguate + report alternate keys + all keys as escapes

export const enableKittyKeys = (): void => {
	if (process.env.MCZ_KITTY_KEYS === "off") return;
	process.stdout.write(`${CSI}>${KITTY_FLAGS}u`);
};

export const disableKittyKeys = (): void => {
	if (process.env.MCZ_KITTY_KEYS === "off") return;
	process.stdout.write(`${CSI}<u`);
};

// CSI unicode-key-code[:shifted[:base-layout]][;modifiers[:event-type]] u
const KITTY_RE =
	/^\[(\d+)(?::(\d*))?(?::(\d*))?(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u/;

const KITTY_NAMED: Record<number, string> = {
	9: "tab",
	13: "enter",
	27: "escape",
	127: "backspace",
	// the keypad, which "all keys as escapes" moves into the private use area
	57414: "enter",
	57417: "left",
	57418: "right",
	57419: "up",
	57420: "down",
	57421: "pageup",
	57422: "pagedown",
	57423: "home",
	57424: "end",
	57426: "delete",
};

const KITTY_KEYPAD_CHARS: Record<number, string> = {
	57399: "0",
	57400: "1",
	57401: "2",
	57402: "3",
	57403: "4",
	57404: "5",
	57405: "6",
	57406: "7",
	57407: "8",
	57408: "9",
	57409: ".",
	57410: "/",
	57411: "*",
	57412: "-",
	57413: "+",
	57415: "=",
};

// Functional keys without a character — lone shift, ctrl, caps lock, media
// keys — arrive as codepoints in this range and must not be typed as text.
const PRIVATE_USE = { first: 57344, last: 63743 };

const fromCodePoint = (cp: number): string =>
	cp > 0 ? String.fromCodePoint(cp) : "";

/** One kitty key event; null when it should be ignored (key release, a lone
 *  modifier, etc.). */
function kittyKey(m: RegExpExecArray): Key | null {
	const primary = Number(m[1]);
	const shifted = m[2] ? Number(m[2]) : 0;
	const base = m[3] ? Number(m[3]) : 0;
	const mods = m[4] ? Number(m[4]) - 1 : 0;
	const event = m[5] ? Number(m[5]) : 1;

	if (event === 3) return null; // key release
	const shift = (mods & 1) !== 0;
	const ctrl = (mods & 4) !== 0;

	if (Object.hasOwn(KITTY_NAMED, primary))
		return { name: KITTY_NAMED[primary] as string };
	if (Object.hasOwn(KITTY_KEYPAD_CHARS, primary)) {
		const ch = KITTY_KEYPAD_CHARS[primary] as string;
		return { name: "char", char: ch, base: ch };
	}
	if (primary >= PRIVATE_USE.first && primary <= PRIVATE_USE.last) return null;

	// the shifted codepoint comes with the "alternate keys" flag; fall back to
	// upper-casing when a terminal reports shift without it
	const typedRaw =
		shift && shifted ? fromCodePoint(shifted) : fromCodePoint(primary);
	const typed = shift && !shifted ? typedRaw.toUpperCase() : typedRaw;
	const baseChar = base ? fromCodePoint(base) : usLayoutKey(typed);
	const identity = baseChar ?? typed;

	if (ctrl) return { name: `ctrl-${identity.toLowerCase()}` };
	if (primary < 32) return null;

	return {
		name: "char",
		char: typed,
		// the base-layout field names the unshifted key, so shift+"/" is "?" —
		// the typed character cannot say that on a layout where that key is "."
		base: shift && baseChar ? shiftedUs(baseChar) : baseChar,
	};
}

export function decodeKeys(data: Buffer): Key[] {
	const s = data.toString("utf8");
	const keys: Key[] = [];
	let i = 0;

	const seq: Record<string, string> = {
		"[A": "up",
		"[B": "down",
		"[C": "right",
		"[D": "left",
		"[H": "home",
		"[F": "end",
		OA: "up",
		OB: "down",
		OC: "right",
		OD: "left",
		"[5~": "pageup",
		"[6~": "pagedown",
		"[1~": "home",
		"[4~": "end",
		"[7~": "home",
		"[8~": "end",
		"[3~": "delete",
	};

	while (i < s.length) {
		const ch = s[i];

		if (ch === "\x1b") {
			const rest = s.slice(i + 1);
			const hit = Object.keys(seq).find((k) => rest.startsWith(k));
			if (hit) {
				keys.push({ name: seq[hit] as string });
				i += 1 + hit.length;
				continue;
			}
			const kitty = KITTY_RE.exec(rest);
			if (kitty) {
				const key = kittyKey(kitty);
				if (key) keys.push(key);
				i += 1 + kitty[0].length;
				continue;
			}
			// unknown CSI sequence — swallow it whole instead of echoing garbage
			const m = /^\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
			if (m) {
				i += 1 + m[0].length;
				continue;
			}
			keys.push({ name: "escape" });
			i += 1;
			continue;
		}

		if (ch === "\r" || ch === "\n") {
			keys.push({ name: "enter" });
			i += 1;
			continue;
		}
		if (ch === "\x7f" || ch === "\b") {
			keys.push({ name: "backspace" });
			i += 1;
			continue;
		}
		const code = s.charCodeAt(i);
		if (code < 0x20) {
			keys.push({ name: `ctrl-${String.fromCharCode(code + 96)}` });
			i += 1;
			continue;
		}

		const cp = String.fromCodePoint(s.codePointAt(i) ?? 0);
		keys.push({ name: "char", char: cp, base: usLayoutKey(cp) });
		i += cp.length;
	}

	return keys;
}

// ------------------------------------------------------------------- surface

/** Full-screen surface on the alternate buffer — the terminal history is kept
 *  intact and comes back untouched on exit. */
export class AltScreen {
	private active = false;

	constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

	get cols(): number {
		return this.out.columns || 80;
	}

	get rows(): number {
		return this.out.rows || 24;
	}

	enter() {
		if (this.active) return;
		this.active = true;
		this.out.write(`${CSI}?1049h${CSI}H${CSI}2J`);
	}

	exit() {
		if (!this.active) return;
		this.active = false;
		this.out.write(`${CSI}?1049l`);
	}

	draw(rows: string[]) {
		if (!this.active) return;
		let buf = `${CSI}H${CSI}2J`;
		for (const [i, row] of rows.entries()) {
			// no newline after the last row — it would scroll the screen by one
			const last = i === rows.length - 1;
			buf += `${truncateToWidth(row, this.cols)}${C.reset}${last ? "" : "\n"}`;
		}
		this.out.write(buf);
	}
}

export const hideCursor = () => process.stdout.write(`${CSI}?25l`);
export const showCursor = () => process.stdout.write(`${CSI}?25h`);
