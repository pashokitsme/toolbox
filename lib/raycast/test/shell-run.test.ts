import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
	HISTORY_LIMIT,
	OUTPUT_LIMIT,
	appendOutput,
	outputMarkdown,
	parseShellHistory,
	rememberCommand,
	runShell,
	stripAnsi,
} from "../src/shell-run";

describe("stripAnsi", () => {
	test("takes out colors, cursor moves and OSC links, keeps the text", () => {
		expect(stripAnsi("[1;31merror[0m: [2Kdone")).toBe("error: done");
		expect(stripAnsi("]8;;https://xlink]8;;")).toBe("link");
	});

	test("a carriage return overwrites the line, like a terminal shows it", () => {
		expect(stripAnsi("10%\r50%\r100%\nnext")).toBe("100%\nnext");
		expect(stripAnsi("crlf line\r\nnext")).toBe("crlf line\nnext");
	});
});

describe("outputMarkdown", () => {
	test("the command and its output go into one code block", () => {
		expect(outputMarkdown("ls", "a\nb\n", null)).toBe("```\n$ ls\na\nb\n```");
	});

	test("the fence is longer than any run of backticks in the output", () => {
		const markdown = outputMarkdown("cat README.md", "```sh\nx\n````\n", null);
		expect(markdown.startsWith("`````\n")).toBe(true);
		expect(markdown.endsWith("\n`````")).toBe(true);
	});

	test("a finished command says how it ended unless it went fine", () => {
		expect(outputMarkdown("true", "", 0)).toBe("```\n$ true\n```");
		expect(outputMarkdown("false", "", 1)).toBe("```\n$ false\n```\n\nexit 1");
		expect(outputMarkdown("sleep 9", "", "SIGTERM")).toBe(
			"```\n$ sleep 9\n```\n\nstopped (SIGTERM)",
		);
	});
});

test(`appendOutput keeps only the last ${OUTPUT_LIMIT} characters, from a line start`, () => {
	const long = `${"x".repeat(OUTPUT_LIMIT)}\nlast line\n`;
	const kept = appendOutput("first\n", long);
	expect(kept.length).toBeLessThanOrEqual(OUTPUT_LIMIT + 40);
	expect(kept.startsWith("… earlier output cut\n")).toBe(true);
	expect(kept.endsWith("last line\n")).toBe(true);
	expect(appendOutput("a\n", "b\n")).toBe("a\nb\n");
});

describe("history", () => {
	test("the latest command comes first, once, trimmed", () => {
		expect(rememberCommand(["ls", "git status"], "  git status ")).toEqual([
			"git status",
			"ls",
		]);
		expect(rememberCommand(["ls"], "   ")).toEqual(["ls"]);
	});

	test(`keeps ${HISTORY_LIMIT} commands`, () => {
		let history: string[] = [];
		for (let i = 0; i < HISTORY_LIMIT + 3; i += 1)
			history = rememberCommand(history, `echo ${i}`);
		expect(history).toHaveLength(HISTORY_LIMIT);
		expect(history[0]).toBe(`echo ${HISTORY_LIMIT + 2}`);
	});

	test("reads back what was stored, and nothing from garbage", () => {
		expect(parseShellHistory(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
		expect(parseShellHistory(JSON.stringify(["a", 3, null]))).toEqual(["a"]);
		expect(parseShellHistory("nope")).toEqual([]);
		expect(parseShellHistory(undefined)).toEqual([]);
	});
});

describe("runShell", () => {
	const collect = async (
		command: string,
		options: Parameters<typeof runShell>[1] = {},
	) => {
		let output = "";
		const run = runShell(command, {
			...options,
			onOutput: (chunk) => (output += chunk),
		});
		const ended = await run.done;
		return { output, ended };
	};

	test("runs in the home directory, stdout and stderr together, with its exit code", async () => {
		const { output, ended } = await collect(
			"pwd; echo out; echo err >&2; exit 3",
		);
		expect(output).toContain(homedir());
		expect(output).toContain("out");
		expect(output).toContain("err");
		expect(ended).toBe(3);
	});

	test("the shell setup is read, so what the terminal has is there", async () => {
		const { output, ended } = await collect(
			'[[ -o login && -o interactive ]] && echo "login interactive"',
		);
		expect(output).toContain("login interactive");
		expect(ended).toBe(0);
	});

	test("stop ends the command and says with which signal", async () => {
		let output = "";
		const run = runShell("echo started; sleep 30", {
			onOutput: (chunk) => (output += chunk),
		});
		while (!output.includes("started")) await Bun.sleep(20);
		run.stop();
		expect(await run.done).toBe("SIGTERM");
	}, 15000);
});
