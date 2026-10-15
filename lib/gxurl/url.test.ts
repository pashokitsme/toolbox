import { describe, expect, test } from "bun:test";
import {
	appOrigin,
	convert,
	LinkError,
	sameLink,
	storageHost,
	toEnterprise,
	toPath,
	toRegular,
} from "./url.ts";

const ENT = "https://app-acme.gram.ax";
const APP = "https://app.gram.ax";
const STORAGE = "gitlab.example.com";
const LONG =
	"https://app.gram.ax/gitlab.example.com/docs/handbook/master/-/guides/install";
const SHORT = `${ENT}/docs/handbook/master/-/guides/install`;

describe("toEnterprise", () => {
	test("drops the storage segment", () => {
		expect(toEnterprise(LONG, ENT)).toBe(SHORT);
	});
	test("keeps the heading and the query", () => {
		expect(toEnterprise(`${LONG}?view=1#step-2`, ENT)).toBe(`${SHORT}?view=1#step-2`);
	});
	test("keeps encoded group and branch as they are", () => {
		expect(
			toEnterprise("https://app.gram.ax/gitlab.example.com/dr%2Fsub/repo/feature%2Fx/-/a", ENT),
		).toBe(`${ENT}/dr%2Fsub/repo/feature%2Fx/-/a`);
	});
	test("a named catalog slot and a catalog link convert too", () => {
		expect(toEnterprise("https://app.gram.ax/g.ru/dr/repo/master/docs/a/b", ENT)).toBe(
			`${ENT}/dr/repo/master/docs/a/b`,
		);
		expect(toEnterprise("https://app.gram.ax/g.ru/dr/repo/master/-", ENT)).toBe(
			`${ENT}/dr/repo/master/-`,
		);
	});
	test("keeps public/ in front", () => {
		expect(toEnterprise("https://app.gram.ax/public/g.ru/dr/repo/master/-/a", ENT)).toBe(
			`${ENT}/public/dr/repo/master/-/a`,
		);
	});
	test("a link already short only changes its address", () => {
		expect(toEnterprise(SHORT, ENT)).toBe(SHORT);
		expect(toEnterprise("http://localhost:5173/dr/repo/master/-/a", ENT)).toBe(
			`${ENT}/dr/repo/master/-/a`,
		);
	});
	test("no scheme is https", () => {
		expect(toEnterprise(LONG.replace("https://", ""), ENT)).toBe(SHORT);
	});
	test("a link that is not a catalog is an error", () => {
		expect(() => toEnterprise("https://app.gram.ax/", ENT)).toThrow(LinkError);
		expect(() => toEnterprise("https://app.gram.ax/g.ru/dr/repo/master", ENT)).toThrow(LinkError);
		expect(() => toEnterprise("not a link at all", ENT)).toThrow(LinkError);
		expect(() => toEnterprise("ftp://app.gram.ax/g.ru/dr/repo/master/-/a", ENT)).toThrow(LinkError);
	});
});

describe("toPath", () => {
	test("the article after the catalog slot", () => {
		expect(toPath(LONG)).toBe("guides/install");
		expect(toPath(SHORT)).toBe("guides/install");
	});
	test("decoded, without heading or query", () => {
		expect(
			toPath("https://app.gram.ax/g.ru/dr/repo/master/-/%D0%B4%D0%BE%D0%BA/my%20page?x=1#h"),
		).toBe("док/my page");
	});
	test("a named catalog slot is skipped like the dash", () => {
		expect(toPath("https://app.gram.ax/g.ru/dr/repo/master/docs/a/b")).toBe("a/b");
	});
	test("a catalog link has no path", () => {
		expect(() => toPath("https://app.gram.ax/g.ru/dr/repo/master/-")).toThrow(/catalog/);
		expect(() => toPath(`${ENT}/dr/repo/master/-/`)).toThrow(/catalog/);
	});
	test("a broken escape stays as it is", () => {
		expect(toPath("https://app.gram.ax/g.ru/dr/repo/master/-/100%25/a%E0")).toBe("100%/a%E0");
	});
});

describe("toEnterprise with the storage known", () => {
	test("its own storage converts, case aside", () => {
		expect(toEnterprise(LONG, ENT, "GitLab.Example.com")).toBe(SHORT);
	});
	test("another storage is an error", () => {
		expect(() =>
			toEnterprise("https://app.gram.ax/github.com/docs/handbook/master/-/a", ENT, STORAGE),
		).toThrow(/from github.com.*serves gitlab.example.com/);
	});
	test("a storage with a port is compared decoded", () => {
		expect(
			toEnterprise("https://app.gram.ax/git.local%3A3000/g/r/main/-/a", ENT, "git.local:3000"),
		).toBe(`${ENT}/g/r/main/-/a`);
	});
	test("a dash in the storage slot is the enterprise app's own long form", () => {
		expect(toEnterprise(`${ENT}/-/docs/handbook/master/-/guides/install`, ENT, STORAGE)).toBe(SHORT);
	});
});

describe("toRegular", () => {
	test("a short link gets its storage back", () => {
		expect(toRegular(`${SHORT}?view=1#step-2`, APP, STORAGE)).toBe(`${LONG}?view=1#step-2`);
	});
	test("round trip with -e", () => {
		expect(toRegular(toEnterprise(LONG, ENT), APP, STORAGE)).toBe(LONG);
	});
	test("keeps public/ in front", () => {
		expect(toRegular(`${ENT}/public/g/r/main/-/a`, APP, STORAGE)).toBe(
			`${APP}/public/${STORAGE}/g/r/main/-/a`,
		);
	});
	test("a storage with a port is encoded into one segment", () => {
		expect(toRegular(`${ENT}/g/r/main/-/a`, APP, "git.local:3000")).toBe(
			`${APP}/git.local%3A3000/g/r/main/-/a`,
		);
	});
	test("a dash in the storage slot becomes the storage", () => {
		expect(toRegular(`${ENT}/-/docs/handbook/master/-/guides/install`, APP, STORAGE)).toBe(LONG);
	});
	test("a long link keeps its storage, no storage needed", () => {
		expect(toRegular(LONG, APP)).toBe(LONG);
		expect(toRegular("https://other.gram.ax/github.com/g/r/main/-/a", APP)).toBe(
			`${APP}/github.com/g/r/main/-/a`,
		);
	});
	test("a short link without the storage is an error", () => {
		expect(() => toRegular(SHORT, APP)).toThrow(/GXURL_STORAGE/);
	});
});

describe("environment", () => {
	test("an app address, with or without scheme or slash", () => {
		expect(appOrigin("X", `${ENT}/`, "-e")).toBe(ENT);
		expect(appOrigin("X", "app-acme.gram.ax", "-e")).toBe(ENT);
	});
	test("unset, a path or another scheme is an error", () => {
		expect(() => appOrigin("X", undefined, "-e")).toThrow(/X is not set, so -e/);
		expect(() => appOrigin("X", "  ", "-e")).toThrow(/not set/);
		expect(() => appOrigin("X", `${ENT}/x`, "-e")).toThrow(/no path/);
		expect(() => appOrigin("X", "ftp://x.ru", "-e")).toThrow(/http/);
	});
	test("the storage is a host, a URL gives its host", () => {
		expect(storageHost(undefined)).toBeUndefined();
		expect(storageHost(" ")).toBeUndefined();
		expect(storageHost(STORAGE)).toBe(STORAGE);
		expect(storageHost(`https://${STORAGE}/`)).toBe(STORAGE);
		expect(storageHost("git.local:3000")).toBe("git.local:3000");
		expect(() => storageHost(`${STORAGE}/group`)).toThrow(/no path/);
	});
	test("each mode needs only its own variables", () => {
		expect(convert(LONG, "path", {})).toBe("guides/install");
		expect(() => convert(LONG, "enterprise", {})).toThrow(/GXURL_ENTERPRISE_URL/);
		expect(convert(LONG, "regular", {})).toBe(LONG);
		expect(convert(SHORT, "regular", { storage: STORAGE })).toBe(LONG);
		expect(convert(SHORT, "regular", { storage: STORAGE, app: "gx.local:8080" })).toBe(
			LONG.replace("https://app.gram.ax", "https://gx.local:8080"),
		);
	});
});

describe("sameLink", () => {
	test("ignores a trailing slash and a missing scheme", () => {
		expect(sameLink(SHORT, `${SHORT}/`)).toBe(true);
		expect(sameLink(SHORT.replace("https://", ""), SHORT)).toBe(true);
		expect(sameLink(SHORT, LONG)).toBe(false);
		expect(sameLink("guides/install", "x y")).toBe(false);
	});
});
