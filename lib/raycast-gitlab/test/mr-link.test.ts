import { expect, test } from "bun:test";
import type { Host } from "../src/glab-config";
import { parseMergeRequestLink } from "../src/mr-link";

const host = (name: string, webUrl = `https://${name}`): Host => ({
	host: name,
	apiUrl: webUrl,
	webUrl,
	token: "t",
});
const WORK = host("gitlab.work.example");
const SUB = host("code.example.org", "https://code.example.org/gitlab");
const HOSTS = [WORK, SUB];

test("a merge request link names its host, project and number", () => {
	expect(
		parseMergeRequestLink("https://gitlab.work.example/group/sub/project/-/merge_requests/3964", HOSTS),
	).toEqual({ kind: "known", host: WORK, fullPath: "group/sub/project", iid: "3964" });
});

test("whatever follows the number is ignored, and so is space around the link", () => {
	for (const text of [
		"  https://gitlab.work.example/g/p/-/merge_requests/12/diffs#note_345 \n",
		"https://gitlab.work.example/g/p/-/merge_requests/12?tab=pipelines",
		"gitlab.work.example/g/p/-/merge_requests/12",
		"http://gitlab.work.example/g/p/-/merge_requests/12/",
	]) {
		expect(parseMergeRequestLink(text, HOSTS)).toMatchObject({ kind: "known", fullPath: "g/p", iid: "12" });
	}
});

test("a host under a subfolder keeps the subfolder out of the project path", () => {
	expect(parseMergeRequestLink("https://code.example.org/gitlab/team/app/-/merge_requests/7", HOSTS)).toEqual({
		kind: "known",
		host: SUB,
		fullPath: "team/app",
		iid: "7",
	});
});

test("an escaped project path is read back", () => {
	expect(parseMergeRequestLink("https://gitlab.work.example/g/my%20project/-/merge_requests/1", HOSTS)).toMatchObject({
		fullPath: "g/my project",
	});
});

test("a merge request on a host without a token says which host", () => {
	expect(parseMergeRequestLink("https://gitlab.com/org/repo/-/merge_requests/5", HOSTS)).toEqual({
		kind: "unknown",
		hostName: "gitlab.com",
	});
});

test("anything that is not a merge request link is not one", () => {
	for (const text of [
		"",
		"gram",
		"fix: login",
		"https://gitlab.work.example/g/p",
		"https://gitlab.work.example/g/p/-/issues/3",
		"https://gitlab.work.example/g/p/-/merge_requests/new",
		"https://gitlab.work.example/-/merge_requests/3",
		"see https://gitlab.work.example/g/p/-/merge_requests/3",
	]) {
		expect(parseMergeRequestLink(text, HOSTS)).toBeNull();
	}
});
