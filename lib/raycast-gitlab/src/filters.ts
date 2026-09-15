// The merge request filters: what is remembered between runs, what goes to
// GitLab, what is checked here (the pipeline — GitLab cannot filter by it), and
// the one line that tells which filters are on.

import type { MergeRequestQuery } from "./queries";

export type Role = "author" | "reviewer" | "assignee";
/** `who` is "me" or a username. One role at a time. */
export type People = { role: Role; who: string } | null;
export type StateFilter = MergeRequestQuery["state"];
export type DraftFilter = "any" | "hide" | "only";
export type PipelineFilter =
	| "any"
	| "running"
	| "passed"
	| "failed"
	| "canceled"
	| "none";
export type Filters = {
	people: People;
	state: StateFilter;
	draft: DraftFilter;
	pipeline: PipelineFilter;
};

export const DEFAULT_FILTERS: Filters = {
	people: null,
	state: "opened",
	draft: "any",
	pipeline: "any",
};

const ROLES: Role[] = ["author", "reviewer", "assignee"];
const USERNAME_ARGUMENT = {
	author: "authorUsername",
	reviewer: "reviewerUsername",
	assignee: "assigneeUsername",
} as const;

export function toVariables(filters: Filters, me: string): MergeRequestQuery {
	const query: MergeRequestQuery = { state: filters.state };
	if (filters.draft !== "any") query.draft = filters.draft === "only";
	if (filters.people) {
		query[USERNAME_ARGUMENT[filters.people.role]] =
			filters.people.who === "me" ? me : filters.people.who;
	}
	return query;
}

export function pipelineMatches(
	status: string | null,
	filter: PipelineFilter,
): boolean {
	switch (filter) {
		case "any":
			return true;
		case "none":
			return status === null;
		case "running":
			return [
				"CREATED",
				"WAITING_FOR_RESOURCE",
				"PREPARING",
				"PENDING",
				"RUNNING",
				"SCHEDULED",
			].includes(status ?? "");
		case "passed":
			return status === "SUCCESS";
		case "failed":
			return status === "FAILED";
		case "canceled":
			return status === "CANCELED" || status === "CANCELING";
	}
}

const ROLE_WORD: Record<Role, string> = {
	author: "author",
	reviewer: "review",
	assignee: "assigned",
};

export function describe(filters: Filters): string {
	const parts: string[] = [];
	if (filters.people)
		parts.push(`${ROLE_WORD[filters.people.role]} @${filters.people.who}`);
	if (filters.state !== "opened")
		parts.push(filters.state === "all" ? "any state" : filters.state);
	if (filters.draft === "hide") parts.push("no drafts");
	if (filters.draft === "only") parts.push("drafts only");
	if (filters.pipeline === "none") parts.push("no pipeline");
	else if (filters.pipeline !== "any")
		parts.push(`pipeline ${filters.pipeline}`);
	return parts.join(" · ");
}

export const encodePeople = (people: People): string =>
	people ? `${people.role}:${people.who}` : "any";

export function decodePeople(value: string): People {
	const separator = value.indexOf(":");
	if (separator < 0) return null;
	const role = value.slice(0, separator) as Role;
	const who = value.slice(separator + 1);
	return ROLES.includes(role) && who ? { role, who } : null;
}
