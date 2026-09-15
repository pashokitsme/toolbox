#!/usr/bin/env bun
// mcz — shrink photos and videos with ImageMagick and ffmpeg.
//
//   mcz                pick files in the current directory
//   mcz ~/Downloads    pick them there
//   mcz *.HEIC         compress these right away
//   mcz -g             pick them in the macOS file dialog
//
// --help is the documentation. This file is the command line, the file dialog
// and the result lines; picker.ts is the full-screen list, compress.ts the
// commands and config.ts the profiles.

import { statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
	abortActive,
	compressFile,
	extOf,
	IMAGE_EXTS,
	type ImageFormat,
	imageFormatOfExt,
	type Outcome,
	type OutputTarget,
	toFormat,
	VIDEO_EXTS,
	videotoolboxQuality,
} from "./compress.ts";
import {
	BUILTIN,
	ConfigError,
	DEFAULT_PROFILE,
	loadConfig,
	type Profile,
	type ProfileKey,
	parseFlagValue,
	resolveProfile,
} from "./config.ts";
import { KEYS, pick } from "./picker.ts";
import {
	C,
	CSI,
	colorful,
	humanSize,
	paint,
	printable,
	shellQuote,
	tildify,
	truncateToWidth,
} from "./term.ts";

const fast = BUILTIN.fast as Profile;
const small = BUILTIN.small as Profile;

// built from the profiles themselves, so the help cannot drift from config.ts
const profileRow = (
	label: string,
	fastCell: string,
	smallCell: string,
): string => `  ${label.padEnd(12)}${fastCell.padEnd(32)}${smallCell}`;
const describe = (label: string, cell: (p: Profile) => string): string =>
	profileRow(label, cell(fast), cell(small));
const PROFILES = [
	profileRow("", "fast", "small"),
	describe("images", (p) => `quality ${p.image_quality}, blur ${p.image_blur}`),
	describe("video", (p) =>
		`${p.video_codec} crf ${p.video_crf}, preset ${p.video_preset}`),
	describe("audio", (p) => `AAC ${p.audio_bitrate}`),
	describe("size limit", (p) => (p.max ? `${p.max} px` : "none")),
].join("\n");

const USAGE = `mcz — shrink photos and videos with ImageMagick and ffmpeg

usage: mcz [options] [dir]       pick files in a full-screen list (default: here)
       mcz [options] file...     compress these files
       mcz [options] -g [dir]    pick them in the macOS file dialog instead

One directory opens the list there; files are compressed right away, one after
another. Several directories, or directories mixed with files, are an error.
The file dialog lets you choose any file, since macOS does not know every video
container (.mkv, for one); whatever is not a photo or video fails on its own.

options
  -p, --profile NAME     settings to start from: fast (default), small, or your own
  -o, --output PATH      where results go, see "output" below
  -q, --quality N        image quality, 1-100
      --crf N            video quality, 0-63 (libx264 and libx265 stop at 51):
                         lower looks better and weighs more
      --codec NAME       ffmpeg video encoder: libx264, libx265, hevc_videotoolbox,
                         h264_videotoolbox, libsvtav1, libvpx-vp9, ...
      --preset NAME      encoder speed: ultrafast ... veryslow for x264 and x265,
                         a number 0-13 for libsvtav1; "" for none
      --audio-bitrate B  audio bitrate, such as 128k
      --max N            longest side in pixels, for images and videos alike; never
                         upscales; 0 is no limit
      --to FORMAT        convert images to webp, avif, jpg, png or heic; videos stay
  -f, --force            overwrite a result that exists instead of numbering a new one
      --keep-larger      keep a result that did not come out smaller than its source
  -n, --dry-run          print the commands, run and write nothing
      --config PATH      config file (default: $XDG_CONFIG_HOME/mcz.toml, which is
                         ~/.config/mcz.toml unless that variable is set)
  -g, --pick             choose the files in the macOS file dialog
  -h, --help             this text

A value goes after its flag or after "=": -q 80, --crf=30.

profiles
${PROFILES}

fast is H.264 at a quick preset: plays anywhere and is done soon. small trades
time for size: HEVC at a slower preset (10-bit when the source is), lower image
quality and audio bitrate. HEVC plays on Apple devices, recent Android and
current browsers, not everywhere. The blur is a gaussian of that sigma before
lossy image encoding: invisible, but it takes away noise JPEG would spend bytes
on. Flags override whichever profile is chosen.

config
  The file is optional; without it the profiles above apply. Each
  [profile.NAME] table changes only the keys it names, and a name that is not
  built in makes a new profile that starts from fast. Unknown keys, values of
  the wrong type or out of range, and a crf above 51 for libx264 or libx265 are
  errors.

    [profile.small]
    image_quality = 72         # 1-100
    image_blur = 0.05          # 0-10, 0 is off
    video_codec = "libx265"    # any ffmpeg video encoder
    video_crf = 28             # 0-63, at most 51 for libx264 and libx265
    video_preset = "medium"    # "" passes no -preset
    audio_bitrate = "96k"
    max = 0                    # longest side in pixels, 0 is off

output
  photo.jpg         -> photo.compressed.jpg, beside the source
  if that is taken  -> photo.compressed-2.jpg, -3, ... (with -f: overwritten)
  -o DIR/           -> DIR/photo.compressed.jpg; DIR is a path ending in / or an
                       existing directory, created when missing
  -o FILE           -> exactly FILE, numbered FILE-2 when taken; one input only.
                       Its extension picks the image format, like --to.
  --to webp         -> photo.compressed.webp

  A video keeps its container when that holds the codec: .mp4 takes H.264,
  HEVC, VP9 and AV1; .mov H.264 and HEVC; .m4v only H.264; .mkv anything; .webm
  VP8, VP9 and AV1. Otherwise, and from .avi, .wmv, .flv, .mpg, .mpeg, .3gp,
  .ts, .mts and .m2ts, it goes to .mp4 for H.264, HEVC and AV1, to .webm for VP8
  and VP9, and to .mkv for encoders mcz does not know. -o FILE naming a
  container from that list which cannot hold the codec fails before encoding.

  The result is written to a hidden .mcz-PID-XXXXXX.EXT beside it and moved
  into place once complete, so a failure or Ctrl-C leaves nothing behind. When
  something else took the result's name while it was encoding, it goes to the
  next free number instead (-f replaces it). A result that is not smaller than
  its source is deleted and reported as skipped; --keep-larger keeps it.

images (ImageMagick)
  EXIF orientation is applied to the pixels, then EXIF, XMP, IPTC and comments
  are dropped: camera, GPS position, dates. The ICC color profile stays, so
  colors do not shift. JPEG comes out progressive with 4:2:0 chroma, WebP from
  its slowest and smallest method, AVIF and HEIC at the given quality. PNG stays
  lossless, only recompressed harder, so expect little from it; GIF keeps its
  animation and is re-optimized; TIFF gets zip compression; BMP is re-encoded
  and usually skipped. An animation, or a multi-image AVIF, HEIC or TIFF, keeps
  only its first frame in a still format. Quality and blur do not apply to PNG,
  GIF, TIFF or BMP. A file whose extension says nothing is identified by
  ffprobe; a picture in a format mcz cannot write, PSD or DPX say, fails.

videos (ffmpeg)
  The first video stream and every audio stream are re-encoded, audio to AAC
  (Opus in .webm); subtitles and other streams are dropped. Container metadata
  is copied, and that includes the creation date and, for phone videos, the
  location. Rotation is applied to the pixels. libx264 writes 8-bit 4:2:0,
  libx265 10-bit when the source is 10-bit; for H.264 and HEVC an odd width or
  height is rounded down to even, which 4:2:0 needs. HDR is not guaranteed to
  survive: its color metadata can get lost and the result look washed out.
  hevc_videotoolbox and h264_videotoolbox, the Mac's hardware encoders (fast,
  larger files), take no crf and no preset: they get -q:v 100 - 2 * crf,
  clamped to 1-100, so crf ${fast.video_crf} is q ${videotoolboxQuality(fast.video_crf)} and crf ${small.video_crf} is q ${videotoolboxQuality(small.video_crf)}. libvpx, libvpx-vp9
  and libaom-av1 run in constant quality (-b:v 0 -crf); libsvtav1 takes a
  numeric preset and ignores a named one.

exit status
  0 when every file was compressed or skipped, and when the picker or the
  dialog is left without choosing; 1 when a file failed or on an error; 2 for a
  bad command line; 130 on Ctrl-C, in the picker too.
`;

const HELP = `${USAGE}\n${KEYS}`;

// ------------------------------------------------------------------ helpers

/** The message may carry file names, so its control characters are shown
 *  rather than sent to the terminal; the hint is this program's own text. */
const die = (message: string, code = 1, hint?: string): never => {
	process.stderr.write(
		`mcz: ${printable(message)}\n${hint ? `     ${hint}\n` : ""}`,
	);
	process.exit(code);
};

const usage = (message: string): never => die(message, 2, "see mcz --help");

const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

// ------------------------------------------------------------- command line

type Options = {
	profile: string;
	output?: string;
	overrides: Partial<Profile>;
	to?: ImageFormat;
	force: boolean;
	keepLarger: boolean;
	dryRun: boolean;
	config?: string;
	pick: boolean;
	paths: string[];
};

const SETTINGS: Record<string, ProfileKey> = {
	"-q": "image_quality",
	"--quality": "image_quality",
	"--crf": "video_crf",
	"--codec": "video_codec",
	"--preset": "video_preset",
	"--audio-bitrate": "audio_bitrate",
	"--max": "max",
};

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		profile: DEFAULT_PROFILE,
		overrides: {},
		force: false,
		keepLarger: false,
		dryRun: false,
		pick: false,
		paths: [],
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--") {
			opts.paths.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			opts.paths.push(arg);
			continue;
		}

		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[i + 1];
			if (next === undefined) return usage(`${flag} needs a value`);
			i += 1;
			return next;
		};
		const toggle = (): true =>
			inline === undefined ? true : usage(`${flag} takes no value`);

		if (Object.hasOwn(SETTINGS, flag)) {
			const setting = SETTINGS[flag] as ProfileKey;
			const raw = value();
			try {
				(opts.overrides as Record<string, unknown>)[setting] = parseFlagValue(
					setting,
					raw,
				);
			} catch (err) {
				usage(`${flag} ${(err as Error).message}`);
			}
			continue;
		}

		switch (flag) {
			case "-h":
			case "--help":
				process.stdout.write(HELP);
				process.exit(0);
				break;
			case "-p":
			case "--profile":
				opts.profile = value();
				break;
			case "-o":
			case "--output":
				opts.output = value();
				if (opts.output === "") usage("-o needs a path");
				break;
			case "--to": {
				const raw = value();
				opts.to =
					toFormat(raw) ??
					usage(`--to takes webp, avif, jpg, png or heic, got "${raw}"`);
				break;
			}
			case "--config":
				opts.config = value();
				break;
			case "-f":
			case "--force":
				opts.force = toggle();
				break;
			case "--keep-larger":
				opts.keepLarger = toggle();
				break;
			case "-n":
			case "--dry-run":
				opts.dryRun = toggle();
				break;
			case "-g":
			case "--pick":
				opts.pick = toggle();
				break;
			default:
				usage(`unknown option ${flag}`);
		}
	}
	return opts;
}

// --------------------------------------------------------------- file dialog

// The directory comes in as an argument rather than spliced into the source,
// so no name can break out of an AppleScript string. The paths go out joined
// by NUL, the one character a path cannot contain — a newline can be in a name.
// No "of type" filter: macOS has no type for .mkv and would grey it out.
const DIALOG = `on run argv
	activate
	set chosen to choose file with prompt "Files to compress" default location (POSIX file (item 1 of argv)) with multiple selections allowed
	set paths to {}
	repeat with f in chosen
		set end of paths to POSIX path of f
	end repeat
	set AppleScript's text item delimiters to (character id 0)
	return paths as text
end run
`;

/** The paths osascript printed: NUL-separated, with the newline it always adds. */
export const dialogPaths = (stdout: string): string[] =>
	stdout
		.replace(/\n$/, "")
		.split("\0")
		.filter((path) => path !== "");

async function chooseInDialog(dir: string): Promise<string[]> {
	const proc = Bun.spawn(["osascript", "-", dir], {
		stdin: new Blob([DIALOG]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		if (stderr.includes("-128")) return []; // Cancel
		return die(`the file dialog failed: ${stderr.trim()}`);
	}
	return dialogPaths(stdout);
}

// ------------------------------------------------------------------ results

const cwd = process.cwd();
const colorOut = colorful(process.stdout);
const colorErr = colorful(process.stderr);

/** Relative to here when it is under here, ~-shortened otherwise — a result
 *  in another tree reads better whole than as a ladder of ../ — and with any
 *  control characters in the names shown rather than obeyed. */
function shown(path: string): string {
	const rel = relative(cwd, path);
	return printable(
		rel === "" || rel === ".." || rel.startsWith("../") ? tildify(path) : rel,
	);
}

function change(before: number, after: number): string {
	if (before === 0) return "";
	const percent = Math.round((after / before - 1) * 100);
	if (percent === 0) return "0%";
	return percent < 0 ? `−${-percent}%` : `+${percent}%`;
}

function report(outcome: Outcome): void {
	const say = (line: string) => process.stdout.write(`${line}\n`);
	switch (outcome.status) {
		case "planned":
			say(outcome.command.map(shellQuote).join(" "));
			break;
		case "done":
			say(
				paint(
					colorOut,
					C.green,
					`  ${humanSize(outcome.before)} → ${humanSize(outcome.after)}  ${change(outcome.before, outcome.after)}  ${shown(outcome.output)}`,
				),
			);
			break;
		case "skipped":
			say(
				paint(
					colorOut,
					C.yellow,
					`  ${humanSize(outcome.before)} → ${humanSize(outcome.after)}  skipped (not smaller)  ${shown(outcome.source)}`,
				),
			);
			break;
		case "failed":
			// ffmpeg and magick quote the file names in their errors
			say(
				paint(
					colorOut,
					C.red,
					`  failed: ${printable(outcome.reason)}  ${shown(outcome.source)}`,
				),
			);
			for (const line of outcome.details)
				say(paint(colorOut, C.gray, `      ${printable(line)}`));
			break;
	}
}

/** One status line on stderr, rewritten in place while a file is worked on and
 *  wiped before its result is printed. Only for a terminal: in a pipe or a log
 *  it would be a heap of carriage returns. */
class ProgressLine {
	private last = "";
	private readonly name: string;

	constructor(name: string) {
		this.name = printable(name);
	}

	update(fraction: number | null): void {
		let text: string;
		if (fraction === null) {
			text = `  ${paint(colorErr, C.gray, "[..........]     ")}${this.name}`;
		} else {
			const filled = Math.round(fraction * 10);
			const percent = `${Math.round(fraction * 100)}%`.padStart(4);
			text = `  [${"#".repeat(filled)}${".".repeat(10 - filled)}] ${percent}  ${this.name}`;
		}
		if (text === this.last) return;
		this.last = text;
		const cols = process.stderr.columns || 80;
		process.stderr.write(
			`\r${CSI}2K${truncateToWidth(text, cols - 1)}${colorErr ? C.reset : ""}`,
		);
	}

	clear(): void {
		if (this.last) process.stderr.write(`\r${CSI}2K`);
		this.last = "";
	}
}

let progress: ProgressLine | null = null;

// -------------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));

let profile: Profile;
try {
	const profiles = loadConfig(opts.config);
	try {
		profile = resolveProfile(profiles, opts.profile, opts.overrides);
	} catch (err) {
		profile = usage((err as Error).message);
	}
} catch (err) {
	if (!(err instanceof ConfigError)) throw err;
	profile = die(err.message);
}

const dirs: string[] = [];
const files: string[] = [];
for (const path of opts.paths) {
	const absolute = resolve(cwd, path);
	try {
		(statSync(absolute).isDirectory() ? dirs : files).push(absolute);
	} catch {
		die(`no such file or directory: ${path}`);
	}
}
if (dirs.length > 1) usage("one directory at a time");
if (dirs.length > 0 && files.length > 0)
	usage("either one directory to pick in, or files to compress, not both");
if (opts.pick && files.length > 0)
	usage(
		"-g picks the files itself; give it a directory to start in, or nothing",
	);

let target: OutputTarget = { kind: "beside" };
if (opts.output !== undefined) {
	const path = resolve(cwd, opts.output);
	if (opts.output.endsWith("/") || isDirectory(path)) {
		target = { kind: "dir", path };
	} else {
		const ext = extOf(path).toLowerCase();
		if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
			usage(
				`-o ${opts.output}: ${ext ? `.${ext} is not a photo or video extension` : "no extension"} — end it with / for a directory`,
			);
		}
		const format = imageFormatOfExt(ext);
		if (opts.to && format && format !== opts.to)
			usage(`--to ${opts.to} contradicts -o ${opts.output}`);
		if (files.length > 1)
			usage(
				`-o names one file, but there are ${files.length} inputs — end it with / for a directory`,
			);
		target = { kind: "file", path };
	}
}

const interrupt = (code: number) => () => {
	progress?.clear();
	void abortActive().finally(() => process.exit(code));
};
process.on("SIGINT", interrupt(130));
process.on("SIGTERM", interrupt(143));
process.on("SIGHUP", interrupt(129));

let chosen = files;
if (opts.pick) {
	chosen = await chooseInDialog(dirs[0] ?? cwd);
} else if (files.length === 0) {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		die("the picker needs a terminal");
	let picked: string[] | null = null;
	try {
		picked = await pick(dirs[0] ?? cwd, opts.profile);
	} catch (err) {
		die((err as Error).message);
	}
	// ctrl-c in the picker is a key, not a signal, but it means the same
	if (picked === null) process.exit(130);
	chosen = picked;
}
if (chosen.length === 0) process.exit(0);
if (target.kind === "file" && chosen.length > 1) {
	usage(
		`-o names one file, but ${chosen.length} were chosen — end it with / for a directory`,
	);
}

const reserved = new Set<string>();
const totals = { done: 0, skipped: 0, failed: 0, before: 0, after: 0 };
for (const source of chosen) {
	progress =
		process.stderr.isTTY && !opts.dryRun
			? new ProgressLine(basename(source))
			: null;
	const line = progress;
	const outcome = await compressFile({
		source: resolve(cwd, source),
		profile,
		to: opts.to,
		target,
		force: opts.force,
		keepLarger: opts.keepLarger,
		dryRun: opts.dryRun,
		reserved,
		onProgress: line ? (fraction) => line.update(fraction) : undefined,
	});
	progress?.clear();
	progress = null;
	report(outcome);

	if (outcome.status === "done") {
		totals.done += 1;
		totals.before += outcome.before;
		totals.after += outcome.after;
	} else if (outcome.status === "skipped") totals.skipped += 1;
	else if (outcome.status === "failed") totals.failed += 1;
}

if (chosen.length > 1 && !opts.dryRun) {
	const sizes = totals.done
		? `${humanSize(totals.before)} → ${humanSize(totals.after)}  ${change(totals.before, totals.after)}  `
		: "";
	const counts = `${totals.done} compressed, ${totals.skipped} skipped, ${totals.failed} failed`;
	process.stdout.write(
		`${paint(colorOut, C.bold, `  total  ${sizes}${counts}`)}\n`,
	);
}

process.exit(totals.failed > 0 ? 1 : 0);
