// The three rewrites, on Gramax's own reading of its paths
// (core/logic/RouterPath/RouterPathProvider.ts in the Gramax repository):
//
//   long   [public/] storage / group / repo / branch / catalog / ...article
//   short  [public/]           group / repo / branch / -       / ...article
//
// Every slot is one segment — a nested group or a branch with a slash comes
// encoded, dr%2Fsub, feature%2Fx, and so does a storage with a port. The
// catalog slot is "-" when the catalog is named after its repository, and the
// enterprise app recognises the short form only by that "-" in the fourth
// place (EnterpriseRouterPathEvents.ts). The enterprise app drops the storage
// when it is its own, and also reads a long link whose storage slot is "-".

export type Mode = "enterprise" | "regular" | "path";

export type Env = {
	/** GXURL_ENTERPRISE_URL: the enterprise app */
	enterprise?: string;
	/** GXURL_APP_URL: the regular app, https://app.gram.ax when unset */
	app?: string;
	/** GXURL_STORAGE: the storage the enterprise app serves */
	storage?: string;
};

export const DEFAULT_APP = "https://app.gram.ax";

export class LinkError extends Error {}

const withScheme = (s: string): string =>
	/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;

/** An app's address from the environment: an http(s) origin, nothing more. */
export function appOrigin(name: string, raw: string | undefined, flag: string): string {
	if (!raw?.trim()) throw new LinkError(`${name} is not set, so ${flag} has nowhere to point`);
	let url: URL;
	try {
		url = new URL(withScheme(raw.trim()));
	} catch {
		throw new LinkError(`${name} is not a URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new LinkError(`${name} is not http(s): ${raw}`);
	if (url.pathname !== "/" || url.search || url.hash)
		throw new LinkError(`${name} takes only the address, no path: ${raw}`);
	return url.origin;
}

/** The storage from the environment as Gramax names it: the host, with its
 *  port when there is one. A URL is taken for its host. */
export function storageHost(raw: string | undefined): string | undefined {
	const text = raw?.trim();
	if (!text) return undefined;
	let url: URL;
	try {
		url = new URL(withScheme(text));
	} catch {
		throw new LinkError(`GXURL_STORAGE is not a host: ${raw}`);
	}
	if (url.pathname !== "/" || url.search || url.hash || url.username)
		throw new LinkError(`GXURL_STORAGE takes only the host, no path: ${raw}`);
	return url.host;
}

type Parsed = {
	url: URL;
	isPublic: boolean;
	short: boolean;
	/** raw, still encoded segments of the path, "public" taken off */
	segments: string[];
};

function parse(raw: string): Parsed {
	const text = raw.trim();
	let url: URL;
	try {
		url = new URL(withScheme(text));
	} catch {
		throw new LinkError(`not a link: ${text}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new LinkError(`not an http(s) link: ${text}`);

	let segments = url.pathname.split("/").filter(Boolean);
	const isPublic = segments[0] === "public";
	if (isPublic) segments = segments.slice(1);

	// Gramax's own test for the short form: three named slots, then the "-"
	const short =
		segments.length >= 4 &&
		segments.slice(0, 3).every((s) => s !== "-") &&
		segments[3] === "-";
	if (!short && segments.length < 5)
		throw new LinkError(
			`not a link to a Gramax catalog: ${text}\n` +
				"expected <app>/<storage>/<group>/<repo>/<branch>/-/<article>",
		);
	return { url, isPublic, short, segments };
}

const build = (origin: string, p: Parsed, segments: string[]): string =>
	`${origin}/${[...(p.isPublic ? ["public"] : []), ...segments].join("/")}${p.url.search}${p.url.hash}`;

/** The same place in the enterprise app: the storage segment goes, since the
 *  enterprise app has only its own. A link already in short form keeps its
 *  path and only moves to the enterprise address. With the storage known, a
 *  link from another one is an error — the enterprise app would not open it. */
export function toEnterprise(raw: string, origin: string, storage?: string): string {
	const p = parse(raw);
	if (p.short) return build(origin, p, p.segments);
	const [source = "", ...rest] = p.segments;
	const from = decodeSegment(source);
	if (storage && from !== "-" && from.toLowerCase() !== storage.toLowerCase())
		throw new LinkError(
			`the link is from ${from}, and the enterprise app serves ${storage}: ${raw.trim()}`,
		);
	return build(origin, p, rest);
}

/** The same place in the regular app: the storage segment comes back. Only a
 *  link without one — short, or with "-" in its place — needs to know it. */
export function toRegular(raw: string, origin: string, storage?: string): string {
	const p = parse(raw);
	const [source = "", ...rest] = p.segments;
	const missing = p.short || source === "-";
	if (!missing) return build(origin, p, p.segments);
	if (!storage)
		throw new LinkError("GXURL_STORAGE is not set, so -r cannot tell which storage the link is from");
	return build(origin, p, [encodeURIComponent(storage), ...(p.short ? p.segments : rest)]);
}

/** The article's path inside the catalog, decoded: what follows the catalog
 *  slot. Without the .md and without the doc-root directory — the link does not
 *  say which file or folder holds it. */
export function toPath(raw: string): string {
	const { short, segments } = parse(raw);
	const article = segments.slice(short ? 4 : 5);
	if (article.length === 0)
		throw new LinkError(`the link opens the catalog, not an article: ${raw.trim()}`);
	return article.map(decodeSegment).join("/");
}

function decodeSegment(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

export function convert(raw: string, mode: Mode, env: Env): string {
	if (mode === "path") return toPath(raw);
	const storage = storageHost(env.storage);
	if (mode === "enterprise")
		return toEnterprise(raw, appOrigin("GXURL_ENTERPRISE_URL", env.enterprise, "-e"), storage);
	return toRegular(raw, appOrigin("GXURL_APP_URL", env.app?.trim() || DEFAULT_APP, "-r"), storage);
}

/** Two links to the same page: what a rewrite that changed nothing returns. */
export function sameLink(a: string, b: string): boolean {
	const norm = (s: string): string | null => {
		try {
			const u = new URL(withScheme(s.trim()));
			return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`;
		} catch {
			return null;
		}
	};
	const x = norm(a);
	return x !== null && x === norm(b);
}
