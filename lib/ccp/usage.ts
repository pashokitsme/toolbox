// A profile as its token sees it: which account the token belongs to, and that
// account's plan limits — how much of each window is used, and when it resets.
//
// Both come from endpoints Claude Code itself uses, authorized with the
// profile's OAuth access token: GET https://api.anthropic.com/api/oauth/profile
// for the account, /api/oauth/usage for the limits. The token lives in the
// profile's Keychain item (`Claude Code-credentials-<sha256(dir)[0..8]>`); ccp
// reads it for these requests and nothing else — it is never printed, stored,
// refreshed, or sent anywhere but api.anthropic.com. A token past its expiry is
// left alone: refreshing it rotates the refresh token, and that is Claude Code's
// job. For such a profile, and whenever a request fails, the limits fall back to
// the copy Claude Code keeps in <profile>/.claude.json (cachedUsageUtilization),
// labelled with its age.
//
// The token, not .claude.json, is the authority on the account. The file can
// name somebody else: a Claude Code session running on another account's
// credentials — the Desktop app's, say — records that account in whichever
// profile it runs in. So ccp shows the token's account and says when the file
// disagrees; the Keychain item also carries the plan the token was issued for,
// which is readable without a request and so works on expired tokens too.

import { readFileSync } from "node:fs";
import { profileConfig, profileDir } from "./paths.ts";
import { C } from "./term.ts";

const API = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 4000;

type Json = Record<string, unknown>;

export type Window = { label: string; percent: number; resetsAt?: Date };

export type Usage = {
	windows: Window[];
	/** When the numbers were taken; absent for a live answer. */
	asOf?: Date;
	/** Why the numbers are not live, when they are not. */
	note?: string;
};

export type UsageResult = Usage | { error: string };

export type Identity = { email: string; uuid: string; plan: string };

export type Inspection = {
	/** The token's account, when the token was usable and the profile request answered. */
	identity?: Identity;
	/** The plan the token was issued for, straight from the Keychain item. */
	tokenPlan?: string;
	usage: UsageResult;
};

function isObj(v: unknown): v is Json {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** "Max 5x", "Pro": the plan as Claude Code names organization types and rate-limit tiers. */
export function planName(
	organizationType: string,
	rateLimitTier: string,
): string {
	const base =
		organizationType === "claude_max"
			? "Max"
			: organizationType === "claude_pro"
				? "Pro"
				: organizationType || "?";
	const mult = /max_(\d+)x/.exec(rateLimitTier)?.[1];
	return mult ? `${base} ${mult}x` : base;
}

/** The Keychain item Claude Code uses for a config home it was started with. */
function keychainService(dir: string): string {
	const hash = new Bun.CryptoHasher("sha256")
		.update(dir.normalize("NFC"))
		.digest("hex")
		.slice(0, 8);
	return `Claude Code-credentials-${hash}`;
}

type Token = { accessToken?: string; expired: boolean; plan?: string };

function readToken(name: string): Token | undefined {
	const r = Bun.spawnSync(
		[
			"security",
			"find-generic-password",
			"-s",
			keychainService(profileDir(name)),
			"-w",
		],
		{
			stderr: "ignore",
		},
	);
	if (r.exitCode !== 0) return undefined;
	try {
		const oauth = (JSON.parse(r.stdout.toString()) as Json).claudeAiOauth;
		if (!isObj(oauth)) return undefined;
		return {
			accessToken:
				typeof oauth.accessToken === "string" ? oauth.accessToken : undefined,
			expired:
				typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now(),
			plan:
				typeof oauth.subscriptionType === "string"
					? planName(
							`claude_${oauth.subscriptionType}`,
							typeof oauth.rateLimitTier === "string"
								? oauth.rateLimitTier
								: "",
						)
					: undefined,
		};
	} catch {
		return undefined;
	}
}

/** The plan a profile's token was issued for, without a request. */
export function tokenPlan(name: string): string | undefined {
	return readToken(name)?.plan;
}

type Answer =
	| { ok: true; body: unknown }
	| { ok: false; status?: number; why: string };

async function get(path: string, token: string): Promise<Answer> {
	try {
		const res = await fetch(`${API}${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": OAUTH_BETA,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok)
			return { ok: false, status: res.status, why: `HTTP ${res.status}` };
		return { ok: true, body: await res.json() };
	} catch (err) {
		return {
			ok: false,
			why:
				err instanceof Error && err.name === "TimeoutError"
					? "timed out"
					: "failed — offline?",
		};
	}
}

function toIdentity(body: unknown): Identity | undefined {
	if (!isObj(body) || !isObj(body.account) || !isObj(body.organization))
		return undefined;
	const { email, uuid } = body.account;
	if (typeof email !== "string" || typeof uuid !== "string") return undefined;
	const { organization_type, rate_limit_tier } = body.organization;
	return {
		email,
		uuid,
		plan: planName(
			typeof organization_type === "string" ? organization_type : "",
			typeof rate_limit_tier === "string" ? rate_limit_tier : "",
		),
	};
}

function toDate(v: unknown): Date | undefined {
	if (typeof v !== "string") return undefined;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The `limits` list of a live answer: every window the plan has, per-model weekly ones included. */
function fromLimits(limits: unknown): Window[] | undefined {
	if (!Array.isArray(limits)) return undefined;
	const out: Window[] = [];
	for (const l of limits) {
		if (!isObj(l) || typeof l.percent !== "number") continue;
		const model =
			isObj(l.scope) &&
			isObj(l.scope.model) &&
			typeof l.scope.model.display_name === "string"
				? l.scope.model.display_name
				: undefined;
		if (model && l.percent === 0) continue; // a per-model week nobody has touched is noise
		const label =
			l.kind === "session"
				? "5 h"
				: l.group === "weekly"
					? model
						? `week · ${model}`
						: "week"
					: String(l.kind);
		out.push({ label, percent: l.percent, resetsAt: toDate(l.resets_at) });
	}
	return out.length ? out : undefined;
}

/** The per-window shape: the fallback for a live answer, and the only one Claude Code caches. */
function fromWindows(u: unknown): Window[] {
	if (!isObj(u)) return [];
	const out: Window[] = [];
	const known = [
		["five_hour", "5 h"],
		["seven_day", "week"],
		["seven_day_opus", "week · Opus"],
		["seven_day_sonnet", "week · Sonnet"],
	] as const;
	for (const [key, label] of known) {
		const w = u[key];
		if (!isObj(w) || typeof w.utilization !== "number") continue;
		if (key !== "five_hour" && key !== "seven_day" && w.utilization === 0)
			continue;
		out.push({ label, percent: w.utilization, resetsAt: toDate(w.resets_at) });
	}
	return out;
}

function fromCache(
	name: string,
	accountUuid: string | undefined,
	note: string,
): Usage | undefined {
	let config: Json;
	try {
		config = JSON.parse(readFileSync(profileConfig(name), "utf8")) as Json;
	} catch {
		return undefined;
	}
	const cached = config.cachedUsageUtilization;
	if (!isObj(cached) || typeof cached.fetchedAtMs !== "number")
		return undefined;
	// Claude Code keys the copy to the account that fetched it; another account's copy says nothing about this one.
	if (
		accountUuid &&
		typeof cached.accountUuid === "string" &&
		cached.accountUuid !== accountUuid
	)
		return undefined;
	const windows = fromWindows(cached.utilization);
	return windows.length
		? { windows, asOf: new Date(cached.fetchedAtMs), note }
		: undefined;
}

/**
 * Look at a profile through its token: the account and the limits, requested
 * together. `fileAccountUuid` is what .claude.json claims — used to pick the
 * cached limits only when the token cannot say whose they should be.
 */
export async function inspect(
	name: string,
	fileAccountUuid: string | undefined,
): Promise<Inspection> {
	const renew = `start claude on ${name} to renew it`;
	const orCache = (uuid: string | undefined, why: string): UsageResult =>
		fromCache(name, uuid, why) ?? { error: why };

	const token = readToken(name);
	if (!token?.accessToken)
		return {
			usage: orCache(
				fileAccountUuid,
				`no token in the Keychain — \`ccp use ${name}\` then /login`,
			),
		};
	if (token.expired)
		return {
			tokenPlan: token.plan,
			usage: orCache(fileAccountUuid, `token expired — ${renew}`),
		};

	const [profile, usage] = await Promise.all([
		get("/api/oauth/profile", token.accessToken),
		get("/api/oauth/usage", token.accessToken),
	]);
	const identity = profile.ok ? toIdentity(profile.body) : undefined;
	const uuid = identity?.uuid ?? fileAccountUuid;

	if (!usage.ok) {
		const why =
			usage.status === 401
				? `token rejected — ${renew}`
				: `usage request ${usage.why}`;
		return { identity, tokenPlan: token.plan, usage: orCache(uuid, why) };
	}
	const windows = isObj(usage.body)
		? (fromLimits(usage.body.limits) ?? fromWindows(usage.body))
		: [];
	return {
		identity,
		tokenPlan: token.plan,
		usage: windows.length
			? { windows }
			: orCache(uuid, "the usage answer held no limits"),
	};
}

const WHEN = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
});

function span(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;
	if (d) return `${d} d${h ? ` ${h} h` : ""}`;
	if (h) return `${h} h${m ? ` ${m} min` : ""}`;
	return m < 1 ? "<1 min" : `${m} min`;
}

/** Lines for one profile's limits, without indentation. */
export function formatUsage(u: UsageResult, now = Date.now()): string[] {
	if ("error" in u) return [C.yellow(`limits unavailable: ${u.error}`)];
	const width = Math.max(...u.windows.map((w) => w.label.length));
	const lines: string[] = [];
	if (u.asOf)
		lines.push(
			C.dim(`limits as of ${span(now - u.asOf.getTime())} ago (${u.note})`),
		);
	for (const w of u.windows) {
		const label = w.label.padEnd(width);
		// A cached window whose reset has passed was emptied since; its old number would mislead.
		if (u.asOf && w.resetsAt && w.resetsAt.getTime() <= now) {
			lines.push(`${label}  ${C.dim("has reset since — no newer numbers")}`);
			continue;
		}
		const used = Math.min(100, Math.max(0, Math.round(w.percent)));
		const tint = used >= 90 ? C.red : used >= 70 ? C.yellow : C.green;
		const reset = w.resetsAt
			? w.resetsAt.getTime() > now
				? `resets ${WHEN.format(w.resetsAt)} (in ${span(w.resetsAt.getTime() - now)})`
				: `reset ${WHEN.format(w.resetsAt)}`
			: "no reset scheduled";
		lines.push(
			`${label}  ${tint(`${String(used).padStart(3)}% used`)} · ${String(100 - used).padStart(3)}% left · ${C.dim(reset)}`,
		);
	}
	return lines;
}

type FileAccount = { email: string; uuid: string; plan: string } | undefined;

/** Warnings for a profile whose .claude.json names another account than its token. */
export function accountNotes(file: FileAccount, view: Inspection): string[] {
	if (!file) return [];
	const fix =
		"/login there rewrites it, and so does Claude Code's own next refresh of the account";
	if (view.identity && view.identity.uuid !== file.uuid)
		return [
			C.yellow(
				`config still names ${file.email} (${file.plan}) — stale; ${fix}`,
			),
		];
	if (!view.identity && view.tokenPlan && view.tokenPlan !== file.plan)
		return [
			C.yellow(
				`config names ${file.email} (${file.plan}), but the token is for a ${view.tokenPlan} plan — the config is stale`,
			),
		];
	return [];
}

/** The account to show for a profile: the token's when known, the file's unless the token contradicts it. */
export function trustedAccount(
	file: FileAccount,
	view: Inspection | undefined,
): FileAccount {
	if (view?.identity) return view.identity;
	if (file && view?.tokenPlan && view.tokenPlan !== file.plan) return undefined;
	return file;
}
