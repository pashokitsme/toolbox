// Terminal primitives: colors, width-aware string ops, key decoding and an
// inline (non-fullscreen) redraw region.

const ESC = "\x1b";
export const CSI = `${ESC}[`;

export const C = {
	reset: `${CSI}0m`,
	bold: `${CSI}1m`,
	dim: `${CSI}2m`,
	italic: `${CSI}3m`,
	underline: `${CSI}4m`,
	invert: `${CSI}7m`,
	strike: `${CSI}9m`,
	red: `${CSI}31m`,
	green: `${CSI}32m`,
	yellow: `${CSI}33m`,
	blue: `${CSI}34m`,
	magenta: `${CSI}35m`,
	cyan: `${CSI}36m`,
	gray: `${CSI}90m`,
	brightRed: `${CSI}91m`,
	brightGreen: `${CSI}92m`,
	brightYellow: `${CSI}93m`,
	brightBlue: `${CSI}94m`,
	brightCyan: `${CSI}96m`,
	white: `${CSI}97m`,
};

const ANSI_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the point
	/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1b[()][0-9A-B]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

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

const inRanges = (cp: number, ranges: [number, number][]) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

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
export function truncateToWidth(s: string, max: number, ellipsis = "…"): string {
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

export const padTo = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - displayWidth(s)));

export const fitTo = (s: string, width: number): string => padTo(truncateToWidth(s, width), width);

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

/** The US-layout key behind a typed character, if we can tell. */
export function usLayoutKey(ch: string): string | undefined {
	const lower = ch.toLowerCase();
	const mapped = US_POSITION[lower];
	if (!mapped) return undefined;
	// keep the case the user typed, so C and c stay different commands
	return ch === lower ? mapped : mapped.toUpperCase();
}

// The kitty keyboard protocol reports the base-layout key alongside the typed
// one, which is exactly what layout-independent shortcuts need. Terminals that
// do not support it ignore the request and keep sending legacy keys.
const KITTY_FLAGS = 0b1101; // disambiguate + report alternate keys + all keys as escapes

export const enableKittyKeys = (): void => {
	if (process.env.GLAB_MRS_KITTY_KEYS === "off") return;
	process.stdout.write(`${CSI}>${KITTY_FLAGS}u`);
};

export const disableKittyKeys = (): void => {
	if (process.env.GLAB_MRS_KITTY_KEYS === "off") return;
	process.stdout.write(`${CSI}<u`);
};

// CSI unicode-key-code[:shifted[:base-layout]][;modifiers[:event-type]] u
const KITTY_RE = /^\[(\d+)(?::(\d*))?(?::(\d*))?(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u/;

const KITTY_NAMED: Record<number, string> = {
	9: "tab",
	13: "enter",
	27: "escape",
	127: "backspace",
	57414: "enter", // keypad enter
};

const fromCodePoint = (cp: number): string => (cp > 0 ? String.fromCodePoint(cp) : "");

/** One kitty key event; null when it should be ignored (key release, etc.). */
function kittyKey(m: RegExpExecArray): Key | null {
	const primary = Number(m[1]);
	const shifted = m[2] ? Number(m[2]) : 0;
	const base = m[3] ? Number(m[3]) : 0;
	const mods = m[4] ? Number(m[4]) - 1 : 0;
	const event = m[5] ? Number(m[5]) : 1;

	if (event === 3) return null; // key release
	const shift = (mods & 1) !== 0;
	const ctrl = (mods & 4) !== 0;

	const named = KITTY_NAMED[primary];
	if (named) return { name: named };

	// the shifted codepoint comes with the "alternate keys" flag; fall back to
	// upper-casing when a terminal reports shift without it
	const typedRaw = shift && shifted ? fromCodePoint(shifted) : fromCodePoint(primary);
	const typed = shift && !shifted ? typedRaw.toUpperCase() : typedRaw;
	const baseChar = base ? fromCodePoint(base) : usLayoutKey(typed);
	const identity = baseChar ?? typed;

	if (ctrl) return { name: `ctrl-${identity.toLowerCase()}` };
	if (primary < 32) return null;

	return {
		name: "char",
		char: typed,
		base: shift && baseChar ? baseChar.toUpperCase() : baseChar,
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

// --------------------------------------------------------------- draw region

/** A row is either a plain (already colored) line or a raw escape blob that
 *  occupies `rows` terminal lines — that is how inline images get placed. */
export type Row = string | { raw: string; rows: number };

/** Full-screen surface on the alternate buffer — the terminal history is kept
 *  intact and comes back untouched on exit. */
export class AltScreen {
	private active = false;
	private prelude: (() => string) | null = null;

	constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

	get cols(): number {
		return this.out.columns || 80;
	}

	get rows(): number {
		return this.out.rows || 24;
	}

	setPrelude(fn: () => string) {
		this.prelude = fn;
	}

	enter() {
		if (this.active) return;
		this.active = true;
		this.out.write(`${CSI}?1049h${CSI}H${CSI}2J`);
	}

	exit() {
		if (!this.active) return;
		this.active = false;
		this.out.write(`${this.prelude?.() ?? ""}${CSI}?1049l`);
	}

	draw(rows: Row[]) {
		if (!this.active) return;
		let buf = `${this.prelude?.() ?? ""}${CSI}H${CSI}2J`;
		for (const [i, row] of rows.entries()) {
			// no newline after the last row — it would scroll the screen by one
			const last = i === rows.length - 1;
			if (typeof row === "string") {
				buf += `${truncateToWidth(row, this.cols)}${C.reset}${last ? "" : "\n"}`;
			} else {
				buf += `${CSI}s${row.raw}${CSI}u${"\n".repeat(last ? row.rows - 1 : row.rows)}`;
			}
		}
		this.out.write(buf);
	}
}

/** Hard-wraps a line to `width`, keeping colors alive across the break. */
export function wrapAnsi(line: string, width: number): string[] {
	const src = line.replace(/\t/g, "    ").split("\r").pop() ?? ""; // progress bars rewrite the line
	if (displayWidth(src) <= width) return [src];

	const out: string[] = [];
	let active = "";
	let current = "";
	let used = 0;
	let i = 0;

	while (i < src.length) {
		ANSI_RE.lastIndex = i;
		const m = ANSI_RE.exec(src);
		if (m && m.index === i) {
			current += m[0];
			if (/^\x1b\[0?m$/.test(m[0])) active = "";
			else if (/^\x1b\[[0-9;]*m$/.test(m[0])) active += m[0];
			i += m[0].length;
			continue;
		}

		const ch = String.fromCodePoint(src.codePointAt(i) ?? 0);
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (used + cw > width) {
			out.push(`${current}${C.reset}`);
			current = active;
			used = 0;
		}
		current += ch;
		used += cw;
		i += ch.length;
	}

	if (current.trim() !== "" || out.length === 0) out.push(current);
	return out;
}

export const hideCursor = () => process.stdout.write(`${CSI}?25l`);
export const showCursor = () => process.stdout.write(`${CSI}?25h`);
