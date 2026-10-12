// The two rewrites, on Gramax's own reading of its paths
// (core/logic/RouterPath/RouterPathProvider.ts in the Gramax repository):
//
//   long   [public/] source / group / repo / branch / catalog / ...article
//   short  [public/]          group / repo / branch / -       / ...article
//
// Every slot is one segment — a nested group or a branch with a slash comes
// encoded, dr%2Fsub, feature%2Fx. The catalog slot is "-" when the catalog is
// named after its repository, and the enterprise app recognises the short form
// only by that "-" in the fourth place (EnterpriseRouterPathEvents.ts).

export type Mode = "enterprise" | "path";

export class LinkError extends Error {}

/** The enterprise app's address from the environment: an http(s) origin. */
export function enterpriseOrigin(raw: string | undefined): string {
	if (!raw?.trim())
		throw new LinkError("GXURL_ENTERPRISE_URL is not set, so -e has nowhere to point");
	let url: URL;
	try {
		url = new URL(withScheme(raw.trim()));
	} catch {
		throw new LinkError(`GXURL_ENTERPRISE_URL is not a URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new LinkError(`GXURL_ENTERPRISE_URL is not http(s): ${raw}`);
	if (url.pathname !== "/" || url.search || url.hash)
		throw new LinkError(`GXURL_ENTERPRISE_URL takes only the address, no path: ${raw}`);
	return url.origin;
}

const withScheme = (s: string): string =>
	/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;

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

/** The same place in the enterprise app: the storage segment goes, since the
 *  enterprise app has only its own. A link already in short form keeps its
 *  path and only moves to the enterprise address. */
export function toEnterprise(raw: string, origin: string): string {
	const { url, isPublic, short, segments } = parse(raw);
	const rest = short ? segments : segments.slice(1);
	const path = [...(isPublic ? ["public"] : []), ...rest].join("/");
	return `${origin}/${path}${url.search}${url.hash}`;
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

export function convert(raw: string, mode: Mode, env: string | undefined): string {
	return mode === "path" ? toPath(raw) : toEnterprise(raw, enterpriseOrigin(env));
}
