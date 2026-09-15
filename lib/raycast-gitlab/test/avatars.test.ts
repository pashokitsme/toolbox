import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cornerColor,
	fitScale,
	ICON_SIZE,
	type MakeIcon,
	projectAvatarFile,
	readBmp,
	sipsIcon,
	type FetchBytes,
} from "../src/avatars";
import type { Host } from "../src/glab-config";

const HOST: Host = {
	host: "gitlab.example.com",
	apiUrl: "https://gitlab.example.com",
	webUrl: "https://gitlab.example.com",
	token: "t0k",
};

function server(status: number, body = "image-bytes") {
	const calls: { url: string; auth?: string }[] = [];
	const fetchImpl: FetchBytes = async (url, init) => {
		calls.push({ url, auth: init.headers.Authorization });
		return {
			ok: status >= 200 && status < 300,
			status,
			arrayBuffer: async () =>
				new TextEncoder().encode(body).buffer as ArrayBuffer,
		};
	};
	return { calls, fetchImpl };
}

/** Stands in for sips: records what it was given, writes a marker. */
function iconMaker() {
	const sources: string[] = [];
	const makeIcon: MakeIcon = async (source, target) => {
		sources.push(await readFile(source, "utf8"));
		await writeFile(target, "icon-bytes");
	};
	return { sources, makeIcon };
}

const project = (avatarUrl?: string) => ({
	fullPath: "group/sub project",
	avatarUrl,
});

const PNG =
	"https://gitlab.example.com/uploads/-/system/project/avatar/1/logo.png";
const ICO =
	"https://gitlab.example.com/uploads/-/system/project/avatar/155/icon.ico";

test("downloads through the API with the token, since uploads want a browser session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "avatars-"));
	const { calls, fetchImpl } = server(200);
	const { sources, makeIcon } = iconMaker();
	const file = await projectAvatarFile(
		HOST,
		project(PNG),
		dir,
		fetchImpl,
		makeIcon,
	);
	expect(calls).toEqual([
		{
			url: "https://gitlab.example.com/api/v4/projects/group%2Fsub%20project/avatar",
			auth: "Bearer t0k",
		},
	]);
	expect(sources).toEqual(["image-bytes"]);
	expect(file?.startsWith(dir)).toBe(true);
	expect(file?.endsWith(".png")).toBe(true);
	expect(await readFile(file ?? "", "utf8")).toBe("icon-bytes");
});

test("every format becomes an icon, and the download is not left behind", async () => {
	for (const url of [PNG, ICO, "https://gitlab.example.com/a.jpg"]) {
		const dir = await mkdtemp(join(tmpdir(), "avatars-"));
		const { sources, makeIcon } = iconMaker();
		const file = await projectAvatarFile(
			HOST,
			project(url),
			dir,
			server(200).fetchImpl,
			makeIcon,
		);
		expect(sources).toHaveLength(1);
		expect(file?.endsWith(".png")).toBe(true);
		expect(await readdir(dir)).toHaveLength(1);
	}
});

test("a second call is served from disk", async () => {
	const dir = await mkdtemp(join(tmpdir(), "avatars-"));
	const first = await projectAvatarFile(
		HOST,
		project(ICO),
		dir,
		server(200).fetchImpl,
		iconMaker().makeIcon,
	);
	const again = server(200);
	const maker = iconMaker();
	expect(
		await projectAvatarFile(
			HOST,
			project(ICO),
			dir,
			again.fetchImpl,
			maker.makeIcon,
		),
	).toBe(first);
	expect(again.calls).toHaveLength(0);
	expect(maker.sources).toHaveLength(0);
});

test("no avatar, a failed download or a failed conversion gives nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "avatars-"));
	const { calls, fetchImpl } = server(404);
	expect(
		await projectAvatarFile(HOST, project(undefined), dir, fetchImpl),
	).toBeUndefined();
	expect(calls).toHaveLength(0);
	expect(
		await projectAvatarFile(HOST, project(PNG), dir, fetchImpl),
	).toBeUndefined();
	const broken = await projectAvatarFile(
		HOST,
		project(ICO),
		dir,
		server(200).fetchImpl,
		async () => {
			throw new Error("sips failed");
		},
	);
	expect(broken).toBeUndefined();
	expect(await readdir(dir)).toHaveLength(0);
});

type Rgba = [number, number, number, number];

/** A 32-bit BMP of `width`×`height` whose pixels come from `paint`. */
function bmp(
	width: number,
	height: number,
	paint: (x: number, y: number) => Rgba,
	options: { topDown: boolean; bitfields: boolean },
) {
	const header = options.bitfields ? 56 : 40;
	const offset = 14 + header;
	const bytes = new Uint8Array(offset + width * height * 4);
	const view = new DataView(bytes.buffer);
	bytes.set([0x42, 0x4d]);
	view.setUint32(10, offset, true);
	view.setUint32(14, header, true);
	view.setInt32(18, width, true);
	view.setInt32(22, options.topDown ? -height : height, true);
	view.setUint16(28, 32, true);
	view.setUint32(30, options.bitfields ? 3 : 0, true);
	if (options.bitfields) {
		view.setUint32(54, 0x00ff0000, true);
		view.setUint32(58, 0x0000ff00, true);
		view.setUint32(62, 0x000000ff, true);
		view.setUint32(66, 0xff000000, true);
	}
	for (let y = 0; y < height; y += 1) {
		const row = options.topDown ? y : height - 1 - y;
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a] = paint(x, y);
			view.setUint32(offset + (row * width + x) * 4, ((a << 24) | (r << 16) | (g << 8) | b) >>> 0, true);
		}
	}
	return bytes;
}

const TOP_DOWN = { topDown: true, bitfields: true };

test("readBmp reads pixels in place for either row order", () => {
	const paint = (x: number, y: number): Rgba => [x * 10, y * 10, 7, 255];
	for (const options of [TOP_DOWN, { topDown: false, bitfields: false }]) {
		const image = readBmp(bmp(3, 2, paint, options));
		expect(image?.width).toBe(3);
		expect(image?.height).toBe(2);
		expect(image?.rgba(2, 1)).toEqual([20, 10, 7, 255]);
		expect(image?.rgba(0, 0)).toEqual([0, 0, 7, 255]);
	}
});

test("cornerColor is the top-left pixel, or null when it is see-through", () => {
	const solid = (rgba: Rgba) => readBmp(bmp(2, 2, () => rgba, TOP_DOWN));
	expect(cornerColor(solid([18, 19, 21, 255]))).toBe("121315");
	expect(cornerColor(solid([10, 10, 10, 0]))).toBeNull();
});

describe("fitScale", () => {
	const DARK: Rgba = [18, 19, 21, 255];
	const WHITE: Rgba = [255, 255, 255, 255];
	const CLEAR: Rgba = [0, 0, 0, 0];
	// 20×20, content where `inside` says so
	const image = (ground: Rgba, inside: (x: number, y: number) => boolean) =>
		readBmp(bmp(20, 20, (x, y) => (inside(x, y) ? WHITE : ground), TOP_DOWN));

	test("content that already fits the circle keeps its full size", () => {
		expect(fitScale(image(DARK, (x, y) => x >= 6 && x < 14 && y >= 6 && y < 14))).toBe(1);
		// touching the middle of an edge is still inside the circle
		expect(fitScale(image(DARK, (x, y) => x === 0 && y === 10))).toBe(1);
	});

	test("content near a corner shrinks the image just enough to bring it inside", () => {
		// the middle of pixel (1,1) is 8.5·√2 from the center, the circle's radius is 10
		expect(fitScale(image(DARK, (x, y) => x === 1 && y === 1))).toBeCloseTo(10 / (8.5 * Math.SQRT2), 5);
	});

	test("on a transparent ground anything visible is content", () => {
		expect(fitScale(image(CLEAR, (x, y) => x === 1 && y === 1))).toBeCloseTo(10 / (8.5 * Math.SQRT2), 5);
	});

	test("an image all of one color has nothing to fit", () => {
		expect(fitScale(image(DARK, () => false))).toBe(1);
	});
});

const sips = (...args: string[]) => execFileSync("/usr/bin/sips", args, { encoding: "utf8" });
const FOLDER = "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns";

async function probe(png: string) {
	const file = `${png}.bmp`;
	sips("-s", "format", "bmp", png, "--out", file);
	return readBmp(new Uint8Array(await readFile(file)));
}

test(`sips makes a ${ICON_SIZE}px icon, shrunk into the circle and filled with its own corner color`, async () => {
	const dir = await mkdtemp(join(tmpdir(), "avatars-"));
	// a logo that runs into the corners, on a red ground
	const source = join(dir, "logo.png");
	sips("-s", "format", "png", "-z", "240", "240", "--padToHeightWidth", "256", "256", "--padColor", "FF0000", FOLDER, "--out", source);
	const target = join(dir, "icon.png");
	await sipsIcon(source, target);
	const icon = await probe(target);
	expect([icon?.width, icon?.height]).toEqual([ICON_SIZE, ICON_SIZE]);
	expect(cornerColor(icon)).toBe("FF0000");
	// shrunk: what is left over the red ground now fits the circle
	expect(fitScale(icon)).toBeGreaterThan(0.97);
	expect(fitScale(await probe(source))).toBeLessThan(0.95);
	expect(sips("-g", "format", target)).toContain("format: png");
});

test("a transparent image is shrunk the same way and stays transparent around", async () => {
	const dir = await mkdtemp(join(tmpdir(), "avatars-"));
	const source = join(dir, "folder.png");
	sips("-s", "format", "png", "-z", "256", "256", FOLDER, "--out", source);
	const target = join(dir, "icon.png");
	await sipsIcon(source, target);
	const icon = await probe(target);
	expect(icon?.width).toBe(ICON_SIZE);
	expect(cornerColor(icon)).toBeNull();
	expect(fitScale(icon)).toBeGreaterThan(0.97);
});
