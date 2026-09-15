import { describe, expect, test } from "bun:test";
import type { Project } from "../src/queries";
import {
	orderProjects,
	parseHistory,
	RECENT_LIMIT,
	recentKey,
	recordOpen,
	removeRecent,
	type RecentProject,
} from "../src/recent";

const project = (
	fullPath: string,
	name = fullPath.split("/").pop() ?? fullPath,
): Project => ({
	fullPath,
	name,
	webUrl: `https://gitlab.example.com/${fullPath}`,
	lastActivityAt: "2026-09-01T00:00:00Z",
});
const opened = (fullPath: string, openedAt: string): RecentProject => ({
	...project(fullPath),
	openedAt,
});

describe("recordOpen", () => {
	test("puts the project on top with the time it was opened", () => {
		const history = recordOpen(
			[opened("a/one", "2026-09-01T00:00:00.000Z")],
			project("b/two"),
			new Date("2026-09-15T10:00:00Z"),
		);
		expect(history.map((h) => [h.fullPath, h.openedAt])).toEqual([
			["b/two", "2026-09-15T10:00:00.000Z"],
			["a/one", "2026-09-01T00:00:00.000Z"],
		]);
	});

	test("opening again moves it up instead of duplicating", () => {
		const history = recordOpen(
			[
				opened("a/one", "2026-09-02T00:00:00.000Z"),
				opened("b/two", "2026-09-01T00:00:00.000Z"),
			],
			project("b/two"),
			new Date("2026-09-15T10:00:00Z"),
		);
		expect(history.map((h) => h.fullPath)).toEqual(["b/two", "a/one"]);
	});

	test(`keeps at most ${RECENT_LIMIT} projects`, () => {
		let history: RecentProject[] = [];
		for (let i = 0; i < RECENT_LIMIT + 5; i += 1)
			history = recordOpen(history, project(`g/p${i}`), new Date(i * 1000));
		expect(history).toHaveLength(RECENT_LIMIT);
		expect(history[0]?.fullPath).toBe(`g/p${RECENT_LIMIT + 4}`);
	});
});

test("removeRecent drops one project", () => {
	expect(
		removeRecent([opened("a/one", "x"), opened("b/two", "y")], "a/one").map(
			(h) => h.fullPath,
		),
	).toEqual(["b/two"]);
});

test("recentKey is per host", () => {
	expect(recentKey("gitlab.example.com")).toBe(
		"recent-projects:gitlab.example.com",
	);
});

describe("parseHistory", () => {
	test("reads what recordOpen produced", () => {
		const history = [opened("a/one", "2026-09-01T00:00:00.000Z")];
		expect(parseHistory(JSON.stringify(history))).toEqual(history);
	});

	test("anything else is an empty history", () => {
		expect(parseHistory(undefined)).toEqual([]);
		expect(parseHistory("not json")).toEqual([]);
		expect(parseHistory(JSON.stringify({ fullPath: "a/one" }))).toEqual([]);
		expect(
			parseHistory(
				JSON.stringify([{ name: "no path" }, opened("a/one", "t")]),
			).map((h) => h.fullPath),
		).toEqual(["a/one"]);
	});
});

describe("orderProjects", () => {
	const history = [opened("a/recent", "2026-09-15T00:00:00.000Z")];
	const frecent = [project("a/recent"), project("b/frecent")];
	const server = [
		project("b/frecent"),
		project("c/server"),
		project("d/described", "Unrelated name"),
	];

	test("recent, then frecent, then server, each project once", () => {
		const listed = orderProjects({ history, frecent, server, searchText: "" });
		expect(listed.map((l) => [l.project.fullPath, l.source])).toEqual([
			["a/recent", "recent"],
			["b/frecent", "frecent"],
			["c/server", "server"],
			["d/described", "server"],
		]);
		expect(listed[0]?.openedAt).toBe("2026-09-15T00:00:00.000Z");
		expect(listed[0]?.project).not.toHaveProperty("openedAt");
	});

	test("a searched-for server page is trusted as is; recent and frecent are filtered by substring", () => {
		const listed = orderProjects({
			history,
			frecent,
			server: [project("d/described", "Unrelated name")],
			searchText: "Serv",
		});
		expect(listed.map((l) => l.project.fullPath)).toEqual(["d/described"]);
	});

	test("a search too short for GitLab filters every source locally", () => {
		const listed = orderProjects({
			history,
			frecent,
			server,
			searchText: "fr",
		});
		expect(listed.map((l) => l.project.fullPath)).toEqual(["b/frecent"]);
	});
});

test("parseHistory drops entries that cannot be listed", () => {
	const raw = JSON.stringify([
		{ fullPath: "a/b", openedAt: "t" },
		{ fullPath: "c/d", name: "d", openedAt: "t" },
		{ fullPath: "e/f", name: "f", webUrl: "https://x/e/f", lastActivityAt: "t", openedAt: "t" },
	]);
	expect(parseHistory(raw).map((h) => h.fullPath)).toEqual(["e/f"]);
});
