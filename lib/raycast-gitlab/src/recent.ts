// "My last access": GitLab does not say when you last opened a project, so the
// extension remembers it itself — one list per host in LocalStorage — and puts
// those projects first, GitLab's own frecent projects next, everything else
// after.

import { MIN_SEARCH, type Project } from "./queries";

export type RecentProject = Project & { openedAt: string };
export type ProjectSource = "recent" | "frecent" | "server";
export type ListedProject = {
	project: Project;
	source: ProjectSource;
	openedAt?: string;
};

export const RECENT_LIMIT = 50;

export const recentKey = (host: string): string => `recent-projects:${host}`;

export function parseHistory(raw: unknown): RecentProject[] {
	if (typeof raw !== "string") return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is RecentProject =>
			typeof entry === "object" &&
			entry !== null &&
			typeof entry.fullPath === "string" &&
			typeof entry.name === "string" &&
			typeof entry.webUrl === "string" &&
			typeof entry.lastActivityAt === "string" &&
			typeof entry.openedAt === "string",
	);
}

export function recordOpen(
	history: RecentProject[],
	project: Project,
	now: Date,
): RecentProject[] {
	const rest = history.filter((entry) => entry.fullPath !== project.fullPath);
	return [{ ...project, openedAt: now.toISOString() }, ...rest].slice(
		0,
		RECENT_LIMIT,
	);
}

export function removeRecent(
	history: RecentProject[],
	fullPath: string,
): RecentProject[] {
	return history.filter((entry) => entry.fullPath !== fullPath);
}

export function orderProjects(input: {
	history: RecentProject[];
	frecent: Project[];
	server: Project[];
	searchText: string;
}): ListedProject[] {
	const needle = input.searchText.trim().toLowerCase();
	const contains = (project: Project) =>
		project.fullPath.toLowerCase().includes(needle) ||
		project.name.toLowerCase().includes(needle);
	// GitLab searched the server page itself, and matches descriptions too, so
	// only a search it never ran gets filtered here
	const serverSearched = needle.length >= MIN_SEARCH;

	const seen = new Set<string>();
	const listed: ListedProject[] = [];
	const add = (project: Project, source: ProjectSource, openedAt?: string) => {
		if (seen.has(project.fullPath)) return;
		if (
			needle &&
			!(source === "server" && serverSearched) &&
			!contains(project)
		)
			return;
		seen.add(project.fullPath);
		listed.push({ project, source, openedAt });
	};

	for (const { openedAt, ...project } of input.history)
		add(project, "recent", openedAt);
	for (const project of input.frecent) add(project, "frecent");
	for (const project of input.server) add(project, "server");
	return listed;
}
