// One file at a time: what kind of media it is, where its result goes, the
// magick or ffmpeg command that makes it, and running that command into a
// temporary file which becomes the result only once it is whole and smaller.

import {
	closeSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Subprocess } from "bun";
import type { Profile } from "./config.ts";

/** A lookup that only finds the table's own keys — "constructor" is not a format. */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
	Object.hasOwn(table, key) ? table[key] : undefined;

export const IMAGE_EXTS = new Set([
	"jpg",
	"jpeg",
	"png",
	"webp",
	"avif",
	"heic",
	"heif",
	"tif",
	"tiff",
	"gif",
	"bmp",
]);
export const VIDEO_EXTS = new Set([
	"mp4",
	"mov",
	"m4v",
	"mkv",
	"webm",
	"avi",
	"wmv",
	"flv",
	"mpg",
	"mpeg",
	"3gp",
	"ts",
	"mts",
	"m2ts",
]);

export type Kind = "image" | "video";

export const extOf = (path: string): string => extname(path).slice(1);

export function kindByExt(path: string): Kind | null {
	const ext = extOf(path).toLowerCase();
	if (IMAGE_EXTS.has(ext)) return "image";
	if (VIDEO_EXTS.has(ext)) return "video";
	return null;
}

/** The names this tool gives its results: photo.compressed.jpg, photo.compressed-2.jpg. */
export const isCompressedName = (name: string): boolean =>
	/\.compressed(?:-\d+)?\.[^.]+$/i.test(name);

// ---------------------------------------------------------------- formats

/** Image formats by what they are rather than how they are spelled; each name
 *  doubles as the extension a converted file gets. */
export type ImageFormat =
	| "jpg"
	| "png"
	| "webp"
	| "avif"
	| "heic"
	| "tiff"
	| "gif"
	| "bmp";

const FORMAT_OF_EXT: Record<string, ImageFormat> = {
	jpg: "jpg",
	jpeg: "jpg",
	png: "png",
	webp: "webp",
	avif: "avif",
	heic: "heic",
	heif: "heic",
	tif: "tiff",
	tiff: "tiff",
	gif: "gif",
	bmp: "bmp",
};

export const imageFormatOfExt = (ext: string): ImageFormat | undefined =>
	own(FORMAT_OF_EXT, ext.toLowerCase());

const TO_FORMATS: Record<string, ImageFormat> = {
	webp: "webp",
	avif: "avif",
	jpg: "jpg",
	jpeg: "jpg",
	png: "png",
	heic: "heic",
};

/** What --to accepts. */
export const toFormat = (name: string): ImageFormat | undefined =>
	own(TO_FORMATS, name.toLowerCase());

type Family = "h264" | "hevc" | "vp8" | "vp9" | "av1" | "other";
type RateControl = "crf" | "videotoolbox" | "vpx" | "svt";

/** What ffmpeg's encoders need told differently. An encoder missing here gets
 *  -crf and -preset like x264, and ffmpeg's own word if it takes neither. */
const ENCODERS: Record<string, { family: Family; rate: RateControl }> = {
	libx264: { family: "h264", rate: "crf" },
	libx265: { family: "hevc", rate: "crf" },
	h264_videotoolbox: { family: "h264", rate: "videotoolbox" },
	hevc_videotoolbox: { family: "hevc", rate: "videotoolbox" },
	libvpx: { family: "vp8", rate: "vpx" },
	"libvpx-vp9": { family: "vp9", rate: "vpx" },
	"libaom-av1": { family: "av1", rate: "vpx" },
	libsvtav1: { family: "av1", rate: "svt" },
};

const encoder = (codec: string) =>
	own(ENCODERS, codec) ?? { family: "other" as const, rate: "crf" as const };

/** What each container mcz keeps can hold, as ffmpeg's muxers see it: mov
 *  refuses VP9 and AV1, .m4v — ffmpeg's ipod muxer — anything but H.264, mp4
 *  takes no VP8, and only Matroska takes an encoder mcz does not know. */
const HOLDS: Record<string, ReadonlySet<Family>> = {
	mp4: new Set<Family>(["h264", "hevc", "vp9", "av1"]),
	mov: new Set<Family>(["h264", "hevc"]),
	m4v: new Set<Family>(["h264"]),
	mkv: new Set<Family>(["h264", "hevc", "vp8", "vp9", "av1", "other"]),
	webm: new Set<Family>(["vp8", "vp9", "av1"]),
};

/** Where a codec goes when its source's container cannot take it. */
const HOME: Record<Family, string> = {
	h264: "mp4",
	hevc: "mp4",
	av1: "mp4",
	vp8: "webm",
	vp9: "webm",
	other: "mkv",
};

/** The extension a video result gets: the source's own when that container
 *  holds the codec, otherwise the codec's natural home. */
export function videoExt(sourceExt: string, codec: string): string {
	const { family } = encoder(codec);
	return own(HOLDS, sourceExt.toLowerCase())?.has(family)
		? sourceExt
		: HOME[family];
}

/**
 * Why a container named by -o cannot take the codec, or nothing when it can.
 * ffmpeg would find out too, but only after opening everything, and in its own
 * words. An encoder mcz does not know is ffmpeg's to judge: mpeg4 goes into .mp4
 * and ProRes into .mov fine.
 */
export function containerRefusal(
	ext: string,
	codec: string,
): string | undefined {
	const { family } = encoder(codec);
	if (family === "other") return undefined;
	if (own(HOLDS, ext.toLowerCase())?.has(family) !== false) return undefined;
	return `${codec} does not fit in .${ext}; .${HOME[family]} does`;
}

/** VideoToolbox has no crf, only a 1–100 quality: crf 23 is q 54, crf 28 is q 44. */
export const videotoolboxQuality = (crf: number): number =>
	Math.min(100, Math.max(1, Math.round(100 - crf * 2)));

// ---------------------------------------------------------------- naming

export type OutputTarget =
	| { kind: "beside" }
	| { kind: "dir"; path: string }
	| { kind: "file"; path: string };

export type FsView = {
	exists(path: string): boolean;
	sameFile(a: string, b: string): boolean;
};

export const realFs: FsView = {
	exists: (path) => {
		try {
			lstatSync(path);
			return true;
		} catch {
			return false;
		}
	},
	sameFile: (a, b) => {
		try {
			const x = statSync(a);
			const y = statSync(b);
			return x.dev === y.dev && x.ino === y.ino;
		} catch {
			return false;
		}
	},
};

/**
 * The absolute path the result of `source` goes to. A taken name gets numbered
 * (-2, -3, …) unless `force` says to overwrite it — but the source itself is
 * never a candidate, whatever spelling or link leads to it. `reserved` holds
 * what earlier files of this run were promised, so two sources that land on the
 * same name — a.jpg from two folders into one -o directory — are numbered even
 * in a dry run, where nothing reaches the disk to notice. Keys are lower-cased
 * because macOS volumes do not tell a.JPG from a.jpg.
 */
export function resolveOutput(
	source: string,
	ext: string,
	target: OutputTarget,
	force: boolean,
	reserved: Set<string>,
	fs: FsView = realFs,
): string {
	let dir: string;
	let nameFor: (n: number) => string;

	if (target.kind === "file") {
		dir = dirname(target.path);
		const file = basename(target.path);
		const fileExt = extname(file);
		const stem = fileExt ? file.slice(0, -fileExt.length) : file;
		nameFor = (n) => (n === 1 ? file : `${stem}-${n}${fileExt}`);
	} else {
		dir = target.kind === "dir" ? target.path : dirname(source);
		const stem = basename(source, extname(source));
		nameFor = (n) => `${stem}.compressed${n === 1 ? "" : `-${n}`}.${ext}`;
	}

	for (let n = 1; ; n += 1) {
		const candidate = join(dir, nameFor(n));
		const key = candidate.toLowerCase();
		if (reserved.has(key) || key === source.toLowerCase()) continue;
		if (fs.exists(candidate) && (!force || fs.sameFile(source, candidate)))
			continue;
		reserved.add(key);
		return candidate;
	}
}

const randomTag = (): string =>
	Math.floor(Math.random() * 36 ** 6)
		.toString(36)
		.padStart(6, "0");

/**
 * A fresh temporary path beside the result: `.mcz-<pid>-<random>.<ext>`. Short,
 * so a result whose name is already near the 255-byte limit still fits; unique,
 * so two runs over the same file never write into one temp file; hidden; and
 * ending in the real extension, which magick and ffmpeg take the format from.
 * It is never a path that exists, so never the source either.
 */
export function tempPathFor(
	output: string,
	fs: Pick<FsView, "exists"> = realFs,
	tag = randomTag,
): string {
	for (;;) {
		const candidate = join(
			dirname(output),
			`.mcz-${process.pid}-${tag()}${extname(output)}`,
		);
		if (!fs.exists(candidate)) return candidate;
	}
}

const removeQuietly = (path: string): void => {
	try {
		unlinkSync(path);
	} catch {
		// already gone, or never written
	}
};

/** Removes a temp file along with the numbered siblings magick writes instead
 *  when it has more frames than the format holds (.mcz-1-abc123-0.jpg, -1, …). */
export function removeTemp(temp: string): void {
	removeQuietly(temp);
	const dir = dirname(temp);
	const ext = extname(temp);
	const prefix = `${basename(temp, ext)}-`;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
		if (/^\d+$/.test(name.slice(prefix.length, name.length - ext.length)))
			removeQuietly(join(dir, name));
	}
}

const errorCode = (err: unknown): string | undefined =>
	(err as NodeJS.ErrnoException).code;

/**
 * Moves a finished temp file onto the result's name and returns the name it
 * ended up under. With `force` that is a rename, which replaces what is there.
 * Without it the name has to still be free — a long encode leaves time for
 * something else to take it — so the file is hard-linked into place, which fails
 * rather than replaces, and `nextName` gives the next free name when it does.
 * A volume without hard links (exFAT, some network shares) gets an exclusively
 * created placeholder that the rename then replaces.
 */
export function placeResult(
	temp: string,
	output: string,
	force: boolean,
	nextName: () => string,
): string {
	if (force) {
		renameSync(temp, output);
		return output;
	}
	let name = output;
	let links = true;
	for (;;) {
		try {
			if (links) linkSync(temp, name);
			else closeSync(openSync(name, "wx"));
		} catch (err) {
			const code = errorCode(err);
			if (code === "EEXIST") {
				name = nextName();
			} else if (links && code !== "ENOENT") {
				links = false;
			} else {
				throw err;
			}
			continue;
		}
		if (links) {
			removeQuietly(temp);
			return name;
		}
		try {
			renameSync(temp, name);
			return name;
		} catch (err) {
			// the placeholder made the name ours, so a failure here is not a taken
			// name: renumbering would only strew empty placeholders
			removeQuietly(name);
			throw err;
		}
	}
}

// ---------------------------------------------------------------- commands

const LOSSY = new Set<ImageFormat>(["jpg", "webp", "avif", "heic"]);
// sources that may carry more than one picture: animations, multi-page TIFF,
// AVIF and HEIC sequences
const MULTI_FRAME = new Set<ImageFormat>([
	"gif",
	"webp",
	"tiff",
	"avif",
	"heic",
]);
// formats that hold one picture; every other target keeps all frames
const STILL = new Set<ImageFormat>(["jpg", "png", "bmp"]);

export type ImagePlan = {
	input: string;
	output: string;
	source: ImageFormat;
	target: ImageFormat;
	profile: Profile;
};

export function imageArgs({
	input,
	output,
	source,
	target,
	profile,
}: ImagePlan): string[] {
	// filename:literal stops magick from reading %d, [0] and * in a file name as
	// a frame counter, a frame selection or a glob — "100%done.jpg" is a name
	const args = ["magick", "-define", "filename:literal=true", input];

	if (MULTI_FRAME.has(source)) {
		// a still format gets the first frame and nothing else, or magick would
		// write photo-0.jpg, photo-1.jpg, …; a sequence keeps every frame, made
		// whole first so a GIF's partial frames resize and re-encode correctly;
		// TIFF pages are separate pictures, not frames, and are left as they are
		if (STILL.has(target)) args.push("-delete", "1--1");
		else if (target !== "tiff") args.push("-coalesce");
	}

	args.push("-auto-orient", "+profile", "!icc,*", "+set", "comment");
	if (profile.max > 0) args.push("-resize", `${profile.max}x${profile.max}>`);
	if (LOSSY.has(target) && profile.image_blur > 0)
		args.push("-gaussian-blur", String(profile.image_blur));

	const quality = String(profile.image_quality);
	switch (target) {
		case "jpg":
			args.push(
				"-interlace",
				"Plane",
				"-sampling-factor",
				"4:2:0",
				"-quality",
				quality,
			);
			break;
		case "webp":
			args.push("-quality", quality, "-define", "webp:method=6");
			break;
		case "avif":
		case "heic":
			args.push("-quality", quality);
			break;
		case "png":
			// for PNG the digits are zlib level 9 and adaptive filtering — still lossless
			args.push("-quality", "95");
			break;
		case "gif":
			args.push("-layers", "Optimize");
			break;
		case "tiff":
			args.push("-compress", "zip");
			break;
		case "bmp":
			break;
	}

	args.push(output);
	return args;
}

export type VideoProbe = {
	duration: number | null;
	pixFmt: string | null;
	bits: number;
	width: number | null;
	height: number | null;
	hasAudio: boolean;
};

export type VideoPlan = {
	input: string;
	output: string;
	probe: VideoProbe;
	profile: Profile;
};

export function videoArgs({
	input,
	output,
	probe,
	profile,
}: VideoPlan): string[] {
	const codec = profile.video_codec;
	const { family, rate } = encoder(codec);
	const container = extOf(output).toLowerCase();
	const args = [
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-y",
		"-i",
		input,
		"-map",
		"0:v:0",
		"-map",
		"0:a?",
		"-map_metadata",
		"0",
		"-c:v",
		codec,
	];

	const preset = profile.video_preset;
	switch (rate) {
		case "crf":
			args.push("-crf", String(profile.video_crf));
			if (preset) args.push("-preset", preset);
			break;
		case "videotoolbox":
			args.push("-q:v", String(videotoolboxQuality(profile.video_crf)));
			break;
		case "vpx":
			// without -b:v 0 these encoders treat crf as a floor under a bitrate target
			args.push("-b:v", "0", "-crf", String(Math.round(profile.video_crf)));
			break;
		case "svt":
			// SVT-AV1 presets are numbers; "fast" would make ffmpeg refuse to start
			args.push("-crf", String(Math.round(profile.video_crf)));
			if (/^-?\d+$/.test(preset)) args.push("-preset", preset);
			break;
	}

	if (codec === "libx264") args.push("-pix_fmt", "yuv420p");
	else if (codec === "libx265")
		args.push("-pix_fmt", probe.bits > 8 ? "yuv420p10le" : "yuv420p");

	const odd = (probe.width ?? 0) % 2 === 1 || (probe.height ?? 0) % 2 === 1;
	if (profile.max > 0) {
		const n = profile.max;
		// the longest side down to n, the other following with -2; trunc(…/2)*2
		// keeps the limited side even as well, which 4:2:0 encoders insist on
		args.push(
			"-vf",
			`scale='if(gte(iw,ih),trunc(min(${n},iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(${n},ih)/2)*2)'`,
		);
	} else if (odd && (family === "h264" || family === "hevc")) {
		// 4:2:0 H.264 and HEVC need even sizes: x264 and x265 refuse an odd one,
		// VideoToolbox crops it silently. The probe sees the frame before
		// rotation, the filter after it, so the filter rounds whatever it gets.
		args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
	}

	if (probe.hasAudio)
		args.push(
			"-c:a",
			container === "webm" ? "libopus" : "aac",
			"-b:a",
			profile.audio_bitrate,
		);
	if (container === "mp4" || container === "mov" || container === "m4v") {
		args.push("-movflags", "+faststart");
		// Apple players only take HEVC in MP4/MOV under the hvc1 tag
		if (family === "hevc") args.push("-tag:v", "hvc1");
	}

	args.push("-progress", "pipe:1", "-nostats", "-loglevel", "error", output);
	return args;
}

// ---------------------------------------------------------------- probing

type ProbeStream = {
	codec_type?: string;
	codec_name?: string;
	pix_fmt?: string;
	bits_per_raw_sample?: string;
	width?: number;
	height?: number;
	disposition?: { attached_pic?: number };
};

type ProbeDoc = {
	streams?: ProbeStream[];
	format?: {
		format_name?: string;
		duration?: string;
		tags?: { major_brand?: string };
	};
};

/** 10 for yuv420p10le and p010le, the raw sample size when the name does not
 *  say, 8 when nothing does. */
export function bitDepth(
	pixFmt: string | undefined | null,
	rawBits?: string,
): number {
	const fromName = pixFmt ? /(\d+)(?:le|be)$/.exec(pixFmt) : null;
	if (fromName) return Number(fromName[1]);
	const raw = Number(rawBits);
	return Number.isInteger(raw) && raw > 0 ? raw : 8;
}

const dimension = (v: unknown): number | null =>
	typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

export function parseProbe(json: unknown): VideoProbe | null {
	const doc = (json ?? {}) as ProbeDoc;
	const streams = doc.streams ?? [];
	// the same stream -map 0:v:0 picks
	const video = streams.find((s) => s.codec_type === "video");
	if (!video) return null;
	const duration = Number(doc.format?.duration);
	return {
		duration: Number.isFinite(duration) && duration > 0 ? duration : null,
		pixFmt: video.pix_fmt ?? null,
		bits: bitDepth(video.pix_fmt, video.bits_per_raw_sample),
		width: dimension(video.width),
		height: dimension(video.height),
		hasAudio: streams.some((s) => s.codec_type === "audio"),
	};
}

/** ffprobe's picture demuxers for the formats mcz can write. */
const PIPE_FORMATS: Record<string, ImageFormat> = {
	jpeg_pipe: "jpg",
	png_pipe: "png",
	webp_pipe: "webp",
	gif_pipe: "gif",
	tiff_pipe: "tiff",
	bmp_pipe: "bmp",
};

/** The same, by codec, for the image2 demuxer, which does not name the format. */
const STILL_CODECS: Record<string, ImageFormat> = {
	mjpeg: "jpg",
	png: "png",
	webp: "webp",
	gif: "gif",
	tiff: "tiff",
	bmp: "bmp",
};

const STILL_BRANDS: Record<string, ImageFormat> = {
	heic: "heic",
	heix: "heic",
	heim: "heic",
	heis: "heic",
	mif1: "heic",
	msf1: "heic",
	avif: "avif",
	avis: "avif",
};

export type Detected =
	| { kind: "image"; format: ImageFormat }
	| { kind: "unsupported"; format: string }
	| { kind: "video" }
	| null;

/**
 * What ffprobe makes of a file whose extension says nothing. ffprobe opens
 * pictures too — a JPEG is a one-frame mjpeg "video" in jpeg_pipe, a HEIC an
 * MP4 with a heic brand — and those would come out as one-frame movies, so
 * every picture demuxer (any *_pipe, image2, gif) counts as a still before
 * anything with a video stream counts as a video. A picture in a format mcz
 * cannot write, PSD or DPX say, is reported as such. Cover art in an audio
 * file is a video stream as well, and does not count.
 */
export function classifyProbe(json: unknown): Detected {
	const doc = (json ?? {}) as ProbeDoc;
	const streams = doc.streams ?? [];
	const formatName = doc.format?.format_name ?? "";

	if (formatName === "gif") return { kind: "image", format: "gif" };
	if (formatName.endsWith("_pipe")) {
		const format = own(PIPE_FORMATS, formatName);
		return format
			? { kind: "image", format }
			: { kind: "unsupported", format: formatName.slice(0, -"_pipe".length) };
	}
	if (formatName === "image2") {
		const codec =
			streams.find((s) => s.codec_type === "video")?.codec_name ?? "";
		const format = own(STILL_CODECS, codec);
		return format
			? { kind: "image", format }
			: { kind: "unsupported", format: codec || formatName };
	}

	const brand = own(STILL_BRANDS, doc.format?.tags?.major_brand?.trim() ?? "");
	if (brand) return { kind: "image", format: brand };
	const video = streams.some(
		(s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
	);
	return video ? { kind: "video" } : null;
}

/** One line of ffmpeg's -progress output as the fraction done, when it says. */
export function progressOf(
	line: string,
	duration: number | null,
): number | undefined {
	const [key, value] = line.trim().split("=", 2);
	if (key === "progress" && value === "end") return 1;
	if (key !== "out_time_us" || !duration) return undefined;
	const us = Number(value);
	return Number.isFinite(us) && us >= 0
		? Math.min(1, us / 1e6 / duration)
		: undefined;
}

// ---------------------------------------------------------------- running

class Failure extends Error {
	constructor(
		message: string,
		readonly details: string[] = [],
	) {
		super(message);
	}
}

const tail = (text: string, count = 6): string[] =>
	text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "")
		.slice(-count);

function spawn(argv: string[]) {
	try {
		return Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	} catch (err) {
		throw new Failure(`cannot run ${argv[0]}: ${(err as Error).message}`);
	}
}

async function capture(
	argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = spawn(argv);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

// The command running right now and the file it is writing. An interrupt has
// to take both down: a half-written temp file must not outlive the process.
let active: { proc: Subprocess; temp: string } | null = null;
let interrupted = false;
let aborting: Promise<void> | null = null;

/** Stops the running command and removes what it was writing. Safe to call
 *  again — a second Ctrl-C waits for the same cleanup instead of skipping it. */
export function abortActive(): Promise<void> {
	interrupted = true;
	aborting ??= (async () => {
		const current = active;
		if (!current) return;
		current.proc.kill("SIGTERM");
		const exited = await Promise.race([
			current.proc.exited.then(() => true),
			Bun.sleep(3000).then(() => false),
		]);
		if (!exited) {
			current.proc.kill("SIGKILL");
			await current.proc.exited;
		}
		removeTemp(current.temp);
	})();
	return aborting;
}

async function readProgress(
	stream: ReadableStream<Uint8Array>,
	duration: number | null,
	onProgress?: (fraction: number | null) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const fraction = progressOf(line, duration);
			if (fraction !== undefined) onProgress?.(fraction);
		}
	}
}

async function runTracked(
	argv: string[],
	temp: string,
	duration: number | null,
	onProgress?: (fraction: number | null) => void,
): Promise<{ code: number; stderr: string }> {
	const proc = spawn(argv);
	active = { proc, temp };
	try {
		const stderr = new Response(proc.stderr).text();
		await readProgress(proc.stdout, duration, onProgress);
		const code = await proc.exited;
		return { code, stderr: await stderr };
	} finally {
		if (active?.proc === proc) active = null;
	}
}

type Media =
	| { kind: "image"; format: ImageFormat; ext: string }
	| { kind: "video"; ext: string };

async function identify(source: string): Promise<Media> {
	const ext = extOf(source);
	const format = imageFormatOfExt(ext);
	if (format) return { kind: "image", format, ext };
	if (VIDEO_EXTS.has(ext.toLowerCase())) return { kind: "video", ext };

	const probe = await capture([
		"ffprobe",
		"-v",
		"error",
		"-of",
		"json",
		"-select_streams",
		"v",
		"-show_entries",
		"format=format_name:format_tags=major_brand:stream=codec_type,codec_name,nb_frames:stream_disposition=attached_pic",
		source,
	]);
	const detected =
		probe.code === 0 ? classifyProbe(parseJson(probe.stdout)) : null;
	if (!detected) throw new Failure("not an image or video");
	if (detected.kind === "unsupported")
		throw new Failure(`unsupported image format ${detected.format}`);
	// an extension that says nothing is not worth keeping on the result
	return detected.kind === "image"
		? { kind: "image", format: detected.format, ext: detected.format }
		: { kind: "video", ext: "" };
}

async function probeVideo(source: string): Promise<VideoProbe> {
	const { code, stdout, stderr } = await capture([
		"ffprobe",
		"-v",
		"error",
		"-of",
		"json",
		"-show_entries",
		"format=duration:stream=codec_type,pix_fmt,bits_per_raw_sample,width,height",
		source,
	]);
	if (code !== 0) {
		const lines = tail(stderr);
		throw new Failure(lines.pop() ?? "ffprobe cannot read it", lines);
	}
	const probe = parseProbe(parseJson(stdout));
	if (!probe) throw new Failure("no video stream in it");
	return probe;
}

export type Job = {
	source: string; // absolute
	profile: Profile;
	to: ImageFormat | undefined;
	target: OutputTarget;
	force: boolean;
	keepLarger: boolean;
	dryRun: boolean;
	reserved: Set<string>;
	onProgress?: (fraction: number | null) => void;
};

export type Outcome =
	| {
			status: "done";
			source: string;
			output: string;
			before: number;
			after: number;
	  }
	| { status: "skipped"; source: string; before: number; after: number }
	| { status: "failed"; source: string; reason: string; details: string[] }
	| { status: "planned"; source: string; output: string; command: string[] };

/** The format and extension an image result gets: what -o spells out, else
 *  --to, else whatever the source already is. */
function imageTarget(
	job: Job,
	media: { format: ImageFormat; ext: string },
): { format: ImageFormat; ext: string } {
	if (job.target.kind === "file") {
		const name = basename(job.target.path);
		const ext = extOf(name);
		const format = imageFormatOfExt(ext);
		if (!format) throw new Failure(`an image cannot be written as ${name}`);
		if (job.to && job.to !== format)
			throw new Failure(`--to ${job.to} does not match ${name}`);
		return { format, ext };
	}
	if (job.to) return { format: job.to, ext: job.to };
	return media;
}

function videoTarget(job: Job, media: { ext: string }): string {
	const codec = job.profile.video_codec;
	if (job.target.kind === "file") {
		const name = basename(job.target.path);
		const ext = extOf(name);
		if (!VIDEO_EXTS.has(ext.toLowerCase()))
			throw new Failure(`a video cannot be written as ${name}`);
		const refusal = containerRefusal(ext, codec);
		if (refusal) throw new Failure(refusal);
		return ext;
	}
	return videoExt(media.ext, codec);
}

const isSource = (path: string, source: string): boolean =>
	path.toLowerCase() === source.toLowerCase() || realFs.sameFile(path, source);

export async function compressFile(job: Job): Promise<Outcome> {
	const { source, profile } = job;
	try {
		const before = statSync(source).size;
		const media = await identify(source);

		let ext: string;
		let build: (output: string) => string[];
		let duration: number | null = null;
		if (media.kind === "image") {
			const target = imageTarget(job, media);
			ext = target.ext;
			build = (output) =>
				imageArgs({
					input: source,
					output,
					source: media.format,
					target: target.format,
					profile,
				});
		} else {
			const probe = await probeVideo(source);
			duration = probe.duration;
			ext = videoTarget(job, media);
			build = (output) => videoArgs({ input: source, output, probe, profile });
		}

		const output = resolveOutput(
			source,
			ext,
			job.target,
			job.force,
			job.reserved,
		);
		if (job.dryRun)
			return { status: "planned", source, output, command: build(output) };

		const temp = tempPathFor(output);
		// both are chosen to avoid the source; this is the last line before a write
		if (isSource(temp, source) || isSource(output, source)) {
			job.reserved.delete(output.toLowerCase());
			throw new Failure("refusing to write over the source");
		}

		let placed: string | null = null;
		try {
			mkdirSync(dirname(output), { recursive: true });
			job.onProgress?.(null);
			const argv = build(temp);
			const { code, stderr } = await runTracked(
				argv,
				temp,
				duration,
				job.onProgress,
			);
			// the interrupt handler is cleaning up and about to exit; reporting
			// this file as failed on the way out would only be noise
			if (interrupted) return await new Promise<never>(() => {});
			if (code !== 0) {
				const lines = tail(stderr);
				throw new Failure(
					lines.pop() ?? `${argv[0]} exited with code ${code}`,
					lines,
				);
			}

			let after: number;
			try {
				after = statSync(temp).size;
			} catch {
				throw new Failure(
					`${argv[0]} finished without writing ${basename(output)}`,
				);
			}
			if (after >= before && !job.keepLarger)
				return { status: "skipped", source, before, after };

			placed = placeResult(temp, output, job.force, () =>
				resolveOutput(source, ext, job.target, false, job.reserved),
			);
			return { status: "done", source, output: placed, before, after };
		} finally {
			if (placed === null) {
				removeTemp(temp);
				// a name nobody got stays free for the files after this one
				job.reserved.delete(output.toLowerCase());
			}
		}
	} catch (err) {
		const failure =
			err instanceof Failure ? err : new Failure((err as Error).message);
		return {
			status: "failed",
			source,
			reason: failure.message,
			details: failure.details,
		};
	}
}
