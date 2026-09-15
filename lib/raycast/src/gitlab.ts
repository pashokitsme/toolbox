// One POST to GitLab's GraphQL endpoint. Everything the extension shows comes
// through here, so this is the one place that decides what a failure says.

import type { Host } from "./glab-config";

export class AuthError extends Error {
	constructor(host: string) {
		super(`token rejected by ${host}`);
		this.name = "AuthError";
	}
}

export type Fetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
	ok: boolean;
	status: number;
	statusText: string;
	json(): Promise<unknown>;
}>;

export async function graphql<T>(
	host: Host,
	query: string,
	variables: Record<string, unknown> = {},
	fetchImpl: Fetch = fetch,
): Promise<T> {
	let response: Awaited<ReturnType<Fetch>>;
	try {
		response = await fetchImpl(`${host.apiUrl}/api/graphql`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${host.token}`,
			},
			body: JSON.stringify({ query, variables }),
		});
	} catch (error) {
		// Node says only "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED…) is in cause
		const { message, cause } = error as {
			message?: string;
			cause?: { code?: string; message?: string };
		};
		const reason = cause?.code ?? cause?.message ?? message ?? String(error);
		throw new Error(`cannot reach ${new URL(host.apiUrl).host}: ${reason}`);
	}
	if (response.status === 401) throw new AuthError(host.host);
	if (!response.ok)
		throw new Error(`${response.status} ${response.statusText}`);
	const payload = (await response.json()) as {
		data?: T | null;
		errors?: { message: string }[];
	};
	const first = payload.errors?.[0];
	if (first) throw new Error(first.message);
	if (!payload.data) throw new Error("GitLab returned no data");
	return payload.data;
}

/** GitLab hands out paths for pipelines and uploaded avatars; Raycast needs a whole url. */
export function absoluteUrl(
	host: Host,
	url: string | null | undefined,
): string | undefined {
	if (!url) return undefined;
	if (/^https?:\/\//.test(url)) return url;
	return new URL(url, `${new URL(host.webUrl).origin}/`).toString();
}
