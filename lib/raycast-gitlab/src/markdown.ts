// Merge request descriptions link to their attachments and to other GitLab
// pages by path. Raycast renders markdown with no base url, so every such path
// is made whole here. Attachments of a private project still will not load —
// they need the browser's session — and show as their alt text.

const KEEP = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

// fenced blocks (closed or running to the end) and inline code spans are shown
// as written, so nothing inside them is rewritten
const CODE =
	/(?<=^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[`~]*[ \t]*(?=\n|$)|$)|(`+)[^`\n]+\2/g;

export function absolutizeMarkdown(
	markdown: string,
	origin: string,
	projectWebUrl: string,
): string {
	const resolve = (target: string): string => {
		if (KEEP.test(target)) return target;
		if (/^\/?uploads\//.test(target))
			return `${projectWebUrl}/${target.replace(/^\//, "")}`;
		if (target.startsWith("/")) return `${origin}${target}`;
		return target;
	};
	const rewrite = (text: string): string =>
		text
			.replace(
				/(\]\([ \t]*)([^)\s]+)/g,
				(_match, open: string, target: string) => `${open}${resolve(target)}`,
			)
			.replace(
				/^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/gm,
				(_match, open: string, target: string) => `${open}${resolve(target)}`,
			)
			.replace(
				/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi,
				(_match, open: string, quote: string, target: string) =>
					`${open}${quote}${resolve(target)}${quote}`,
			);

	let result = "";
	let last = 0;
	for (const code of markdown.matchAll(CODE)) {
		result += rewrite(markdown.slice(last, code.index)) + code[0];
		last = code.index + code[0].length;
	}
	return result + rewrite(markdown.slice(last));
}
