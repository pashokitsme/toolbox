import { expect, test } from "bun:test";
import { absolutizeMarkdown } from "../src/markdown";

const ORIGIN = "https://gitlab.example.com";
const PROJECT = "https://gitlab.example.com/group/project";
const run = (markdown: string) => absolutizeMarkdown(markdown, ORIGIN, PROJECT);

test("uploads belong to the project, with or without a leading slash", () => {
	expect(run("![shot](/uploads/abc/shot.png)")).toBe(
		`![shot](${PROJECT}/uploads/abc/shot.png)`,
	);
	expect(run("[log](uploads/def/log.txt)")).toBe(
		`[log](${PROJECT}/uploads/def/log.txt)`,
	);
});

test("other root paths resolve against the instance", () => {
	expect(run("see [pipeline](/group/project/-/pipelines/7)")).toBe(
		`see [pipeline](${ORIGIN}/group/project/-/pipelines/7)`,
	);
});

test("img tags are rewritten too", () => {
	expect(run('<img src="/uploads/x/y.png" width="300">')).toBe(
		`<img src="${PROJECT}/uploads/x/y.png" width="300">`,
	);
});

test("absolute links, anchors, mailto and plain relative paths are left alone", () => {
	const untouched =
		"[a](https://example.com/x) [b](#section) [c](mailto:me@example.com) [d](docs/readme.md) [e](//cdn.example.com/z)";
	expect(run(untouched)).toBe(untouched);
});

test("code spans and fenced blocks are shown as written", () => {
	const code = "```\nlink: [a](/api/v4)\n```\nand `[b](/uploads/x.png)` inline, then [c](/uploads/y.png)";
	expect(run(code)).toBe(
		`\`\`\`\nlink: [a](/api/v4)\n\`\`\`\nand \`[b](/uploads/x.png)\` inline, then [c](${PROJECT}/uploads/y.png)`,
	);
	expect(run("~~~sh\n![x](/uploads/z.png)\n~~~")).toBe("~~~sh\n![x](/uploads/z.png)\n~~~");
});

test("a space after the parenthesis and reference definitions resolve too", () => {
	expect(run("[a]( /uploads/x.png)")).toBe(`[a]( ${PROJECT}/uploads/x.png)`);
	expect(run("[ref]: /uploads/x.png\n  [other]: /g/p/-/issues/1")).toBe(
		`[ref]: ${PROJECT}/uploads/x.png\n  [other]: ${ORIGIN}/g/p/-/issues/1`,
	);
});

test("img src in single quotes", () => {
	expect(run("<img alt='a' src='/uploads/x.png'>")).toBe(`<img alt='a' src='${PROJECT}/uploads/x.png'>`);
});
