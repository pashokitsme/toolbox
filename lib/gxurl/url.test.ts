import { describe, expect, test } from "bun:test";
import { convert, enterpriseOrigin, LinkError, toEnterprise, toPath } from "./url.ts";

const ENT = "https://app-acme.gram.ax";
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

describe("enterpriseOrigin", () => {
	test("an address, with or without scheme or slash", () => {
		expect(enterpriseOrigin(`${ENT}/`)).toBe(ENT);
		expect(enterpriseOrigin("app-acme.gram.ax")).toBe(ENT);
	});
	test("unset, a path or another scheme is an error", () => {
		expect(() => enterpriseOrigin(undefined)).toThrow(/not set/);
		expect(() => enterpriseOrigin("  ")).toThrow(/not set/);
		expect(() => enterpriseOrigin(`${ENT}/x`)).toThrow(/no path/);
		expect(() => enterpriseOrigin("ftp://x.ru")).toThrow(/http/);
	});
	test("-p does not need it", () => {
		expect(convert(LONG, "path", undefined)).toBe("guides/install");
		expect(() => convert(LONG, "enterprise", undefined)).toThrow(/GXURL_ENTERPRISE_URL/);
	});
});
