// What ⌘C and ⌘⇧C put on the clipboard. The rich link pastes as the merge
// request's title in chats and documents, and as "title — url" in plain text —
// the same pair `glmr -y` copies.

export type RichLink = { html: string; text: string };

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

export function richLink(title: string, url: string): RichLink {
	return {
		html: `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`,
		text: `${title} — ${url}`,
	};
}

export function markdownLink(title: string, url: string): string {
	return `[${title.replace(/[\\[\]]/g, "\\$&")}](${url})`;
}
