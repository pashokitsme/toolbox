// Colors and the stdout/stderr split.
//
// `ccp use` is meant to be run through the shell function,
// which evals ccp's stdout. So stdout carries shell code and nothing else —
// every line a human reads goes to stderr, including errors and success notes.

const CSI = "\x1b[";
const plain = process.env.NO_COLOR !== undefined || !process.stderr.isTTY;

// Colors are the wombat theme's (config/ghostty) hex, which Bun.color turns into
// whatever the terminal takes — truecolor or 256. Its squeeze into 16 colors is
// poor (the yellow lands on red, the gray on black), so a 16-color terminal gets
// the palette slot the hex came from.
const DEPTH = Bun.color("#000", "ansi") ?? "";
const color = (hex: string, sgr: number): string =>
	DEPTH.includes("38;") ? (Bun.color(hex, "ansi") ?? "") : `${CSI}${sgr}m`;

const wrap = (open: string) => (s: string) => (plain ? s : `${open}${s}${CSI}0m`);

export const C = {
	bold: wrap(`${CSI}1m`),
	dim: wrap(`${CSI}2m`),
	red: wrap(color("#ff615a", 31)),
	green: wrap(color("#b1e969", 32)),
	yellow: wrap(color("#ebd99c", 33)),
	cyan: wrap(color("#82fff7", 36)),
	gray: wrap(color("#313131", 90)),
};

/** Human-facing output. Never stdout — the shell function evals that. */
export function say(line = ""): void {
	process.stderr.write(`${line}\n`);
}

/** Shell code for the wrapper function to eval. */
export function emit(line: string): void {
	process.stdout.write(`${line}\n`);
}

export function fail(message: string, hint?: string): never {
	say(`${C.red("ccp:")} ${message}`);
	if (hint) say(`      ${C.dim(hint)}`);
	process.exit(1);
}

/** Single-quote a string for POSIX shells. */
export function shq(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
