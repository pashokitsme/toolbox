// Runs every query against a real host, outside Raycast:
//   bun test/smoke.ts <host> <group/project>
// The host needs a token in glab's config; the project needs open merge
// requests. Search terms are taken from what the first queries return, so
// every search below should find something.

import { loadHosts } from "../src/glab-config";
import {
	fetchCurrentUsername,
	fetchFrecentProjects,
	fetchMembers,
	fetchMergeRequestDetail,
	fetchMergeRequests,
	fetchProjects,
} from "../src/queries";

const [hostName, fullPath] = process.argv.slice(2);
if (!hostName || !fullPath) {
	console.error("usage: bun test/smoke.ts <host> <group/project>");
	process.exit(2);
}
const host = (await loadHosts()).find((h) => h.host === hostName);
if (!host) {
	console.error(`no token for ${hostName} in glab's config`);
	process.exit(1);
}

/** A word of at least `length` letters out of `text`, to search for. */
const wordOf = (text: string, length = 4) =>
	text.match(new RegExp(`[\\p{L}\\d]{${length},}`, "u"))?.[0] ?? "";

const me = await fetchCurrentUsername(host);
console.log("me:", me);
console.log(
	"frecent:",
	(await fetchFrecentProjects(host)).map((p) => p.fullPath),
);

const projects = await fetchProjects(host, "", null);
console.log(
	"projects page 1:",
	projects.items.length,
	"hasMore:",
	projects.hasMore,
);
const next = await fetchProjects(host, "", projects.cursor);
console.log("projects page 2 first:", next.items[0]?.fullPath);
console.log(
	"projects, 2-letter search (not sent, so unfiltered):",
	(await fetchProjects(host, "ab", null)).items.length,
);
const projectWord = wordOf(projects.items[0]?.name ?? "");
console.log(
	`projects '${projectWord}':`,
	(await fetchProjects(host, projectWord, null)).items.map((p) => p.fullPath),
);

const opened = await fetchMergeRequests(
	host,
	fullPath,
	{ state: "opened" },
	"",
	null,
);
console.log("opened MRs:", opened.items.length, "first:", opened.items[0]);
const mine = await fetchMergeRequests(
	host,
	fullPath,
	{ state: "all", draft: false, authorUsername: me },
	"",
	null,
);
console.log("mine, no drafts:", mine.items.length);

const first = opened.items[0];
if (!first) {
	console.error(`${fullPath} has no open merge requests to look into`);
	process.exit(1);
}
const titleWord = wordOf(first.title);
const searched = await fetchMergeRequests(
	host,
	fullPath,
	{ state: "all" },
	titleWord,
	null,
);
console.log(
	`search '${titleWord}':`,
	searched.items.map((m) => `!${m.iid}`),
	searched.items.some((m) => m.iid === first.iid)
		? "(finds the first)"
		: "(MISSES the first)",
);

console.log(
	"detail:",
	await fetchMergeRequestDetail(host, fullPath, first.iid),
);
const memberSearch = me.slice(0, 3);
console.log(
	`members '${memberSearch}':`,
	(await fetchMembers(host, fullPath, memberSearch, null)).items.map(
		(p) => p.username,
	),
);
