// GitLab cannot filter merge requests by pipeline status, so a filtered page
// can come back nearly empty — and Raycast only asks for the next page when
// the user scrolls past enough rows. One page for Raycast is therefore as many
// GitLab pages as it takes to fill it, with a ceiling so a rare status does not
// walk the whole project.

import type { Page } from "./queries";

export async function collectMatching<T>(
	fetchPage: (cursor: string | null) => Promise<Page<T>>,
	predicate: (item: T) => boolean,
	start: string | null,
	options: { want: number; maxPages: number },
): Promise<Page<T>> {
	const items: T[] = [];
	let cursor = start;
	let hasMore = true;
	for (
		let read = 0;
		read < options.maxPages && hasMore && items.length < options.want;
		read += 1
	) {
		const page = await fetchPage(cursor);
		items.push(...page.items.filter(predicate));
		cursor = page.cursor;
		hasMore = page.hasMore;
	}
	return { items, cursor, hasMore };
}
