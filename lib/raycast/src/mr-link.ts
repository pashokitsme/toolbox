// A merge request link pasted into the search: which host, project and merge
// request it points at. Only a whole link counts — a word in a search is a
// word — and only hosts from glab's config can be asked about it.

import type { Host } from "./glab-config";

export type MergeRequestLink =
	| { kind: "known"; host: Host; fullPath: string; iid: string }
	| { kind: "unknown"; hostName: string };

const MERGE_REQUEST_PATH = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/;

export function parseMergeRequestLink(
	text: string,
	hosts: Host[],
): MergeRequestLink | null {
	const trimmed = text.trim();
	if (!trimmed || /\s/.test(trimmed)) return null;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}
	if (!/^https?:$/.test(url.protocol)) return null;
	const where = `${url.pathname}${url.search}${url.hash}`;

	for (const host of hosts) {
		const base = new URL(host.webUrl);
		if (base.host !== url.host) continue;
		const prefix = base.pathname.replace(/\/+$/, "");
		if (prefix && !where.startsWith(`${prefix}/`)) continue;
		const match = MERGE_REQUEST_PATH.exec(where.slice(prefix.length));
		if (!match?.[1] || !match[2]) return null;
		return {
			kind: "known",
			host,
			fullPath: decodeURIComponent(match[1]),
			iid: match[2],
		};
	}
	return MERGE_REQUEST_PATH.test(where)
		? { kind: "unknown", hostName: url.host }
		: null;
}
