import { expect, test } from "bun:test";
import { DRAFT_TITLE_LIMIT, rowTitle, TITLE_LIMIT } from "../src/title";

test("a short title is shown as is", () => {
	expect(rowTitle("fix: login", false)).toBe("fix: login");
});

test(`a long title is cut to ${TITLE_LIMIT} characters, ending in an ellipsis`, () => {
	const title = "fix: guard PDF export against a stale item path after rename (gh#7123) and more words";
	const shown = rowTitle(title, false);
	expect(shown.length).toBeLessThanOrEqual(TITLE_LIMIT);
	expect(shown.endsWith("…")).toBe(true);
	expect(title.startsWith(shown.slice(0, -1).trimEnd())).toBe(true);
});

test("the cut does not leave a space before the ellipsis", () => {
	const title = `${"a".repeat(TITLE_LIMIT - 2)} bcdef`;
	expect(rowTitle(title, false)).toBe(`${"a".repeat(TITLE_LIMIT - 2)}…`);
});

test("a draft loses the prefix its tag already says", () => {
	expect(rowTitle("Draft: fix: login", true)).toBe("fix: login");
	expect(rowTitle("[Draft] fix: login", true)).toBe("fix: login");
	expect(rowTitle("draft: fix", true)).toBe("fix");
	// not a draft by GitLab's word: the text stays
	expect(rowTitle("Draft: fix: login", false)).toBe("Draft: fix: login");
});

test("emoji and other wide code points are not split in half", () => {
	const title = `${"x".repeat(TITLE_LIMIT - 2)}🙂🙂🙂`;
	const shown = rowTitle(title, false);
	expect([...shown]).toHaveLength(TITLE_LIMIT);
	expect(shown).toBe(`${"x".repeat(TITLE_LIMIT - 2)}🙂…`);
});

test(`a draft is cut to ${DRAFT_TITLE_LIMIT}: its tag takes the rest of the room`, () => {
	const words = "word ".repeat(30).trim();
	expect([...rowTitle(words, true)].length).toBeLessThanOrEqual(DRAFT_TITLE_LIMIT);
	expect([...rowTitle(words, false)].length).toBeGreaterThan(DRAFT_TITLE_LIMIT);
	const exact = "d".repeat(DRAFT_TITLE_LIMIT);
	expect(rowTitle(exact, true)).toBe(exact);
	expect(rowTitle(`${exact}d`, true)).toBe(`${"d".repeat(DRAFT_TITLE_LIMIT - 1)}…`);
});
