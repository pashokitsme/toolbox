// Terminal bits for the mode picker: colors, safe text, key decoding. A
// trimmed copy of lib/mcz/term.ts — packages here do not import each other.
// The kitty keyboard protocol is left out: the picker has a handful of keys and
// the ЙЦУКЕН table covers the layout that matters.

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
	cyan: `${CSI}36m`,
	gray: `${CSI}90m`,
};

/** Colors only for a terminal, and never when NO_COLOR is set. */
export const colorful = (stream: NodeJS.WriteStream): boolean =>
	Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;

export const paint = (on: boolean, color: string, s: string): string =>
	on ? `${color}${s}${C.reset}` : s;

// C0, DEL and C1 controls, plus the bidi overrides that reorder what follows them
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

/** Text from outside (a link, the clipboard) as it can safely reach the
 *  terminal: each control character becomes a visible stand-in. */
export function printable(s: string): string {
	return s.replace(CONTROL_RE, (ch) => {
		const code = ch.charCodeAt(0);
		if (code < 0x20) return String.fromCharCode(0x2400 + code);
		if (code === 0x7f) return "␡";
		return "�";
	});
}

/** Cuts plain text to `max` characters. Links and paths are narrow text, so
 *  one character is one column here. */
export function cut(s: string, max: number): string {
	const chars = [...s];
	if (chars.length <= max) return s;
	return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// ------------------------------------------------------------------- keyboard

export type Key = {
	name: string; // up|down|enter|escape|backspace|char|ctrl-<c>
	char?: string;
	base?: string; // the same physical key on a US layout — commands match on this
};

// the keys the picker reads, where ЙЦУКЕН has them
const US_POSITION: Record<string, string> = {
	й: "q",
	у: "e",
	к: "r",
	з: "p",
	о: "j",
	л: "k",
};

export function decodeKeys(data: Buffer): Key[] {
	const s = data.toString("utf8");
	const keys: Key[] = [];
	const seq: Record<string, string> = {
		"[A": "up",
		"[B": "down",
		OA: "up",
		OB: "down",
	};
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === ESC) {
			const rest = s.slice(i + 1);
			const hit = Object.keys(seq).find((k) => rest.startsWith(k));
			if (hit) {
				keys.push({ name: seq[hit] as string });
				i += 1 + hit.length;
				continue;
			}
			// any other sequence is swallowed whole instead of read as keys
			const m = /^(?:\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(rest);
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
		const code = s.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) {
			keys.push({ name: code === 0x7f ? "backspace" : `ctrl-${String.fromCharCode(code + 96)}` });
			i += 1;
			continue;
		}
		const cp = String.fromCodePoint(s.codePointAt(i) ?? 0);
		keys.push({ name: "char", char: cp, base: US_POSITION[cp] ?? cp });
		i += cp.length;
	}
	return keys;
}
