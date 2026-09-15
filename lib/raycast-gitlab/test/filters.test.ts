import { describe as group, expect, test } from "bun:test";
import {
	decodePeople,
	DEFAULT_FILTERS,
	describe,
	encodePeople,
	pipelineMatches,
	toVariables,
	type Filters,
} from "../src/filters";

group("toVariables", () => {
	test("defaults ask for opened merge requests and nothing else", () => {
		expect(toVariables(DEFAULT_FILTERS, "me.user")).toEqual({
			state: "opened",
		});
	});

	test("draft maps to a boolean only when it filters", () => {
		expect(toVariables({ ...DEFAULT_FILTERS, draft: "hide" }, "u").draft).toBe(
			false,
		);
		expect(toVariables({ ...DEFAULT_FILTERS, draft: "only" }, "u").draft).toBe(
			true,
		);
	});

	test("people become the username argument of their role, me resolved", () => {
		expect(
			toVariables(
				{
					...DEFAULT_FILTERS,
					state: "all",
					people: { role: "reviewer", who: "me" },
				},
				"pavel",
			),
		).toEqual({
			state: "all",
			reviewerUsername: "pavel",
		});
		expect(
			toVariables(
				{ ...DEFAULT_FILTERS, people: { role: "author", who: "andr" } },
				"pavel",
			).authorUsername,
		).toBe("andr");
		expect(
			toVariables(
				{ ...DEFAULT_FILTERS, people: { role: "assignee", who: "me" } },
				"pavel",
			).assigneeUsername,
		).toBe("pavel");
	});
});

group("pipelineMatches", () => {
	const cases: [string | null, string[]][] = [
		["CREATED", ["any", "running"]],
		["WAITING_FOR_RESOURCE", ["any", "running"]],
		["PREPARING", ["any", "running"]],
		["PENDING", ["any", "running"]],
		["RUNNING", ["any", "running"]],
		["SCHEDULED", ["any", "running"]],
		["SUCCESS", ["any", "passed"]],
		["FAILED", ["any", "failed"]],
		["CANCELED", ["any", "canceled"]],
		["CANCELING", ["any", "canceled"]],
		["SKIPPED", ["any"]],
		["MANUAL", ["any"]],
		[null, ["any", "none"]],
	];
	for (const [status, accepted] of cases) {
		test(`${status} matches ${accepted.join(", ")}`, () => {
			for (const filter of [
				"any",
				"running",
				"passed",
				"failed",
				"canceled",
				"none",
			] as const) {
				expect(pipelineMatches(status, filter)).toBe(accepted.includes(filter));
			}
		});
	}
});

group("describe", () => {
	test("defaults say nothing", () => {
		expect(describe(DEFAULT_FILTERS)).toBe("");
	});

	test("every active filter, in a fixed order", () => {
		const filters: Filters = {
			people: { role: "author", who: "me" },
			state: "merged",
			draft: "hide",
			pipeline: "failed",
		};
		expect(describe(filters)).toBe(
			"author @me · merged · no drafts · pipeline failed",
		);
		expect(
			describe({
				...DEFAULT_FILTERS,
				people: { role: "reviewer", who: "andr" },
				draft: "only",
				pipeline: "none",
			}),
		).toBe("review @andr · drafts only · no pipeline");
		expect(
			describe({
				...DEFAULT_FILTERS,
				state: "all",
				people: { role: "assignee", who: "me" },
			}),
		).toBe("assigned @me · any state");
	});
});

group("people in the dropdown", () => {
	test("round-trips", () => {
		for (const people of [
			null,
			{ role: "author", who: "me" },
			{ role: "reviewer", who: "some.one" },
		] as const) {
			expect(decodePeople(encodePeople(people))).toEqual(people);
		}
		expect(encodePeople(null)).toBe("any");
		expect(encodePeople({ role: "assignee", who: "me" })).toBe("assignee:me");
	});

	test("garbage decodes to nobody", () => {
		expect(decodePeople("owner:me")).toBeNull();
		expect(decodePeople("author:")).toBeNull();
		expect(decodePeople("")).toBeNull();
	});
});
