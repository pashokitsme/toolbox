// The Shell command's engine: running a command line in zsh the way a terminal
// would, keeping what it prints within bounds, and turning that into markdown
// Raycast can show. No @raycast/api here, so bun test can load it.

import { spawn } from "node:child_process";
import { homedir } from "node:os";

export const HISTORY_LIMIT = 50;
/** Characters of output kept; a command that prints more shows its tail. */
export const OUTPUT_LIMIT = 100_000;

const CUT_MARK = "… earlier output cut\n";

/** Terminal escapes out, and a carriage return overwriting its line the way a
 *  progress bar means it to. */
export function stripAnsi(text: string): string {
	return (
		text
			// OSC (titles, hyperlinks), ended by BEL or ST
			.replace(/\][^]*(?:|\\)/g, "")
			// CSI: colors, cursor moves, erasing
			.replace(/\[[0-?]*[ -/]*[@-~]/g, "")
			// what is left of two-character escapes
			.replace(/[@-Z\\-_]/g, "")
			.replace(/\r\n/g, "\n")
			.split("\n")
			.map((line) => {
				const parts = line.split("\r");
				return parts.findLast((part) => part !== "") ?? "";
			})
			.join("\n")
	);
}

export function appendOutput(current: string, chunk: string): string {
	const combined = current + chunk;
	if (combined.length <= OUTPUT_LIMIT) return combined;
	const tail = combined.slice(-OUTPUT_LIMIT);
	const lineStart = tail.indexOf("\n");
	return CUT_MARK + (lineStart >= 0 ? tail.slice(lineStart + 1) : tail);
}

/** How a command ended: its exit code, or the signal that stopped it; null
 *  while it runs. */
export type Ended = number | string | null;

export function outputMarkdown(
	command: string,
	output: string,
	ended: Ended,
): string {
	let body = `$ ${command}\n${output}`;
	if (!body.endsWith("\n")) body += "\n";
	const longestTicks = Math.max(
		0,
		...(body.match(/`+/g) ?? []).map((run) => run.length),
	);
	const fence = "`".repeat(Math.max(3, longestTicks + 1));
	const block = `${fence}\n${body}${fence}`;
	if (typeof ended === "string") return `${block}\n\nstopped (${ended})`;
	if (typeof ended === "number" && ended !== 0)
		return `${block}\n\nexit ${ended}`;
	return block;
}

export function rememberCommand(history: string[], command: string): string[] {
	const line = command.trim();
	if (!line) return history;
	return [line, ...history.filter((entry) => entry !== line)].slice(
		0,
		HISTORY_LIMIT,
	);
}

export function parseShellHistory(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

export type ShellRun = {
	/** Resolves with the exit code, or with the signal once stop() ended it. */
	done: Promise<number | string>;
	stop(): void;
};

/** An interactive login zsh, so ~/.zprofile and ~/.zshrc are read and the
 *  command sees the PATH, aliases and functions a terminal has. It gets its
 *  own process group, since an interactive zsh ignores SIGTERM: stop() signals
 *  the whole group, and kills it outright if that is not enough. */
export function runShell(
	command: string,
	options: {
		cwd?: string;
		shell?: string;
		onOutput?: (chunk: string) => void;
	} = {},
): ShellRun {
	const child = spawn(options.shell ?? "/bin/zsh", ["-il", "-c", command], {
		cwd: options.cwd ?? homedir(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let stopped: string | null = null;
	let finished = false;

	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => options.onOutput?.(chunk));
	}

	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			if (child.pid) process.kill(-child.pid, signal);
		} catch {
			// the group is already gone
		}
	};

	const done = new Promise<number | string>((resolve) => {
		child.on("error", (error) => {
			options.onOutput?.(`${error.message}\n`);
			finished = true;
			resolve(127);
		});
		child.on("close", (code, signal) => {
			finished = true;
			resolve(stopped ?? code ?? signal ?? 1);
		});
	});

	return {
		done,
		stop() {
			if (finished || stopped) return;
			stopped = "SIGTERM";
			signalGroup("SIGTERM");
			setTimeout(() => {
				if (finished) return;
				stopped = "SIGKILL";
				signalGroup("SIGKILL");
			}, 2000).unref();
		},
	};
}
