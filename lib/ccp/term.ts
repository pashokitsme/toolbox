// Colors and the stdout/stderr split.
//
// `ccp use` and `ccp default` are meant to be run through the shell function,
// which evals ccp's stdout. So stdout carries shell code and nothing else —
// every line a human reads goes to stderr, including errors and success notes.

const CSI = "\x1b[";
const plain = process.env.NO_COLOR !== undefined || !process.stderr.isTTY;

const wrap = (code: string) => (s: string) => (plain ? s : `${CSI}${code}m${s}${CSI}0m`);

export const C = {
	bold: wrap("1"),
	dim: wrap("2"),
	red: wrap("31"),
	green: wrap("32"),
	yellow: wrap("33"),
	cyan: wrap("36"),
	gray: wrap("90"),
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
