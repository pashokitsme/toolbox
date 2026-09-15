// Project avatars. GitLab serves the avatar url only to a browser session — a
// token gets 401 there — so the image is fetched through the API instead and
// kept on disk as a small png, where Raycast can draw it. Every format goes
// through macOS's own sips: GitLab lets projects use .ico and .svg, and a
// 256px avatar is far more than a list row shows.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { Host } from "./glab-config";

// pixels: a list row draws the icon at 23pt, twice that on a Retina screen
export const ICON_SIZE = 46;

export type FetchBytes = (
	url: string,
	init: { headers: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type MakeIcon = (source: string, target: string) => Promise<void>;

export type Bitmap = {
	width: number;
	height: number;
	rgba(x: number, y: number): [number, number, number, number];
};

/** A 32-bit BMP as pixels. sips cannot report a pixel, but it can write a
 *  BMP, and that is plain bytes. */
export function readBmp(bytes: Uint8Array): Bitmap | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(28, true) !== 32) return null;
	const offset = view.getUint32(10, true);
	const headerSize = view.getUint32(14, true);
	const width = Math.abs(view.getInt32(18, true));
	const rawHeight = view.getInt32(22, true);
	const height = Math.abs(rawHeight);
	const bitfields = view.getUint32(30, true) === 3;
	const [red, green, blue] = bitfields
		? [54, 58, 62].map((at) => view.getUint32(at, true))
		: [0x00ff0000, 0x0000ff00, 0x000000ff];
	// only a header past the basic 40 bytes carries an alpha mask; without
	// one the fourth byte is padding and every pixel is opaque
	const alpha = headerSize >= 56 ? view.getUint32(66, true) : 0;
	const channel = (pixel: number, mask: number) =>
		(pixel & mask) >>> (31 - Math.clz32(mask & -mask));
	return {
		width,
		height,
		rgba(x, y) {
			// rows run bottom-up unless the height is negative
			const row = rawHeight < 0 ? y : height - 1 - y;
			const pixel = view.getUint32(offset + (row * width + x) * 4, true);
			return [
				channel(pixel, red),
				channel(pixel, green),
				channel(pixel, blue),
				alpha ? channel(pixel, alpha) : 255,
			];
		},
	};
}

const seeThrough = (rgba: [number, number, number, number]) => rgba[3] < 128;

/** The top-left pixel as RRGGBB, or null when it is see-through. */
export function cornerColor(image: Bitmap | null): string | null {
	if (!image) return null;
	const corner = image.rgba(0, 0);
	if (seeThrough(corner)) return null;
	return corner
		.slice(0, 3)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}

/** How much the image has to shrink for everything that is not its ground —
 *  the corner's color, or transparency — to fall inside the circle Raycast
 *  masks an icon with. 1 when it already fits. */
export function fitScale(image: Bitmap | null): number {
	if (!image) return 1;
	const ground = image.rgba(0, 0);
	const groundClear = seeThrough(ground);
	const isGround = (rgba: [number, number, number, number]) =>
		groundClear
			? seeThrough(rgba)
			: !seeThrough(rgba) &&
				rgba.slice(0, 3).every((value, i) => Math.abs(value - (ground[i] ?? 0)) <= 24);
	const centerX = image.width / 2;
	const centerY = image.height / 2;
	let farthest = 0;
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			if (isGround(image.rgba(x, y))) continue;
			// by the pixel's middle: the mask is antialiased, half a pixel is nothing
			farthest = Math.max(
				farthest,
				Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY),
			);
		}
	}
	const radius = Math.min(image.width, image.height) / 2;
	return farthest > radius ? radius / farthest : 1;
}

// absolute path: Raycast starts extensions without the shell's PATH
const sips = (args: string[]) => promisify(execFile)("/usr/bin/sips", args);

/** Shrinks the image only as far as it takes for a logo to clear the circle
 *  mask, and fills the margin with the image's own corner color — or leaves
 *  it transparent when the corner is. */
export const sipsIcon: MakeIcon = async (source, target) => {
	const probe = `${target}.probe.bmp`;
	const work = `${target}.work.png`;
	const size = String(ICON_SIZE);
	try {
		// twice the icon's size: enough detail to find where the logo ends
		const detail = String(ICON_SIZE * 2);
		await sips(["-s", "format", "bmp", "-z", detail, detail, source, "--out", probe]);
		const image = readBmp(new Uint8Array(await readFile(probe)));
		const inner = String(Math.max(1, Math.floor(ICON_SIZE * fitScale(image))));
		await sips(["-s", "format", "png", "-z", inner, inner, source, "--out", work]);
		if (inner !== size) {
			const color = cornerColor(image);
			await sips([
				"--padToHeightWidth",
				size,
				size,
				...(color ? ["--padColor", color] : []),
				work,
				"--out",
				work,
			]);
		}
		await rename(work, target);
	} finally {
		await unlink(probe).catch(() => {});
		await unlink(work).catch(() => {});
	}
};

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

export async function projectAvatarFile(
	host: Host,
	project: { fullPath: string; avatarUrl?: string },
	dir: string,
	fetchImpl: FetchBytes = fetch,
	makeIcon: MakeIcon = sipsIcon,
): Promise<string | undefined> {
	if (!project.avatarUrl) return undefined;
	// the url changes with the image, so it and the size name the file and
	// nothing goes stale
	const key = createHash("sha1")
		.update(`${host.host} ${project.avatarUrl} ${ICON_SIZE}`)
		.digest("hex");
	const target = join(dir, `${key}.png`);
	if (await exists(target)) return target;

	const response = await fetchImpl(
		`${host.apiUrl}/api/v4/projects/${encodeURIComponent(project.fullPath)}/avatar`,
		{ headers: { Authorization: `Bearer ${host.token}` } },
	);
	if (!response.ok) return undefined;

	await mkdir(dir, { recursive: true });
	// sips reads the format from the extension as well as from the bytes
	const extension = extname(new URL(project.avatarUrl).pathname).toLowerCase();
	const download = join(dir, `${key}.download${extension}`);
	await writeFile(download, new Uint8Array(await response.arrayBuffer()));
	try {
		await makeIcon(download, target);
		return target;
	} catch {
		return undefined;
	} finally {
		await unlink(download).catch(() => {});
	}
}
