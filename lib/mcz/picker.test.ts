import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, matchesFilter } from "./picker.ts";

describe("listDirectory", () => {
	test("parent, directories, then files, in natural order", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcz-list-"));
		for (const name of ["beach10.jpg", "Beach2.jpg", "notes.txt", "clip.MOV"])
			writeFileSync(join(dir, name), "x");
		mkdirSync(join(dir, "b-dir"));
		mkdirSync(join(dir, "A-dir"));
		symlinkSync(join(dir, "A-dir"), join(dir, "z-link"));
		symlinkSync(join(dir, "missing"), join(dir, "broken"));

		const rows = listDirectory(dir).map(
			(e) => `${e.kind}:${e.name}:${e.media ?? "-"}`,
		);
		expect(rows).toEqual([
			"parent:..:-",
			"dir:A-dir:-",
			"dir:b-dir:-",
			"dir:z-link:-",
			"file:Beach2.jpg:img",
			"file:beach10.jpg:img",
			"file:broken:-",
			"file:clip.MOV:vid",
			"file:notes.txt:-",
		]);
	});

	test("no parent at the root", () => {
		expect(listDirectory("/")[0]?.kind).not.toBe("parent");
	});
});

describe("matchesFilter", () => {
	test("every word, any case, any order", () => {
		expect(matchesFilter("IMG_2024_Beach.JPG", "beach 2024")).toBe(true);
		expect(matchesFilter("IMG_2024_Beach.JPG", "beach 2023")).toBe(false);
		expect(matchesFilter("anything", "  ")).toBe(true);
	});

	test("decomposed Cyrillic names match composed input", () => {
		expect(matchesFilter("Отпуск на море".normalize("NFD"), "отпуск")).toBe(
			true,
		);
		expect(matchesFilter("йод.jpg".normalize("NFD"), "йод")).toBe(true);
	});
});
