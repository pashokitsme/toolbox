// The mode picker: a few lines under the prompt, drawn on stderr so stdout
// carries only the result and `gxurl | …` still works. Nothing is left on the
// screen once a mode is taken.

import { C, CSI, cut, decodeKeys, type Key, printable } from "./term.ts";

export type Choice = {
	key: string; // the hotkey, also its letter in the list
	label: string;
	/** what this mode makes of the first link, or why it cannot */
	preview: string;
	error?: boolean;
};

export const KEYS = `keys in the picker
  j k  up down   move                e  p   take that mode right away
  enter          take the marked mode
  q  esc         quit with nothing, exit status 130; ctrl-c too

The letters follow the physical key: with a Cyrillic layout on, у is e, з is p,
о is j, л is k, й is q.`;

/** Resolves with the index taken, or null when the user quit. */
export function choose(title: string, choices: Choice[]): Promise<number | null> {
	const out = process.stderr;
	const input = process.stdin;
	let cursor = Math.max(0, choices.findIndex((c) => !c.error));
	let message = "";
	let drawn = 0;

	const lines = (): string[] => {
		const cols = Math.max(20, out.columns || 80);
		const width = Math.max(...choices.map((c) => c.label.length));
		const rows = [`${C.bold}gxurl${C.reset}  ${C.gray}${cut(printable(title), cols - 8)}${C.reset}`];
		for (const [i, c] of choices.entries()) {
			const head = ` ${i === cursor ? ">" : " "} ${c.key}  ${c.label.padEnd(width)}  `;
			const room = Math.max(1, cols - head.length - 1);
			const body = cut(printable(c.preview), room);
			const line = `${head}${c.error ? C.red : C.cyan}${body}${C.reset}`;
			rows.push(i === cursor ? `${C.bold}${line.replaceAll(C.reset, `${C.reset}${C.bold}`)}${C.reset}` : line);
		}
		rows.push(
			message
				? `${C.yellow}${cut(printable(message), cols - 1)}${C.reset}`
				: `${C.gray}${cut("j k move  enter take  e p take that one  q quit", cols - 1)}${C.reset}`,
		);
		return rows;
	};

	// back to where the picker began, and everything below it erased
	const erase = (): string => (drawn > 1 ? `\r${CSI}${drawn - 1}A${CSI}J` : `\r${CSI}J`);
	const render = () => {
		const rows = lines();
		out.write(`${erase()}${rows.join("\n")}`);
		drawn = rows.length;
	};

	return new Promise((resolve) => {
		let up = true;
		const restore = () => {
			if (!up) return;
			up = false;
			out.write(`${erase()}${CSI}?25h`);
			input.setRawMode(false);
			input.pause();
			input.off("data", onData);
			out.off("resize", render);
			process.off("exit", restore);
		};
		const finish = (value: number | null) => {
			restore();
			resolve(value);
		};
		const take = (i: number) => {
			const c = choices[i];
			if (!c) return;
			if (!c.error) return finish(i);
			cursor = i;
			message = `${c.label}: ${c.preview}`;
		};
		const onKey = (key: Key) => {
			message = "";
			const cmd = key.name === "char" ? (key.base ?? "") : key.name;
			if (key.name === "ctrl-c" || cmd === "q" || cmd === "escape") return finish(null);
			if (cmd === "up" || cmd === "k") cursor = (cursor + choices.length - 1) % choices.length;
			else if (cmd === "down" || cmd === "j") cursor = (cursor + 1) % choices.length;
			else if (cmd === "enter") take(cursor);
			else {
				const hit = choices.findIndex((c) => c.key === cmd);
				if (hit !== -1) take(hit);
			}
		};
		const onData = (data: Buffer) => {
			for (const key of decodeKeys(data)) {
				if (!up) return;
				onKey(key);
			}
			if (up) render();
		};

		out.write(`${CSI}?25l`);
		input.setRawMode(true);
		input.resume();
		input.on("data", onData);
		out.on("resize", render);
		// process.exit from anywhere still gives the terminal back
		process.on("exit", restore);
		render();
	});
}
