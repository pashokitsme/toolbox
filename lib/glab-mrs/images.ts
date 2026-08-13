// Inline image support: fetch the bytes, work out how many cells they should
// occupy and emit them in whatever graphics protocol the terminal speaks.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Protocol = "kitty" | "iterm" | "none";

export function detectProtocol(): Protocol {
	if (process.env.GLAB_MRS_IMAGES === "off") return "none";
	const forced = process.env.GLAB_MRS_IMAGE_PROTOCOL as Protocol | undefined;
	if (forced === "kitty" || forced === "iterm" || forced === "none") return forced;

	const term = (process.env.TERM ?? "").toLowerCase();
	const prog = (process.env.TERM_PROGRAM ?? "").toLowerCase();

	if (process.env.KITTY_WINDOW_ID || term.includes("kitty")) return "kitty";
	if (prog === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) return "kitty";
	if (prog === "wezterm" || process.env.WEZTERM_PANE) return "kitty";
	if (prog === "iterm.app" || process.env.ITERM_SESSION_ID) return "iterm";
	return "none";
}

export type ImageData = {
	bytes: Uint8Array;
	mime: string;
	pixelWidth: number;
	pixelHeight: number;
};

const cache = new Map<string, ImageData | null>();

function pngSize(b: Uint8Array): [number, number] | null {
	if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return [view.getUint32(16), view.getUint32(20)];
}

function gifSize(b: Uint8Array): [number, number] | null {
	if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return [view.getUint16(6, true), view.getUint16(8, true)];
}

function jpegSize(b: Uint8Array): [number, number] | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) {
			i += 1;
			continue;
		}
		const marker = b[i + 1] as number;
		const len = view.getUint16(i + 2);
		// SOF0..SOF15, skipping the non-frame markers in that range
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return [view.getUint16(i + 7), view.getUint16(i + 5)];
		}
		i += 2 + len;
	}
	return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
	const tag = new TextDecoder().decode(b.slice(0, 4));
	if (tag !== "RIFF" || b.length < 30) return null;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const fmt = new TextDecoder().decode(b.slice(12, 16));
	if (fmt === "VP8X") return [(view.getUint32(24, true) & 0xffffff) + 1, (view.getUint32(27, true) & 0xffffff) + 1];
	if (fmt === "VP8L") {
		const bits = view.getUint32(21, true);
		return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
	}
	if (fmt === "VP8 ") return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
	return null;
}

function sniff(bytes: Uint8Array): { mime: string; size: [number, number] | null } {
	const png = pngSize(bytes);
	if (png) return { mime: "image/png", size: png };
	const jpeg = jpegSize(bytes);
	if (jpeg) return { mime: "image/jpeg", size: jpeg };
	const gif = gifSize(bytes);
	if (gif) return { mime: "image/gif", size: gif };
	const webp = webpSize(bytes);
	if (webp) return { mime: "image/webp", size: webp };
	return { mime: "application/octet-stream", size: null };
}

/** Fetches an image, sending the GitLab token along for same-host uploads. */
export async function loadImage(url: string, opts: { host?: string; token?: string } = {}): Promise<ImageData | null> {
	const cached = cache.get(url);
	if (cached !== undefined) return cached;

	let data: ImageData | null = null;
	try {
		const headers: Record<string, string> = {};
		if (opts.token && opts.host && new URL(url).host === opts.host) {
			headers["PRIVATE-TOKEN"] = opts.token;
		}
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
		if (res.ok) {
			const bytes = new Uint8Array(await res.arrayBuffer());
			const { mime, size } = sniff(bytes);
			if (size) data = { bytes, mime, pixelWidth: size[0], pixelHeight: size[1] };
		}
	} catch {
		data = null;
	}

	cache.set(url, data);
	return data;
}

/** Cells the image will take, assuming a cell is roughly twice as tall as wide. */
export function imageCells(img: ImageData, maxCols: number, maxRows = 20): [number, number] {
	const cols = Math.max(4, Math.min(maxCols, Math.ceil(img.pixelWidth / 10)));
	const ratio = img.pixelHeight / Math.max(1, img.pixelWidth);
	let rows = Math.max(1, Math.round((cols * ratio) / 2));
	let fitted = cols;
	if (rows > maxRows) {
		fitted = Math.max(4, Math.round((maxRows * 2) / ratio));
		rows = maxRows;
	}
	return [Math.min(fitted, maxCols), rows];
}

function toPng(img: ImageData): Uint8Array | null {
	if (img.mime === "image/png") return img.bytes;
	// macOS ships sips; kitty only takes PNG or raw pixels
	const src = join(tmpdir(), `glab-mrs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const dst = `${src}.png`;
	try {
		writeFileSync(src, img.bytes);
		const out = Bun.spawnSync(["sips", "-s", "format", "png", src, "--out", dst]);
		if (out.exitCode !== 0) return null;
		return new Uint8Array(readFileSync(dst));
	} catch {
		return null;
	} finally {
		for (const f of [src, dst]) {
			try {
				unlinkSync(f);
			} catch {}
		}
	}
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Escape blob that draws the image at the cursor, sized to cols × rows cells. */
export function renderImage(img: ImageData, protocol: Protocol, cols: number, rows: number): string | null {
	if (protocol === "iterm") {
		const payload = b64(img.bytes);
		return `\x1b]1337;File=inline=1;width=${cols};height=${rows};preserveAspectRatio=1:${payload}\x07`;
	}

	if (protocol === "kitty") {
		const png = toPng(img);
		if (!png || png.length === 0) return null;
		const payload = b64(png);
		const CHUNK = 4096;
		let out = "";
		for (let i = 0; i < payload.length; i += CHUNK) {
			const chunk = payload.slice(i, i + CHUNK);
			const more = i + CHUNK < payload.length ? 1 : 0;
			const head = i === 0 ? `a=T,f=100,t=d,c=${cols},r=${rows},C=1,m=${more}` : `m=${more}`;
			out += `\x1b_G${head};${chunk}\x1b\\`;
		}
		return out;
	}

	return null;
}

/** Kitty keeps images on their own layer — they must be dropped before a repaint. */
export const clearImages = (protocol: Protocol): string => (protocol === "kitty" ? "\x1b_Ga=d,d=A\x1b\\" : "");
