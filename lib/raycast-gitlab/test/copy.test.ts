import { describe, expect, test } from "bun:test";
import { markdownLink, richLink } from "../src/copy";

describe("richLink", () => {
	test("wraps the title in an anchor and keeps a plain-text fallback", () => {
		expect(
			richLink(
				"Fix login",
				"https://gitlab.example.com/g/p/-/merge_requests/1",
			),
		).toEqual({
			html: '<a href="https://gitlab.example.com/g/p/-/merge_requests/1">Fix login</a>',
			text: "Fix login — https://gitlab.example.com/g/p/-/merge_requests/1",
		});
	});

	test("escapes HTML in the title and the url", () => {
		const link = richLink('a < b & "c" > d', "https://x/?a=1&b=2");
		expect(link.html).toBe(
			'<a href="https://x/?a=1&amp;b=2">a &lt; b &amp; &quot;c&quot; &gt; d</a>',
		);
		expect(link.text).toBe('a < b & "c" > d — https://x/?a=1&b=2');
	});
});

describe("markdownLink", () => {
	test("escapes square brackets in the title", () => {
		expect(markdownLink("[draft] fix", "https://x/1")).toBe(
			"[\\[draft\\] fix](https://x/1)",
		);
	});
});

test("markdownLink escapes a backslash so it cannot eat the closing bracket", () => {
	expect(markdownLink("path C:\\dir\\", "https://x/1")).toBe("[path C:\\\\dir\\\\](https://x/1)");
});
