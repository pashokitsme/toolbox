import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHosts, parseGlabConfig } from "../src/glab-config";

// the shape glab 1.114 writes, tokens replaced
const CONFIG = `
git_protocol: ssh
host: gitlab.com
hosts:
    gitlab.com:
        api_protocol: https
        api_host: gitlab.com
        subfolder:
        token:
    gitlab.work.example:
        token: glpat-secret
        api_host: gitlab.work.example
        git_protocol: https
        api_protocol: https
        user: someone
    code.example.org:
        token: glpat-other
        subfolder: /gitlab/
`;

describe("parseGlabConfig", () => {
	test("keeps only hosts with a token", () => {
		expect(parseGlabConfig(CONFIG).map((h) => h.host)).toEqual([
			"gitlab.work.example",
			"code.example.org",
		]);
	});

	test("builds api and web urls", () => {
		expect(parseGlabConfig(CONFIG)[0]).toEqual({
			host: "gitlab.work.example",
			apiUrl: "https://gitlab.work.example",
			webUrl: "https://gitlab.work.example",
			token: "glpat-secret",
		});
	});

	test("defaults api_host to the host name and api_protocol to https, and honours subfolder", () => {
		expect(parseGlabConfig(CONFIG)[1]).toEqual({
			host: "code.example.org",
			apiUrl: "https://code.example.org/gitlab",
			webUrl: "https://code.example.org/gitlab",
			token: "glpat-other",
		});
	});

	test("empty or hostless config gives no hosts", () => {
		expect(parseGlabConfig("")).toEqual([]);
		expect(parseGlabConfig("host: gitlab.com\n")).toEqual([]);
	});
});

describe("loadHosts", () => {
	test("reads the first path that exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "glab-config-"));
		const path = join(dir, "config.yml");
		await writeFile(path, CONFIG);
		const hosts = await loadHosts([join(dir, "missing.yml"), path]);
		expect(hosts.map((h) => h.host)).toEqual([
			"gitlab.work.example",
			"code.example.org",
		]);
	});

	test("no config file at all gives no hosts", async () => {
		expect(
			await loadHosts([join(tmpdir(), "definitely-missing-glab.yml")]),
		).toEqual([]);
	});
});
