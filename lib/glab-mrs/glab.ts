// Everything that shells out: glab, the browser and the macOS clipboard.

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "./term.ts";

export type MR = {
	iid: number;
	projectId: number;
	sha: string;
	title: string;
	url: string;
	state: string;
	draft: boolean;
	author: string;
	assignees: string[];
	reviewers: string[];
	labels: string[];
	sourceBranch: string;
	targetBranch: string;
	createdAt: string;
	updatedAt: string;
	comments: number;
	upvotes: number;
	hasConflicts: boolean;
	mergeStatus: string;
	description: string;
};

const str = (v: unknown, fallback = ""): string =>
	typeof v === "string" ? v : fallback;

/** glab boxes what went wrong: a colored ERROR banner, a blank line, then the
 *  sentence worth repeating. Anything that shows one line wants that one. */
const complaint = (text: string): string =>
	text
		.split("\n")
		.map((line) => stripAnsi(line).trim())
		.find((line) => line && !/^error:?$/i.test(line)) ?? "";

// biome-ignore lint/suspicious/noExplicitAny: raw glab JSON
const users = (v: any): string[] =>
	Array.isArray(v) ? v.map((u) => str(u?.username)).filter(Boolean) : [];

// biome-ignore lint/suspicious/noExplicitAny: raw glab JSON
const toMR = (m: any): MR => ({
	iid: Number(m.iid),
	projectId: Number(m.project_id),
	sha: str(m.sha),
	title: str(m.title),
	url: str(m.web_url),
	state: str(m.state, "opened"),
	draft: Boolean(m.draft),
	author: str(m.author?.username, "?"),
	assignees: users(m.assignees),
	reviewers: users(m.reviewers),
	labels: Array.isArray(m.labels) ? m.labels.map((l: unknown) => str(l)) : [],
	sourceBranch: str(m.source_branch),
	targetBranch: str(m.target_branch),
	createdAt: str(m.created_at),
	updatedAt: str(m.updated_at),
	comments: Number(m.user_notes_count ?? 0),
	upvotes: Number(m.upvotes ?? 0),
	hasConflicts: Boolean(m.has_conflicts),
	mergeStatus: str(m.detailed_merge_status),
	description: str(m.description),
});

/** One page of merge requests. `page` is only passed on when the list asks for
 *  the next one — the first call stays exactly the command line the user
 *  typed, page and all. */
export async function listMRs(args: string[], page = 1): Promise<MR[]> {
	const paging = page > 1 ? ["--page", String(page)] : [];
	const proc = Bun.spawn(
		["glab", "mr", "list", ...args, ...paging, "--output", "json"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(complaint(err) || `glab mr list exited with ${code}`);

	// biome-ignore lint/suspicious/noExplicitAny: raw glab JSON
	let raw: any;
	try {
		raw = JSON.parse(out);
	} catch {
		throw new Error(
			`glab returned something that is not JSON:\n${out.slice(0, 400)}`,
		);
	}
	if (!Array.isArray(raw)) return [];

	return raw.map(toMR);
}

// --------------------------------------------------------------- one request

/** A merge request named on the command line: a link, or a number in a repo. */
export type MRRef = {
	host: string | null; // null: whatever host the current directory speaks to
	project: string; // ready for the API path — encoded, or a glab placeholder
	iid: number;
};

/** A `-R`, the same two shapes `glab` itself takes: `group/project`, or a whole
 *  URL, which is what makes a number work from a directory that is not a
 *  repository. A namespace may contain dots, so only a scheme or a `user@` says
 *  that the first segment is a host — `-R web.dev/site` is a project. */
function parseRepo(repo: string): { host: string | null; path: string } {
	const url =
		/^(?:(?:https?|ssh|git):\/\/|[^@/\s]+@)([^/:\s]+)[/:](.+?)(?:\.git)?$/.exec(
			repo,
		);
	if (url) return { host: url[1] ?? null, path: url[2] ?? "" };
	return { host: null, path: repo.replace(/\.git$/, "") };
}

/** `https://host/group/project/-/merge_requests/123` (the scheme is optional),
 *  or `!123`/`123`, which mean that number in `repo` — the `-R` of the command
 *  line, or the repository of the current directory. */
export function parseMRRef(ref: string, repo?: string): MRRef | null {
	// `/-/merge_requests/<number>` is what makes this a link, so the host in
	// front of it needs no shape of its own — gitlab, localhost:8080, anything
	const link =
		/^(?:https?:\/\/)?([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(ref);
	if (link)
		return {
			host: link[1] ?? null,
			project: encodeURIComponent(link[2] ?? ""),
			iid: Number(link[3]),
		};

	const number = /^!?(\d+)$/.exec(ref);
	if (!number) return null;

	const where = repo ? parseRepo(repo) : null;
	return {
		host: where?.host ?? null,
		project: where ? encodeURIComponent(where.path) : ":fullpath",
		iid: Number(number[1]),
	};
}

/** The one merge request a reference points at. Everything that follows —
 *  pipelines, jobs, logs, images — then talks to the host it came from. */
export async function fetchMR(ref: MRRef): Promise<MR> {
	useHost(ref.host);
	const { body, error } = await apiRaw(
		`projects/${ref.project}/merge_requests/${ref.iid}`,
	);
	if (error) throw new Error(error);

	// biome-ignore lint/suspicious/noExplicitAny: raw GitLab JSON
	let raw: any;
	try {
		raw = JSON.parse(body);
	} catch {
		throw new Error(
			`glab returned something that is not JSON:\n${body.slice(0, 400)}`,
		);
	}
	if (!raw?.iid) throw new Error(`no merge request !${ref.iid} there`);
	return toMR(raw);
}

// ---------------------------------------------------------------- pipelines

/** GitLab pipeline statuses, collapsed to what the list needs to show. */
export type PipelineState = "running" | "success" | "failed" | "other" | "none";

export function pipelineState(status: string): PipelineState {
	switch (status) {
		case "created":
		case "waiting_for_resource":
		case "preparing":
		case "pending":
		case "running":
		case "scheduled":
			return "running";
		case "success":
			return "success";
		case "failed":
			return "failed";
		case "":
			return "none";
		default:
			return "other"; // canceled, skipped, manual
	}
}

/** Which GitLab every API call goes to. `glab` picks it from the current
 *  directory, which is wrong once a link names another host, so a link sets it
 *  and everything after that follows. */
let host: string | null = null;

export const useHost = (value: string | null): void => {
	host = value;
};

async function apiRaw(
	path: string,
	method: "GET" | "POST" = "GET",
): Promise<{ body: string; error: string | null }> {
	const where = host ? ["--hostname", host] : [];
	const cmd =
		method === "GET"
			? ["glab", "api", ...where, path]
			: ["glab", "api", ...where, "-X", method, path];
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [body, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		const message =
			// glab prints the API error as JSON on stdout and a summary on stderr
			(() => {
				try {
					const parsed = JSON.parse(body) as {
						message?: unknown;
						error?: unknown;
					};
					const m = parsed.message ?? parsed.error;
					if (typeof m === "string") return m;
					if (m) return JSON.stringify(m);
				} catch {}
				return complaint(err) || `exit ${code}`;
			})();
		return { body, error: message };
	}
	return { body, error: null };
}

async function api(
	path: string,
	method: "GET" | "POST" = "GET",
): Promise<unknown | null> {
	const { body, error } = await apiRaw(path, method);
	if (error) return null;
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

/** One call that usually covers every merge request on screen: the newest
 *  pipelines of the project, keyed by the commit they ran on. */
export async function recentPipelines(
	projectId: number,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const raw = await api(`projects/${projectId}/pipelines?per_page=100`);
	if (!Array.isArray(raw)) return map;
	// newest first — keep the first status seen per sha
	for (const p of raw) {
		const sha = str((p as { sha?: unknown }).sha);
		const status = str((p as { status?: unknown }).status);
		if (sha && status && !map.has(sha)) map.set(sha, status);
	}
	return map;
}

/** Fallback for merge requests whose head commit is older than that page. */
export async function pipelineForSha(
	projectId: number,
	sha: string,
): Promise<string> {
	const raw = await api(
		`projects/${projectId}/pipelines?sha=${sha}&per_page=1`,
	);
	if (!Array.isArray(raw) || raw.length === 0) return "";
	return str((raw[0] as { status?: unknown }).status);
}

// -------------------------------------------------------------- ci: pipelines

export type Pipeline = {
	id: number;
	status: string;
	ref: string;
	sha: string;
	webUrl: string;
	updatedAt: string;
};

export type Job = {
	id: number;
	name: string;
	stage: string;
	status: string;
	allowFailure: boolean;
	duration: number | null;
	failureReason: string;
	webUrl: string;
	startedAt: string;
};

// biome-ignore lint/suspicious/noExplicitAny: raw GitLab JSON
const toPipeline = (p: any): Pipeline => ({
	id: Number(p.id),
	status: str(p.status),
	ref: str(p.ref),
	sha: str(p.sha),
	webUrl: str(p.web_url),
	updatedAt: str(p.updated_at),
});

/** Pipelines of a merge request, newest first. */
export async function mrPipelines(
	projectId: number,
	iid: number,
): Promise<Pipeline[]> {
	const raw = await api(
		`projects/${projectId}/merge_requests/${iid}/pipelines?per_page=20`,
	);
	return Array.isArray(raw) ? raw.map(toPipeline) : [];
}

export async function pipelineJobs(
	projectId: number,
	pipelineId: number,
): Promise<Job[]> {
	const raw = await api(
		`projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`,
	);
	if (!Array.isArray(raw)) return [];
	// biome-ignore lint/suspicious/noExplicitAny: raw GitLab JSON
	return raw.map((j: any) => ({
		id: Number(j.id),
		name: str(j.name),
		stage: str(j.stage),
		status: str(j.status),
		allowFailure: Boolean(j.allow_failure),
		duration: typeof j.duration === "number" ? j.duration : null,
		failureReason: str(j.failure_reason),
		webUrl: str(j.web_url),
		startedAt: str(j.started_at),
	}));
}

/** Raw job log. Runner section markers are dropped, colors are kept. */
export async function jobTrace(
	projectId: number,
	jobId: number,
): Promise<string> {
	const { body, error } = await apiRaw(
		`projects/${projectId}/jobs/${jobId}/trace`,
	);
	if (error) return `${error}`;
	return body
		.replace(/section_(start|end):\d+:[\w-]+\r?/g, "")
		.replace(/\x1b\[0K/g, "")
		.replace(/\r\n/g, "\n");
}

/** Every mutation returns null on success or a message to show the user. */
const mutate = async (path: string): Promise<string | null> =>
	(await apiRaw(path, "POST")).error;

export const retryJob = (
	projectId: number,
	jobId: number,
): Promise<string | null> =>
	mutate(`projects/${projectId}/jobs/${jobId}/retry`);

export const cancelJob = (
	projectId: number,
	jobId: number,
): Promise<string | null> =>
	mutate(`projects/${projectId}/jobs/${jobId}/cancel`);

export const playJob = (
	projectId: number,
	jobId: number,
): Promise<string | null> => mutate(`projects/${projectId}/jobs/${jobId}/play`);

export const retryPipeline = (
	projectId: number,
	pipelineId: number,
): Promise<string | null> =>
	mutate(`projects/${projectId}/pipelines/${pipelineId}/retry`);

export const cancelPipeline = (
	projectId: number,
	pipelineId: number,
): Promise<string | null> =>
	mutate(`projects/${projectId}/pipelines/${pipelineId}/cancel`);

/** Token for the given host, so image uploads behind auth can be fetched. */
export function tokenFor(host: string): string | undefined {
	for (const env of [
		"GITLAB_TOKEN",
		"GITLAB_ACCESS_TOKEN",
		"GITLAB_PERSONAL_ACCESS_TOKEN",
	]) {
		const v = process.env[env];
		if (v) return v;
	}
	const out = Bun.spawnSync(["glab", "config", "get", "token", "-h", host]);
	if (out.exitCode !== 0) return undefined;
	const token = out.stdout.toString().trim();
	return token || undefined;
}

export const openInBrowser = (url: string): void => {
	Bun.spawnSync(["open", url]);
};

/** Rich hyperlink (title reads as a link when pasted) plus a plain-text flavor.
 *  False means the clipboard was left alone — the caller has to say so, since
 *  nothing else will. */
export function copyRichLink(title: string, url: string): boolean {
	const html = title
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	const rtfPath = join(tmpdir(), `glab-mrs-${process.pid}.rtf`);

	const rtf = Bun.spawnSync(
		[
			"textutil",
			"-stdin",
			"-format",
			"html",
			"-inputencoding",
			"UTF-8",
			"-convert",
			"rtf",
			"-stdout",
		],
		{
			stdin: new TextEncoder().encode(
				`<meta charset="utf-8"><a href="${url}">${html}</a>`,
			),
		},
	);
	if (rtf.exitCode !== 0) return false;

	try {
		writeFileSync(rtfPath, rtf.stdout);
		const script = [
			"on run argv",
			"\tset rtfData to (read (POSIX file (item 1 of argv)) as «class RTF »)",
			"\tset the clipboard to {«class RTF »:rtfData, string:(item 2 of argv)}",
			"end run",
		].join("\n");
		const paste = Bun.spawnSync(
			["osascript", "-", rtfPath, `${title} — ${url}`],
			{
				stdin: new TextEncoder().encode(script),
			},
		);
		return paste.exitCode === 0;
	} finally {
		try {
			unlinkSync(rtfPath);
		} catch {}
	}
}

export function copyText(value: string): void {
	Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(value) });
}
