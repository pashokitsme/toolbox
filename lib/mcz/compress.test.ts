import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	bitDepth,
	classifyProbe,
	containerRefusal,
	type FsView,
	imageArgs,
	imageFormatOfExt,
	isCompressedName,
	kindByExt,
	type OutputTarget,
	parseProbe,
	placeResult,
	progressOf,
	removeTemp,
	resolveOutput,
	tempPathFor,
	toFormat,
	type VideoProbe,
	videoArgs,
	videoExt,
	videotoolboxQuality,
} from "./compress.ts";
import { BUILTIN, type Profile } from "./config.ts";
import { humanSize } from "./term.ts";

const fast = { ...(BUILTIN.fast as Profile) };
const small = { ...(BUILTIN.small as Profile) };

/** A pretend disk: `files` exist, and `links` maps a path to the file it is. */
const fakeFs = (
	files: string[],
	links: Record<string, string> = {},
): FsView => {
	const real = (p: string) => links[p] ?? p;
	return {
		exists: (p) => files.includes(p) || p in links,
		sameFile: (a, b) => real(a) === real(b),
	};
};

const scratch = () => mkdtempSync(join(tmpdir(), "mcz-test-"));

const beside: OutputTarget = { kind: "beside" };

describe("resolveOutput", () => {
	test("beside the source, keeping the extension's case", () => {
		expect(
			resolveOutput(
				"/p/IMG_1.JPG",
				"JPG",
				beside,
				false,
				new Set(),
				fakeFs([]),
			),
		).toBe("/p/IMG_1.compressed.JPG");
	});

	test("a taken name gets numbered", () => {
		const fs = fakeFs(["/p/a.compressed.jpg", "/p/a.compressed-2.jpg"]);
		expect(resolveOutput("/p/a.jpg", "jpg", beside, false, new Set(), fs)).toBe(
			"/p/a.compressed-3.jpg",
		);
	});

	test("--force takes the name instead", () => {
		const fs = fakeFs(["/p/a.compressed.jpg"]);
		expect(resolveOutput("/p/a.jpg", "jpg", beside, true, new Set(), fs)).toBe(
			"/p/a.compressed.jpg",
		);
	});

	test("--to and container changes arrive as the extension", () => {
		expect(
			resolveOutput("/p/a.jpeg", "webp", beside, false, new Set(), fakeFs([])),
		).toBe("/p/a.compressed.webp");
		expect(
			resolveOutput(
				"/p/clip.avi",
				videoExt("avi", "libx264"),
				beside,
				false,
				new Set(),
				fakeFs([]),
			),
		).toBe("/p/clip.compressed.mp4");
	});

	test("a source that is already a result gets another suffix", () => {
		expect(
			resolveOutput(
				"/p/a.compressed.jpg",
				"jpg",
				beside,
				false,
				new Set(),
				fakeFs([]),
			),
		).toBe("/p/a.compressed.compressed.jpg");
	});

	test("-o directory", () => {
		const target: OutputTarget = { kind: "dir", path: "/out" };
		expect(
			resolveOutput("/p/a.png", "png", target, false, new Set(), fakeFs([])),
		).toBe("/out/a.compressed.png");
	});

	test("two sources with one name into one directory do not collide, even unwritten", () => {
		const target: OutputTarget = { kind: "dir", path: "/out" };
		const reserved = new Set<string>();
		const fs = fakeFs([]);
		expect(resolveOutput("/x/a.jpg", "jpg", target, false, reserved, fs)).toBe(
			"/out/a.compressed.jpg",
		);
		expect(resolveOutput("/y/a.jpg", "jpg", target, false, reserved, fs)).toBe(
			"/out/a.compressed-2.jpg",
		);
		// --force overwrites what is on disk, never another file of the same run
		expect(resolveOutput("/z/A.JPG", "jpg", target, true, reserved, fs)).toBe(
			"/out/A.compressed-3.jpg",
		);
	});

	test("-o file is used as is, and numbered when taken", () => {
		const target: OutputTarget = { kind: "file", path: "/out/small.webp" };
		expect(
			resolveOutput("/p/a.jpg", "jpg", target, false, new Set(), fakeFs([])),
		).toBe("/out/small.webp");
		expect(
			resolveOutput(
				"/p/a.jpg",
				"jpg",
				target,
				false,
				new Set(),
				fakeFs(["/out/small.webp"]),
			),
		).toBe("/out/small-2.webp");
		expect(
			resolveOutput(
				"/p/a.jpg",
				"jpg",
				target,
				true,
				new Set(),
				fakeFs(["/out/small.webp"]),
			),
		).toBe("/out/small.webp");
	});

	test("never the source, not even with --force or through another spelling", () => {
		const same: OutputTarget = { kind: "file", path: "/p/a.jpg" };
		expect(
			resolveOutput(
				"/p/a.jpg",
				"jpg",
				same,
				true,
				new Set(),
				fakeFs(["/p/a.jpg"]),
			),
		).toBe("/p/a-2.jpg");
		const upper: OutputTarget = { kind: "file", path: "/p/A.JPG" };
		expect(
			resolveOutput(
				"/p/a.jpg",
				"jpg",
				upper,
				true,
				new Set(),
				fakeFs(["/p/a.jpg"]),
			),
		).toBe("/p/A-2.JPG");
		const link: OutputTarget = { kind: "file", path: "/q/link.jpg" };
		const fs = fakeFs(["/p/a.jpg"], { "/q/link.jpg": "/p/a.jpg" });
		expect(resolveOutput("/p/a.jpg", "jpg", link, true, new Set(), fs)).toBe(
			"/q/link-2.jpg",
		);
	});
});

describe("videoExt", () => {
	test("a container is kept when it holds the codec", () => {
		expect(videoExt("mp4", "libx265")).toBe("mp4");
		expect(videoExt("MP4", "libvpx-vp9")).toBe("MP4");
		expect(videoExt("mp4", "libsvtav1")).toBe("mp4");
		expect(videoExt("MOV", "hevc_videotoolbox")).toBe("MOV");
		expect(videoExt("mov", "libx264")).toBe("mov");
		expect(videoExt("m4v", "libx264")).toBe("m4v");
		expect(videoExt("m4v", "h264_videotoolbox")).toBe("m4v");
		for (const codec of [
			"libx264",
			"libx265",
			"libvpx",
			"libvpx-vp9",
			"libsvtav1",
			"prores_ks",
		]) {
			expect(videoExt("mkv", codec)).toBe("mkv");
		}
		expect(videoExt("webm", "libvpx-vp9")).toBe("webm");
		expect(videoExt("WEBM", "libvpx")).toBe("WEBM");
		expect(videoExt("webm", "libaom-av1")).toBe("webm");
	});

	test("and moves where the codec lives when it does not", () => {
		// ffmpeg's ipod muxer behind .m4v takes H.264 only
		expect(videoExt("m4v", "libx265")).toBe("mp4");
		expect(videoExt("m4v", "hevc_videotoolbox")).toBe("mp4");
		expect(videoExt("m4v", "libvpx-vp9")).toBe("webm");
		// mov takes neither VP9 nor AV1
		expect(videoExt("mov", "libvpx-vp9")).toBe("webm");
		expect(videoExt("mov", "libsvtav1")).toBe("mp4");
		expect(videoExt("mov", "prores_ks")).toBe("mkv");
		// mp4 takes no VP8
		expect(videoExt("mp4", "libvpx")).toBe("webm");
		expect(videoExt("webm", "libx264")).toBe("mp4");
		expect(videoExt("webm", "hevc_videotoolbox")).toBe("mp4");
		expect(videoExt("webm", "prores_ks")).toBe("mkv");
	});

	test("-o names a container: only codecs known not to fit are refused", () => {
		expect(containerRefusal("mov", "libvpx-vp9")).toBe(
			"libvpx-vp9 does not fit in .mov; .webm does",
		);
		expect(containerRefusal("webm", "libx264")).toBeDefined();
		expect(containerRefusal("m4v", "libx265")).toBeDefined();
		expect(containerRefusal("mp4", "libx265")).toBeUndefined();
		expect(containerRefusal("mov", "hevc_videotoolbox")).toBeUndefined();
		// encoders mcz does not know are left to ffmpeg
		expect(containerRefusal("mp4", "mpeg4")).toBeUndefined();
		expect(containerRefusal("mp4", "libx264rgb")).toBeUndefined();
		expect(containerRefusal("mov", "prores_ks")).toBeUndefined();
	});

	test("other containers are remapped", () => {
		for (const ext of [
			"avi",
			"wmv",
			"flv",
			"mpg",
			"mpeg",
			"3gp",
			"ts",
			"mts",
			"m2ts",
			"",
		]) {
			expect(videoExt(ext, "libx265")).toBe("mp4");
			expect(videoExt(ext, "libvpx-vp9")).toBe("webm");
			expect(videoExt(ext, "libsvtav1")).toBe("mp4");
			expect(videoExt(ext, "prores_ks")).toBe("mkv");
		}
	});

	test("inherited names are not encoders or containers", () => {
		expect(videoExt("constructor", "constructor")).toBe("mkv");
		expect(imageFormatOfExt("constructor")).toBeUndefined();
		expect(toFormat("constructor")).toBeUndefined();
		expect(toFormat("JPEG")).toBe("jpg");
	});
});

describe("temp files", () => {
	test("a short hidden name with the pid, a random tag and the real extension", () => {
		const out = `/o/${"Отпуск на море ".repeat(8)}.compressed.jpg`;
		const temp = tempPathFor(out, fakeFs([]));
		expect(temp).toMatch(
			new RegExp(`^/o/\\.mcz-${process.pid}-[0-9a-z]{6}\\.jpg$`),
		);
		expect(Buffer.byteLength(basename(temp))).toBeLessThan(30);
		expect(tempPathFor(out, fakeFs([]))).not.toBe(temp);
	});

	test("an existing path — the source included — is never used", () => {
		const tags = ["aaaaaa", "bbbbbb", "cccccc"];
		const source = `/o/.mcz-${process.pid}-aaaaaa.jpg`;
		const taken = `/o/.mcz-${process.pid}-bbbbbb.jpg`;
		expect(
			tempPathFor(
				"/o/x.jpg",
				fakeFs([source, taken]),
				() => tags.shift() as string,
			),
		).toBe(`/o/.mcz-${process.pid}-cccccc.jpg`);
	});

	test("removeTemp takes the numbered frames magick leaves too, and nothing else", () => {
		const dir = scratch();
		const temp = join(dir, ".mcz-1-abc123.jpg");
		for (const name of [
			".mcz-1-abc123.jpg",
			".mcz-1-abc123-0.jpg",
			".mcz-1-abc123-14.jpg",
			".mcz-1-abc123-x.jpg",
			".mcz-1-abc1234-0.jpg",
			"photo.jpg",
		]) {
			writeFileSync(join(dir, name), "x");
		}
		removeTemp(temp);
		expect(readdirSync(dir).sort()).toEqual([
			".mcz-1-abc123-x.jpg",
			".mcz-1-abc1234-0.jpg",
			"photo.jpg",
		]);
	});
});

describe("placeResult", () => {
	test("a free name is taken by moving the temp file there", () => {
		const dir = scratch();
		const temp = join(dir, ".t.jpg");
		writeFileSync(temp, "result");
		const out = join(dir, "a.compressed.jpg");
		expect(placeResult(temp, out, false, () => "unused")).toBe(out);
		expect(readFileSync(out, "utf8")).toBe("result");
		expect(existsSync(temp)).toBe(false);
	});

	test("a name taken during the encode is left alone and the next one used", () => {
		const dir = scratch();
		const temp = join(dir, ".t.jpg");
		writeFileSync(temp, "result");
		const out = join(dir, "a.compressed.jpg");
		const next = join(dir, "a.compressed-2.jpg");
		writeFileSync(out, "someone else's");
		expect(placeResult(temp, out, false, () => next)).toBe(next);
		expect(readFileSync(out, "utf8")).toBe("someone else's");
		expect(readFileSync(next, "utf8")).toBe("result");
		expect(existsSync(temp)).toBe(false);
	});

	test("a temp file that is gone fails without leaving anything at the name", () => {
		const dir = scratch();
		const out = join(dir, "a.compressed.jpg");
		expect(() =>
			placeResult(join(dir, ".missing.jpg"), out, false, () => "unused"),
		).toThrow();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("--force replaces it", () => {
		const dir = scratch();
		const temp = join(dir, ".t.jpg");
		writeFileSync(temp, "result");
		const out = join(dir, "a.compressed.jpg");
		writeFileSync(out, "old");
		expect(placeResult(temp, out, true, () => "unused")).toBe(out);
		expect(readFileSync(out, "utf8")).toBe("result");
	});
});

describe("imageArgs", () => {
	const head = ["magick", "-define", "filename:literal=true"];
	const strip = ["-auto-orient", "+profile", "!icc,*", "+set", "comment"];

	test("jpeg", () => {
		expect(
			imageArgs({
				input: "/p/a.jpg",
				output: "/p/o.jpg",
				source: "jpg",
				target: "jpg",
				profile: fast,
			}),
		).toEqual([
			...head,
			"/p/a.jpg",
			...strip,
			"-gaussian-blur",
			"0.05",
			"-interlace",
			"Plane",
			"-sampling-factor",
			"4:2:0",
			"-quality",
			"85",
			"/p/o.jpg",
		]);
	});

	test("--to webp with --max", () => {
		const profile = { ...small, max: 800 };
		expect(
			imageArgs({
				input: "/p/a.jpg",
				output: "/p/o.webp",
				source: "jpg",
				target: "webp",
				profile,
			}),
		).toEqual([
			...head,
			"/p/a.jpg",
			...strip,
			"-resize",
			"800x800>",
			"-gaussian-blur",
			"0.05",
			"-quality",
			"72",
			"-define",
			"webp:method=6",
			"/p/o.webp",
		]);
	});

	test("avif and heic take the quality; no blur when it is 0", () => {
		const profile = { ...fast, image_blur: 0 };
		expect(
			imageArgs({
				input: "/i.heic",
				output: "/o.avif",
				source: "heic",
				target: "avif",
				profile,
			}),
		).toEqual([
			...head,
			"/i.heic",
			"-coalesce",
			...strip,
			"-quality",
			"85",
			"/o.avif",
		]);
	});

	test("png is lossless: no blur, no quality from the profile", () => {
		expect(
			imageArgs({
				input: "/i.png",
				output: "/o.png",
				source: "png",
				target: "png",
				profile: fast,
			}),
		).toEqual([...head, "/i.png", ...strip, "-quality", "95", "/o.png"]);
	});

	test("gif is coalesced before resizing and optimized after", () => {
		const profile = { ...fast, max: 320 };
		expect(
			imageArgs({
				input: "/i.gif",
				output: "/o.gif",
				source: "gif",
				target: "gif",
				profile,
			}),
		).toEqual([
			...head,
			"/i.gif",
			"-coalesce",
			...strip,
			"-resize",
			"320x320>",
			"-layers",
			"Optimize",
			"/o.gif",
		]);
	});

	test("anything that may hold several pictures keeps the first in a still format", () => {
		for (const source of ["gif", "webp", "tiff", "avif", "heic"] as const) {
			for (const target of ["jpg", "png", "bmp"] as const) {
				const args = imageArgs({
					input: "/i",
					output: "/o",
					source,
					target,
					profile: fast,
				});
				expect(args.slice(3, 6)).toEqual(["/i", "-delete", "1--1"]);
			}
		}
	});

	test("a format that holds a sequence keeps every frame", () => {
		for (const source of ["gif", "webp", "avif", "heic"] as const) {
			for (const target of ["gif", "webp", "avif", "heic"] as const) {
				const args = imageArgs({
					input: "/i",
					output: "/o",
					source,
					target,
					profile: fast,
				});
				expect(args).not.toContain("-delete");
				expect(args.slice(3, 5)).toEqual(["/i", "-coalesce"]);
			}
		}
		const tiff = imageArgs({
			input: "/i.tif",
			output: "/o.tif",
			source: "tiff",
			target: "tiff",
			profile: fast,
		});
		expect(tiff).not.toContain("-delete");
		expect(tiff).not.toContain("-coalesce");
		const jpg = imageArgs({
			input: "/i.jpg",
			output: "/o.png",
			source: "jpg",
			target: "png",
			profile: fast,
		});
		expect(jpg).not.toContain("-delete");
	});

	test("tiff gets zip, bmp just a re-encode", () => {
		expect(
			imageArgs({
				input: "/i.tif",
				output: "/o.tif",
				source: "tiff",
				target: "tiff",
				profile: fast,
			}).slice(-3),
		).toEqual(["-compress", "zip", "/o.tif"]);
		expect(
			imageArgs({
				input: "/i.bmp",
				output: "/o.bmp",
				source: "bmp",
				target: "bmp",
				profile: fast,
			}),
		).toEqual([...head, "/i.bmp", ...strip, "/o.bmp"]);
	});
});

describe("videoArgs", () => {
	const probe: VideoProbe = {
		duration: 5,
		pixFmt: "yuv420p",
		bits: 8,
		width: 1280,
		height: 720,
		hasAudio: true,
	};
	const head = (input: string, codec: string) => [
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
	const tail = (output: string) => [
		"-progress",
		"pipe:1",
		"-nostats",
		"-loglevel",
		"error",
		output,
	];
	const vfOf = (args: string[]) =>
		args.includes("-vf") ? args[args.indexOf("-vf") + 1] : undefined;

	test("libx264 into mp4", () => {
		expect(
			videoArgs({ input: "/i.mov", output: "/o.mp4", probe, profile: fast }),
		).toEqual([
			...head("/i.mov", "libx264"),
			"-crf",
			"23",
			"-preset",
			"fast",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			...tail("/o.mp4"),
		]);
	});

	test("libx265 keeps 10-bit and tags hvc1", () => {
		const ten = { ...probe, pixFmt: "yuv420p10le", bits: 10 };
		expect(
			videoArgs({
				input: "/i.mov",
				output: "/o.MOV",
				probe: ten,
				profile: small,
			}),
		).toEqual([
			...head("/i.mov", "libx265"),
			"-crf",
			"28",
			"-preset",
			"medium",
			"-pix_fmt",
			"yuv420p10le",
			"-c:a",
			"aac",
			"-b:a",
			"96k",
			"-movflags",
			"+faststart",
			"-tag:v",
			"hvc1",
			...tail("/o.MOV"),
		]);
		const eight = videoArgs({
			input: "/i.mov",
			output: "/o.mkv",
			probe,
			profile: small,
		});
		expect(eight).toContain("yuv420p");
		expect(eight).not.toContain("-movflags");
		expect(eight).not.toContain("-tag:v");
	});

	test("videotoolbox gets -q:v instead of crf and preset", () => {
		const profile = { ...fast, video_codec: "hevc_videotoolbox" };
		expect(
			videoArgs({ input: "/i.mov", output: "/o.mov", probe, profile }),
		).toEqual([
			...head("/i.mov", "hevc_videotoolbox"),
			"-q:v",
			"54",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			"-tag:v",
			"hvc1",
			...tail("/o.mov"),
		]);
		expect(videotoolboxQuality(23)).toBe(54);
		expect(videotoolboxQuality(28)).toBe(44);
		expect(videotoolboxQuality(0)).toBe(100);
		expect(videotoolboxQuality(63)).toBe(1);
	});

	test("vp9 into webm: constant quality and opus", () => {
		const profile = { ...fast, video_codec: "libvpx-vp9", video_crf: 32.4 };
		expect(
			videoArgs({ input: "/i.webm", output: "/o.webm", probe, profile }),
		).toEqual([
			...head("/i.webm", "libvpx-vp9"),
			"-b:v",
			"0",
			"-crf",
			"32",
			"-c:a",
			"libopus",
			"-b:a",
			"128k",
			...tail("/o.webm"),
		]);
	});

	test("svt-av1 only takes a numeric preset", () => {
		const named = videoArgs({
			input: "/i.mp4",
			output: "/o.mp4",
			probe,
			profile: { ...fast, video_codec: "libsvtav1" },
		});
		expect(named).not.toContain("-preset");
		expect(named).not.toContain("-pix_fmt");
		const numeric = videoArgs({
			input: "/i.mp4",
			output: "/o.mp4",
			probe,
			profile: { ...fast, video_codec: "libsvtav1", video_preset: "8" },
		});
		expect(numeric.join(" ")).toContain("-crf 23 -preset 8");
	});

	test("an empty preset passes none", () => {
		const args = videoArgs({
			input: "/i.mp4",
			output: "/o.mp4",
			probe,
			profile: { ...fast, video_preset: "" },
		});
		expect(args).not.toContain("-preset");
	});

	test("--max scales the longest side, even sizes, never up", () => {
		const args = videoArgs({
			input: "/i.mp4",
			output: "/o.mp4",
			probe,
			profile: { ...fast, max: 800 },
		});
		expect(vfOf(args)).toBe(
			"scale='if(gte(iw,ih),trunc(min(800,iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(800,ih)/2)*2)'",
		);
		expect(args.indexOf("-vf")).toBeGreaterThan(args.indexOf("-pix_fmt"));
	});

	test("odd sizes are rounded to even for H.264 and HEVC only", () => {
		const odd = { ...probe, width: 321, height: 240 };
		const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
		for (const codec of [
			"libx264",
			"libx265",
			"h264_videotoolbox",
			"hevc_videotoolbox",
		]) {
			expect(
				vfOf(
					videoArgs({
						input: "/i",
						output: "/o.mkv",
						probe: odd,
						profile: { ...fast, video_codec: codec },
					}),
				),
			).toBe(even);
		}
		expect(
			vfOf(
				videoArgs({
					input: "/i",
					output: "/o.mkv",
					probe: { ...probe, height: 241 },
					profile: fast,
				}),
			),
		).toBe(even);
		expect(
			vfOf(
				videoArgs({
					input: "/i",
					output: "/o.mkv",
					probe: odd,
					profile: { ...fast, video_codec: "libvpx-vp9" },
				}),
			),
		).toBeUndefined();
		expect(
			vfOf(videoArgs({ input: "/i", output: "/o.mkv", probe, profile: fast })),
		).toBeUndefined();
		// --max already rounds, so it is the only filter
		expect(
			vfOf(
				videoArgs({
					input: "/i",
					output: "/o.mkv",
					probe: odd,
					profile: { ...fast, max: 200 },
				}),
			),
		).toContain("min(200,iw)");
	});

	test("no audio arguments without audio", () => {
		const args = videoArgs({
			input: "/i.mp4",
			output: "/o.mp4",
			probe: { ...probe, hasAudio: false },
			profile: fast,
		});
		expect(args).not.toContain("-c:a");
	});
});

describe("probing", () => {
	test("bit depth", () => {
		expect(bitDepth("yuv420p")).toBe(8);
		expect(bitDepth("yuv420p10le")).toBe(10);
		expect(bitDepth("p010le")).toBe(10);
		expect(bitDepth("yuv422p12be")).toBe(12);
		expect(bitDepth("nv12", "8")).toBe(8);
		expect(bitDepth(undefined, "10")).toBe(10);
	});

	test("parseProbe", () => {
		const doc = {
			streams: [
				{
					codec_type: "video",
					pix_fmt: "yuv420p10le",
					width: 321,
					height: 241,
				},
				{ codec_type: "audio" },
			],
			format: { duration: "5.000000" },
		};
		expect(parseProbe(doc)).toEqual({
			duration: 5,
			pixFmt: "yuv420p10le",
			bits: 10,
			width: 321,
			height: 241,
			hasAudio: true,
		});
		expect(parseProbe({ streams: [{ codec_type: "audio" }] })).toBeNull();
		const bare = parseProbe({
			streams: [{ codec_type: "video" }],
			format: { duration: "N/A" },
		});
		expect(bare?.duration).toBeNull();
		expect(bare?.width).toBeNull();
	});

	test("classifyProbe tells pictures from videos", () => {
		const still = (format_name: string, codec_name = "x") => ({
			streams: [{ codec_type: "video", codec_name }],
			format: { format_name },
		});
		expect(classifyProbe(still("jpeg_pipe"))).toEqual({
			kind: "image",
			format: "jpg",
		});
		expect(classifyProbe(still("gif"))).toEqual({
			kind: "image",
			format: "gif",
		});
		expect(classifyProbe(still("image2", "png"))).toEqual({
			kind: "image",
			format: "png",
		});
		expect(classifyProbe(still("psd_pipe"))).toEqual({
			kind: "unsupported",
			format: "psd",
		});
		expect(classifyProbe(still("pgm_pipe"))).toEqual({
			kind: "unsupported",
			format: "pgm",
		});
		expect(classifyProbe(still("dpx_pipe"))).toEqual({
			kind: "unsupported",
			format: "dpx",
		});
		expect(classifyProbe(still("image2", "exr"))).toEqual({
			kind: "unsupported",
			format: "exr",
		});
		expect(classifyProbe(still("constructor_pipe"))).toEqual({
			kind: "unsupported",
			format: "constructor",
		});
		expect(
			classifyProbe({
				streams: [{ codec_type: "video" }],
				format: {
					format_name: "mov,mp4,m4a,3gp,3g2,mj2",
					tags: { major_brand: "heix" },
				},
			}),
		).toEqual({ kind: "image", format: "heic" });
		expect(
			classifyProbe({
				streams: [{ codec_type: "video" }],
				format: {
					format_name: "mov,mp4,m4a,3gp,3g2,mj2",
					tags: { major_brand: "isom" },
				},
			}),
		).toEqual({ kind: "video" });
		expect(
			classifyProbe({
				streams: [{ codec_type: "video", disposition: { attached_pic: 1 } }],
				format: { format_name: "mp3" },
			}),
		).toBeNull();
		expect(classifyProbe(null)).toBeNull();
	});

	test("progress lines", () => {
		expect(progressOf("out_time_us=2500000", 5)).toBe(0.5);
		expect(progressOf("out_time_us=9000000", 5)).toBe(1);
		expect(progressOf("out_time_us=N/A", 5)).toBeUndefined();
		expect(progressOf("out_time_us=2500000", null)).toBeUndefined();
		expect(progressOf("progress=end", null)).toBe(1);
		expect(progressOf("progress=continue", 5)).toBeUndefined();
	});
});

describe("names", () => {
	test("kind by extension", () => {
		expect(kindByExt("/a/B.HEIC")).toBe("image");
		expect(kindByExt("x.m2ts")).toBe("video");
		expect(kindByExt("notes.txt")).toBeNull();
		expect(kindByExt("noext")).toBeNull();
	});

	test("earlier results", () => {
		expect(isCompressedName("a.compressed.jpg")).toBe(true);
		expect(isCompressedName("a.compressed-12.MP4")).toBe(true);
		expect(isCompressedName("compressed.jpg")).toBe(false);
		expect(isCompressedName("a.compressed.jpg.txt")).toBe(false);
	});

	test("sizes", () => {
		expect(humanSize(0)).toBe("0 B");
		expect(humanSize(999)).toBe("999 B");
		expect(humanSize(4_200_000)).toBe("4.2 MB");
		expect(humanSize(999_960)).toBe("1.0 MB");
	});
});
