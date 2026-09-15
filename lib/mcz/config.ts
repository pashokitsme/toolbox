// Profiles: the two built in, what a config file changes about them, and the
// command-line flags on top. Every key is checked by one table, so the config
// file and the flags turn down the same bad values with the same words.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = {
	image_quality: number;
	image_blur: number;
	video_codec: string;
	video_crf: number;
	video_preset: string;
	audio_bitrate: string;
	max: number;
};

export type ProfileKey = keyof Profile;

const FAST: Profile = {
	image_quality: 85,
	image_blur: 0.05,
	video_codec: "libx264",
	video_crf: 23,
	video_preset: "fast",
	audio_bitrate: "128k",
	max: 0,
};

const SMALL: Profile = {
	image_quality: 72,
	image_blur: 0.05,
	video_codec: "libx265",
	video_crf: 28,
	video_preset: "medium",
	audio_bitrate: "96k",
	max: 0,
};

export const BUILTIN: Readonly<Record<string, Readonly<Profile>>> = {
	fast: FAST,
	small: SMALL,
};

export const DEFAULT_PROFILE = "fast";

export class ConfigError extends Error {}

/** null when the value is fine, otherwise what it should have been. */
type Check = (value: unknown) => string | null;

const isNumber = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

const CHECKS: Record<ProfileKey, Check> = {
	image_quality: (v) =>
		isNumber(v) && Number.isInteger(v) && v >= 1 && v <= 100
			? null
			: "an integer from 1 to 100",
	image_blur: (v) =>
		isNumber(v) && v >= 0 && v <= 10 ? null : "a number from 0 to 10",
	video_codec: (v) =>
		typeof v === "string" && /^[\w.-]+$/.test(v)
			? null
			: "an ffmpeg video encoder name, such as libx264",
	video_crf: (v) =>
		isNumber(v) && v >= 0 && v <= 63 ? null : "a number from 0 to 63",
	video_preset: (v) =>
		typeof v === "string" && /^[\w.-]*$/.test(v)
			? null
			: 'a preset name, or "" for none',
	audio_bitrate: (v) =>
		typeof v === "string" && /^\d+(?:\.\d+)?[kKmM]?$/.test(v)
			? null
			: "a bitrate such as 128k",
	max: (v) =>
		isNumber(v) && Number.isInteger(v) && v >= 0
			? null
			: "an integer, 0 or more",
};

const NUMERIC = new Set<ProfileKey>([
	"image_quality",
	"image_blur",
	"video_crf",
	"max",
]);

const isProfileKey = (key: string): key is ProfileKey =>
	Object.hasOwn(CHECKS, key);

const isTable = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" &&
	v !== null &&
	!Array.isArray(v) &&
	!(v instanceof Date);

/** Encoders whose crf scale ends below the 63 the others take. */
const CRF_LIMITS: Record<string, number> = { libx264: 51, libx265: 51 };

/** What is wrong with a profile's crf for its encoder, if anything. The key
 *  checks above cannot see this: it takes two keys, and either one may come
 *  from a different place than the other. */
export function crfProblem(profile: Profile): string | null {
	if (!Object.hasOwn(CRF_LIMITS, profile.video_codec)) return null;
	const limit = CRF_LIMITS[profile.video_codec] as number;
	return profile.video_crf > limit
		? `crf ${profile.video_crf} is above ${limit}, the most ${profile.video_codec} takes`
		: null;
}

export const defaultConfigPath = (
	env: Record<string, string | undefined> = process.env,
): string =>
	join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mcz.toml");

/** The built-in profiles with a parsed config document laid over them: keys a
 *  table names replace the built-in ones, keys it leaves out stay, and a name
 *  that is not built in starts from fast. `source` names the file in errors,
 *  because a typo in a key should say where to look instead of being ignored.
 *  The result has no prototype, so a profile named constructor or __proto__ is
 *  just a name — never something every object already has. */
export function mergeConfig(
	doc: Record<string, unknown>,
	source: string,
): Record<string, Profile> {
	const profiles: Record<string, Profile> = Object.create(null);
	for (const [name, profile] of Object.entries(BUILTIN))
		profiles[name] = { ...profile };

	for (const [key, value] of Object.entries(doc)) {
		if (key !== "profile") {
			throw new ConfigError(
				`${source}: unknown key "${key}" — only [profile.NAME] tables belong in this file`,
			);
		}
		if (!isTable(value))
			throw new ConfigError(
				`${source}: "profile" must be a set of [profile.NAME] tables`,
			);

		for (const [name, table] of Object.entries(value)) {
			if (!isTable(table))
				throw new ConfigError(`${source}: profile.${name} must be a table`);
			const start = Object.hasOwn(profiles, name)
				? (profiles[name] as Profile)
				: FAST;
			const profile: Record<string, unknown> = { ...start };
			for (const [k, v] of Object.entries(table)) {
				if (!isProfileKey(k)) {
					throw new ConfigError(
						`${source}: unknown key "${k}" in [profile.${name}] — known keys: ${Object.keys(CHECKS).join(", ")}`,
					);
				}
				const wrong = CHECKS[k](v);
				if (wrong)
					throw new ConfigError(
						`${source}: profile.${name}.${k} must be ${wrong}`,
					);
				profile[k] = v;
			}
			const problem = crfProblem(profile as Profile);
			if (problem)
				throw new ConfigError(`${source}: [profile.${name}] ${problem}`);
			// a plain assignment of "__proto__" would replace the prototype instead
			Object.defineProperty(profiles, name, {
				value: profile,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return profiles;
}

/** Reads the profiles. The default file is optional — without it the built-ins
 *  apply — but a file named with --config has to be there. */
export function loadConfig(path?: string): Record<string, Profile> {
	const file = path ?? defaultConfigPath();
	if (!existsSync(file)) {
		if (path !== undefined)
			throw new ConfigError(`config file not found: ${file}`);
		return mergeConfig({}, file);
	}

	let doc: unknown;
	try {
		doc = Bun.TOML.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new ConfigError(`${file}: ${(err as Error).message}`);
	}
	if (!isTable(doc)) throw new ConfigError(`${file}: not a TOML document`);
	return mergeConfig(doc, file);
}

/** The chosen profile with the command-line flags on top. Every profile was
 *  checked as it was loaded, so a problem found here comes from the flags. */
export function resolveProfile(
	profiles: Record<string, Profile>,
	name: string,
	overrides: Partial<Profile>,
): Profile {
	if (!Object.hasOwn(profiles, name)) {
		throw new ConfigError(
			`unknown profile "${name}" — available: ${Object.keys(profiles).join(", ")}`,
		);
	}
	const profile: Record<string, unknown> = { ...profiles[name] };
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) profile[key] = value;
	}
	const problem = crfProblem(profile as Profile);
	if (problem) throw new ConfigError(`${problem} — pass a lower --crf`);
	return profile as Profile;
}

/** A flag's value, converted and checked the way the same key in the config
 *  file would be. The message is meant to follow the flag's name. */
export function parseFlagValue(key: ProfileKey, raw: string): string | number {
	const value = NUMERIC.has(key)
		? raw.trim() === ""
			? Number.NaN
			: Number(raw)
		: raw;
	const wrong = CHECKS[key](value);
	if (wrong) throw new ConfigError(`must be ${wrong}, got "${raw}"`);
	return value;
}
