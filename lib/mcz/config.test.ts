import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN,
	ConfigError,
	crfProblem,
	defaultConfigPath,
	loadConfig,
	mergeConfig,
	type Profile,
	parseFlagValue,
	resolveProfile,
} from "./config.ts";

describe("mergeConfig", () => {
	test("no document means the built-ins", () => {
		const profiles = mergeConfig({}, "x.toml");
		expect(profiles).toEqual({
			fast: { ...BUILTIN.fast },
			small: { ...BUILTIN.small },
		} as never);
	});

	test("a table overrides only the keys it names", () => {
		const profiles = mergeConfig(
			{ profile: { small: { video_crf: 30, image_quality: 60 } } },
			"x.toml",
		);
		expect(profiles.small).toEqual({
			...BUILTIN.small,
			video_crf: 30,
			image_quality: 60,
		} as never);
		expect(profiles.fast).toEqual({ ...BUILTIN.fast } as never);
	});

	test("a new profile starts from fast", () => {
		const profiles = mergeConfig(
			{ profile: { tiny: { max: 1280, video_codec: "libsvtav1" } } },
			"x.toml",
		);
		expect(profiles.tiny).toEqual({
			...BUILTIN.fast,
			max: 1280,
			video_codec: "libsvtav1",
		} as never);
		expect(Object.keys(profiles)).toEqual(["fast", "small", "tiny"]);
	});

	test("an unknown key names the file, the profile and the key", () => {
		expect(() =>
			mergeConfig({ profile: { fast: { image_qualty: 80 } } }, "/c/mcz.toml"),
		).toThrow(
			/\/c\/mcz\.toml: unknown key "image_qualty" in \[profile\.fast\]/,
		);
	});

	test("an unknown top-level key is an error", () => {
		expect(() => mergeConfig({ profiles: {} }, "/c/mcz.toml")).toThrow(
			/\/c\/mcz\.toml: unknown key "profiles"/,
		);
	});

	test("wrong types and ranges are errors", () => {
		const bad: [string, unknown][] = [
			["image_quality", 0],
			["image_quality", 101],
			["image_quality", 80.5],
			["image_quality", "80"],
			["image_blur", -1],
			["video_codec", ""],
			["video_codec", "lib x264"],
			["video_crf", 64],
			["video_preset", 5],
			["audio_bitrate", "loud"],
			["max", -1],
			["max", 1.5],
		];
		for (const [key, value] of bad) {
			expect(() =>
				mergeConfig({ profile: { fast: { [key]: value } } }, "m.toml"),
			).toThrow(new RegExp(`m\\.toml: profile\\.fast\\.${key} must be`));
		}
	});

	test("an empty preset is allowed", () => {
		expect(
			mergeConfig({ profile: { fast: { video_preset: "" } } }, "m.toml").fast
				?.video_preset,
		).toBe("");
	});

	test("a profile that is not a table is an error", () => {
		expect(() => mergeConfig({ profile: { fast: 3 } }, "m.toml")).toThrow(
			ConfigError,
		);
	});

	test("crf above 51 is an error for x264 and x265, also when the codec is inherited", () => {
		expect(() =>
			mergeConfig({ profile: { fast: { video_crf: 55 } } }, "m.toml"),
		).toThrow(
			"m.toml: [profile.fast] crf 55 is above 51, the most libx264 takes",
		);
		expect(() =>
			mergeConfig(
				{ profile: { x: { video_codec: "libx265", video_crf: 52 } } },
				"m.toml",
			),
		).toThrow(/libx265 takes/);
		expect(
			mergeConfig(
				{ profile: { vp9: { video_codec: "libvpx-vp9", video_crf: 60 } } },
				"m.toml",
			).vp9?.video_crf,
		).toBe(60);
	});

	test("names like constructor and __proto__ are profiles, not inherited properties", () => {
		// JSON.parse makes __proto__ an own key, the way Bun.TOML.parse does
		const doc = JSON.parse(
			'{"profile": {"__proto__": {"max": 5}, "constructor": {"max": 6}}}',
		);
		const profiles = mergeConfig(doc, "m.toml");
		expect(Object.keys(profiles)).toEqual([
			"fast",
			"small",
			"__proto__",
			"constructor",
		]);
		expect(Object.getPrototypeOf(profiles)).toBeNull();
		expect(resolveProfile(profiles, "__proto__", {}).max).toBe(5);
		expect(resolveProfile(profiles, "constructor", {}).max).toBe(6);
		expect(resolveProfile(profiles, "fast", {})).toEqual({
			...BUILTIN.fast,
		} as never);
	});
});

describe("loadConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "mcz-config-"));

	test("a missing --config file is an error", () => {
		expect(() => loadConfig(join(dir, "nope.toml"))).toThrow(
			/config file not found/,
		);
	});

	test("reads TOML", () => {
		const file = join(dir, "ok.toml");
		writeFileSync(
			file,
			'[profile.fast]\nvideo_codec = "hevc_videotoolbox"\n\n[profile.big]\nimage_quality = 95\n',
		);
		const profiles = loadConfig(file);
		expect(profiles.fast?.video_codec).toBe("hevc_videotoolbox");
		expect(profiles.big?.image_quality).toBe(95);
	});

	test("a TOML [profile.__proto__] does not reach the prototype", () => {
		const file = join(dir, "proto.toml");
		writeFileSync(file, "[profile.__proto__]\nimage_quality = 3\n");
		const profiles = loadConfig(file);
		expect(Object.hasOwn(profiles, "__proto__")).toBe(true);
		expect(profiles.fast?.image_quality).toBe(85);
	});

	test("a TOML syntax error names the file", () => {
		const file = join(dir, "broken.toml");
		// Bun's parser lets an unclosed [header at the very end of a file through,
		// so the broken line here is a key without a value
		writeFileSync(file, "[profile.fast]\nimage_quality = = 3\n");
		expect(() => loadConfig(file)).toThrow(
			new RegExp(`^${file.replaceAll(".", "\\.")}: `),
		);
	});

	test("the default path follows XDG_CONFIG_HOME", () => {
		expect(defaultConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/mcz.toml");
		expect(defaultConfigPath({ XDG_CONFIG_HOME: "" })).toEndWith(
			"/.config/mcz.toml",
		);
	});
});

describe("resolveProfile", () => {
	const profiles = mergeConfig({}, "m.toml");

	test("flags override the chosen profile", () => {
		const p = resolveProfile(profiles, "small", {
			image_quality: 50,
			max: 800,
			video_crf: undefined,
		});
		expect(p).toEqual({
			...BUILTIN.small,
			image_quality: 50,
			max: 800,
		} as never);
	});

	test("an unknown profile lists the available ones", () => {
		expect(() => resolveProfile(profiles, "tiny", {})).toThrow(
			'unknown profile "tiny" — available: fast, small',
		);
	});

	test("inherited names are unknown profiles", () => {
		for (const name of [
			"constructor",
			"toString",
			"__proto__",
			"hasOwnProperty",
		]) {
			expect(() => resolveProfile(profiles, name, {})).toThrow(
				`unknown profile "${name}"`,
			);
		}
	});

	test("a crf flag above what the codec takes is an error", () => {
		expect(() => resolveProfile(profiles, "fast", { video_crf: 55 })).toThrow(
			"crf 55 is above 51, the most libx264 takes — pass a lower --crf",
		);
		// and so is a codec flag that the profile's crf does not fit
		const vp9 = mergeConfig(
			{ profile: { vp9: { video_codec: "libvpx-vp9", video_crf: 60 } } },
			"m.toml",
		);
		expect(() =>
			resolveProfile(vp9, "vp9", { video_codec: "libx265" }),
		).toThrow(/libx265 takes/);
		expect(resolveProfile(profiles, "fast", { video_crf: 51 }).video_crf).toBe(
			51,
		);
		expect(
			resolveProfile(profiles, "fast", {
				video_codec: "libvpx-vp9",
				video_crf: 60,
			}).video_crf,
		).toBe(60);
	});

	test("crfProblem", () => {
		expect(
			crfProblem({ ...(BUILTIN.fast as Profile), video_crf: 51.5 }),
		).toMatch(/above 51/);
		expect(
			crfProblem({
				...(BUILTIN.fast as Profile),
				video_codec: "constructor",
				video_crf: 63,
			}),
		).toBeNull();
	});
});

describe("parseFlagValue", () => {
	test("converts numbers and keeps strings", () => {
		expect(parseFlagValue("image_quality", "80")).toBe(80);
		expect(parseFlagValue("video_crf", "22.5")).toBe(22.5);
		expect(parseFlagValue("audio_bitrate", "96k")).toBe("96k");
		expect(parseFlagValue("video_preset", "")).toBe("");
	});

	test("rejects what the config file would reject", () => {
		expect(() => parseFlagValue("image_quality", "abc")).toThrow(
			'must be an integer from 1 to 100, got "abc"',
		);
		expect(() => parseFlagValue("max", "")).toThrow(/must be an integer/);
		expect(() => parseFlagValue("video_crf", "70")).toThrow(/0 to 63/);
	});
});
