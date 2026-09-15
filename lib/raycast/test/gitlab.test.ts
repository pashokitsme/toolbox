import { describe, expect, test } from "bun:test";
import type { Host } from "../src/glab-config";
import { AuthError, absoluteUrl, graphql, type Fetch } from "../src/gitlab";

const HOST: Host = {
	host: "gitlab.example.com",
	apiUrl: "https://api.example.com",
	webUrl: "https://gitlab.example.com",
	token: "t0k",
};

const reply =
	(status: number, body: unknown): Fetch =>
	async () => ({
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Nope",
		json: async () => body,
	});

describe("graphql", () => {
	test("posts the query with a bearer token and returns data", async () => {
		let seen: { url: string; init: Parameters<Fetch>[1] } | undefined;
		const fetchImpl: Fetch = async (url, init) => {
			seen = { url, init };
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ data: { answer: 42 } }),
			};
		};
		const data = await graphql<{ answer: number }>(
			HOST,
			"{ answer }",
			{ a: 1 },
			fetchImpl,
		);
		expect(data).toEqual({ answer: 42 });
		expect(seen?.url).toBe("https://api.example.com/api/graphql");
		expect(seen?.init.method).toBe("POST");
		expect(seen?.init.headers.Authorization).toBe("Bearer t0k");
		expect(JSON.parse(seen?.init.body ?? "")).toEqual({
			query: "{ answer }",
			variables: { a: 1 },
		});
	});

	test("401 is an AuthError naming the host", async () => {
		const error = await graphql<never>(HOST, "{ x }", {}, reply(401, {})).catch(
			(e: Error) => e,
		);
		expect(error).toBeInstanceOf(AuthError);
		expect(error.message).toBe("token rejected by gitlab.example.com");
	});

	test("other failed statuses carry status and text", async () => {
		expect(graphql(HOST, "{ x }", {}, reply(502, {}))).rejects.toThrow(
			"502 Nope",
		);
	});

	test("GraphQL errors surface the first message", async () => {
		expect(
			graphql(
				HOST,
				"{ x }",
				{},
				reply(200, { errors: [{ message: "boom" }, { message: "later" }] }),
			),
		).rejects.toThrow("boom");
	});

	test("a reply without data is an error", async () => {
		expect(graphql(HOST, "{ x }", {}, reply(200, {}))).rejects.toThrow(
			"GitLab returned no data",
		);
	});
});

describe("absoluteUrl", () => {
	test("leaves absolute urls alone", () => {
		expect(absoluteUrl(HOST, "https://cdn.example.com/a.png")).toBe(
			"https://cdn.example.com/a.png",
		);
	});

	test("resolves a path against the web origin", () => {
		expect(absoluteUrl(HOST, "/g/p/-/pipelines/7")).toBe(
			"https://gitlab.example.com/g/p/-/pipelines/7",
		);
	});

	test("empty stays undefined", () => {
		expect(absoluteUrl(HOST, null)).toBeUndefined();
		expect(absoluteUrl(HOST, "")).toBeUndefined();
	});
});

test("a network failure names the host and the reason", async () => {
	const failing: Fetch = async () => {
		throw Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
				code: "ENOTFOUND",
			}),
		});
	};
	expect(graphql(HOST, "{ x }", {}, failing)).rejects.toThrow(
		"cannot reach api.example.com: ENOTFOUND",
	);
});
