import { expect, test } from "bun:test";
import { collectMatching } from "../src/paging";
import type { Page } from "../src/queries";

// pages of numbers 0..: page n holds n*10 .. n*10+9, its cursor is "c<n+1>"
function source(pages: number) {
	const calls: (string | null)[] = [];
	const fetchPage = async (cursor: string | null): Promise<Page<number>> => {
		calls.push(cursor);
		const index = cursor ? Number(cursor.slice(1)) : 0;
		return {
			items: Array.from({ length: 10 }, (_, i) => index * 10 + i),
			cursor: `c${index + 1}`,
			hasMore: index + 1 < pages,
		};
	};
	return { calls, fetchPage };
}

test("reads pages until enough items match", async () => {
	const { calls, fetchPage } = source(10);
	const page = await collectMatching(fetchPage, (n) => n % 2 === 0, null, {
		want: 12,
		maxPages: 5,
	});
	expect(page.items).toEqual([
		0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28,
	]);
	expect(calls).toEqual([null, "c1", "c2"]);
	expect(page).toMatchObject({ cursor: "c3", hasMore: true });
});

test("stops at maxPages and hands back the cursor to continue from", async () => {
	const { calls, fetchPage } = source(10);
	const page = await collectMatching(fetchPage, (n) => n === 999, "c2", {
		want: 20,
		maxPages: 3,
	});
	expect(page.items).toEqual([]);
	expect(calls).toEqual(["c2", "c3", "c4"]);
	expect(page).toMatchObject({ cursor: "c5", hasMore: true });
});

test("stops when GitLab has no more pages", async () => {
	const { calls, fetchPage } = source(2);
	const page = await collectMatching(fetchPage, () => true, null, {
		want: 100,
		maxPages: 5,
	});
	expect(page.items).toHaveLength(20);
	expect(calls).toHaveLength(2);
	expect(page.hasMore).toBe(false);
});
