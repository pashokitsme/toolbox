// What a merge request row shows as its title. Raycast gives the title all the
// room it wants and pushes the accessories — pipeline, date — off the edge, so
// a long one is cut here; the whole title stays in the tooltip and the panel.

export const TITLE_LIMIT = 70;
// a draft row also carries its tag, so its title gets less of the room
export const DRAFT_TITLE_LIMIT = 60;

// GitLab's own draft markers; the row's draft tag says the same thing
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i;

export function rowTitle(title: string, draft: boolean): string {
	const text = draft ? title.replace(DRAFT_PREFIX, "") : title;
	// by code point, so an emoji is never split into half a surrogate pair
	const characters = [...text];
	const limit = draft ? DRAFT_TITLE_LIMIT : TITLE_LIMIT;
	if (characters.length <= limit) return text;
	return `${characters
		.slice(0, limit - 1)
		.join("")
		.trimEnd()}…`;
}
