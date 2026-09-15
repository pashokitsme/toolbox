// Every GraphQL document the extension sends, and the plain shapes the screens
// get back. Only this file knows GitLab's field names.

import type { Host } from "./glab-config";
import { AuthError, absoluteUrl, graphql } from "./gitlab";

export type Project = {
	fullPath: string;
	name: string;
	webUrl: string;
	avatarUrl?: string;
	lastActivityAt: string;
};
export type Person = { username: string; name: string; avatarUrl?: string };
export type MergeRequestState = "opened" | "merged" | "closed" | "locked";
export type MergeRequest = {
	iid: string;
	title: string;
	state: MergeRequestState;
	draft: boolean;
	webUrl: string;
	updatedAt: string;
	author: Person;
	pipelineStatus: string | null;
};
export type MergeRequestDetail = {
	description: string;
	sourceBranch: string;
	targetBranch: string;
	conflicts: boolean;
	createdAt: string;
	updatedAt: string;
	webUrl: string;
	labels: { title: string; color: string }[];
	reviewers: { username: string; approved: boolean }[];
	assignees: string[];
	pipeline: { status: string; webUrl?: string } | null;
};
export type Page<T> = { items: T[]; cursor: string | null; hasMore: boolean };
export type MergeRequestQuery = {
	state: "opened" | "merged" | "closed" | "all";
	draft?: boolean;
	authorUsername?: string;
	reviewerUsername?: string;
	assigneeUsername?: string;
};

const PAGE_SIZE = 20;
// GitLab finds nothing for a shorter search string
export const MIN_SEARCH = 3;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type RawProject = {
	fullPath: string;
	name: string;
	webUrl: string;
	avatarUrl: string | null;
	lastActivityAt: string;
};
type RawPerson = { username: string; name: string; avatarUrl: string | null };

const PROJECT_FIELDS = "fullPath name webUrl avatarUrl lastActivityAt";
const PERSON_FIELDS = "username name avatarUrl";

const toProject = (host: Host, raw: RawProject): Project => ({
	fullPath: raw.fullPath,
	name: raw.name,
	webUrl: absoluteUrl(host, raw.webUrl) ?? raw.webUrl,
	avatarUrl: absoluteUrl(host, raw.avatarUrl),
	lastActivityAt: raw.lastActivityAt,
});

const toPerson = (host: Host, raw: RawPerson): Person => ({
	username: raw.username,
	name: raw.name,
	avatarUrl: absoluteUrl(host, raw.avatarUrl),
});

const page = <T>(items: T[], info: PageInfo): Page<T> => ({
	items,
	cursor: info.endCursor,
	hasMore: info.hasNextPage,
});

function projectOf<T>(data: { project: T | null }, fullPath: string): T {
	if (!data.project)
		throw new Error(`no project ${fullPath} there, or no access to it`);
	return data.project;
}

export async function fetchCurrentUsername(host: Host): Promise<string> {
	const data = await graphql<{ currentUser: { username: string } | null }>(
		host,
		"{ currentUser { username } }",
	);
	if (!data.currentUser) throw new AuthError(host.host);
	return data.currentUser.username;
}

export async function fetchFrecentProjects(host: Host): Promise<Project[]> {
	const data = await graphql<{ frecentProjects: RawProject[] | null }>(
		host,
		`{ frecentProjects { ${PROJECT_FIELDS} } }`,
	);
	return (data.frecentProjects ?? []).map((raw) => toProject(host, raw));
}

export async function fetchProjects(
	host: Host,
	search: string,
	after: string | null,
): Promise<Page<Project>> {
	const data = await graphql<{
		projects: { pageInfo: PageInfo; nodes: RawProject[] };
	}>(
		host,
		`query($search: String, $after: String) {
      projects(membership: true, search: $search, sort: "latest_activity_desc", first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PROJECT_FIELDS} }
      }
    }`,
		{
			search: search.length >= MIN_SEARCH ? search : undefined,
			after: after ?? undefined,
		},
	);
	return page(
		data.projects.nodes.map((raw) => toProject(host, raw)),
		data.projects.pageInfo,
	);
}

export async function fetchMergeRequests(
	host: Host,
	fullPath: string,
	query: MergeRequestQuery,
	search: string,
	after: string | null,
): Promise<Page<MergeRequest>> {
	// `in: [TITLE]` without `search` is an error, so both go in or neither does
	const withSearch = search.length >= MIN_SEARCH;
	type Raw = {
		iid: string;
		title: string;
		state: MergeRequestState;
		draft: boolean;
		webUrl: string;
		updatedAt: string;
		author: RawPerson | null;
		headPipeline: { status: string } | null;
	};
	const data = await graphql<{
		project: { mergeRequests: { pageInfo: PageInfo; nodes: Raw[] } } | null;
	}>(
		host,
		`query($fullPath: ID!, $state: MergeRequestState, $draft: Boolean, $authorUsername: String,
          $reviewerUsername: String, $assigneeUsername: String, $after: String${withSearch ? ", $search: String" : ""}) {
      project(fullPath: $fullPath) {
        mergeRequests(first: ${PAGE_SIZE}, sort: UPDATED_DESC, after: $after, state: $state, draft: $draft,
                      authorUsername: $authorUsername, reviewerUsername: $reviewerUsername,
                      assigneeUsername: $assigneeUsername${withSearch ? ", search: $search, in: [TITLE]" : ""}) {
          pageInfo { hasNextPage endCursor }
          nodes { iid title state draft webUrl updatedAt author { ${PERSON_FIELDS} } headPipeline { status } }
        }
      }
    }`,
		{
			fullPath,
			...query,
			search: withSearch ? search : undefined,
			after: after ?? undefined,
		},
	);
	const connection = projectOf(data, fullPath).mergeRequests;
	return page(
		connection.nodes.map((raw) => ({
			iid: raw.iid,
			title: raw.title,
			state: raw.state,
			draft: raw.draft,
			webUrl: raw.webUrl,
			updatedAt: raw.updatedAt,
			author: raw.author
				? toPerson(host, raw.author)
				: { username: "ghost", name: "Deleted user" },
			pipelineStatus: raw.headPipeline?.status ?? null,
		})),
		connection.pageInfo,
	);
}

export async function fetchMergeRequestDetail(
	host: Host,
	fullPath: string,
	iid: string,
): Promise<MergeRequestDetail> {
	type Raw = {
		description: string | null;
		sourceBranch: string;
		targetBranch: string;
		conflicts: boolean;
		createdAt: string;
		updatedAt: string;
		webUrl: string;
		labels: { nodes: { title: string; color: string }[] } | null;
		reviewers: {
			nodes: {
				username: string;
				mergeRequestInteraction: { approved: boolean } | null;
			}[];
		} | null;
		assignees: { nodes: { username: string }[] } | null;
		headPipeline: { status: string; path: string | null } | null;
	};
	const data = await graphql<{ project: { mergeRequest: Raw | null } | null }>(
		host,
		`query($fullPath: ID!, $iid: String!) {
      project(fullPath: $fullPath) {
        mergeRequest(iid: $iid) {
          description sourceBranch targetBranch conflicts createdAt updatedAt webUrl
          labels { nodes { title color } }
          reviewers { nodes { username mergeRequestInteraction { approved } } }
          assignees { nodes { username } }
          headPipeline { status path }
        }
      }
    }`,
		{ fullPath, iid },
	);
	const raw = projectOf(data, fullPath).mergeRequest;
	if (!raw) throw new Error(`no merge request !${iid} in ${fullPath}`);
	return {
		description: raw.description ?? "",
		sourceBranch: raw.sourceBranch,
		targetBranch: raw.targetBranch,
		conflicts: raw.conflicts,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		webUrl: raw.webUrl,
		labels: raw.labels?.nodes ?? [],
		reviewers: (raw.reviewers?.nodes ?? []).map((r) => ({
			username: r.username,
			approved: r.mergeRequestInteraction?.approved ?? false,
		})),
		assignees: (raw.assignees?.nodes ?? []).map((a) => a.username),
		pipeline: raw.headPipeline
			? {
					status: raw.headPipeline.status,
					webUrl: absoluteUrl(host, raw.headPipeline.path),
				}
			: null,
	};
}

export async function fetchMembers(
	host: Host,
	fullPath: string,
	search: string,
	after: string | null,
): Promise<Page<Person>> {
	const data = await graphql<{
		project: {
			projectMembers: {
				pageInfo: PageInfo;
				nodes: { user: RawPerson | null }[];
			};
		} | null;
	}>(
		host,
		`query($fullPath: ID!, $search: String, $after: String) {
      project(fullPath: $fullPath) {
        projectMembers(search: $search, first: ${PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { user { ${PERSON_FIELDS} } }
        }
      }
    }`,
		{ fullPath, search: search || undefined, after: after ?? undefined },
	);
	const connection = projectOf(data, fullPath).projectMembers;
	// a member invited by email has no user yet
	const people = connection.nodes.flatMap((node) =>
		node.user ? [toPerson(host, node.user)] : [],
	);
	return page(people, connection.pageInfo);
}
