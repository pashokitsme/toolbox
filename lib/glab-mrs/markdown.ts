// A small markdown-to-ANSI renderer: enough of CommonMark to read a merge
// request description comfortably, plus image nodes the caller can draw.

import { C, displayWidth, truncateToWidth } from "./term.ts";

export type MdRow = { kind: "text"; text: string } | { kind: "image"; url: string; alt: string };

type Segment = { text: string; style: string };

const styled = (style: string, text: string) => (style ? `${style}${text}${C.reset}` : text);

// ------------------------------------------------------------------- inline

const INLINE_RE = new RegExp(
	[
		"(?<code>`+[^`]+`+)",
		'(?<image>!\\[[^\\]]*\\]\\([^)\\s]+(?:\\s+"[^"]*")?\\))',
		'(?<link>\\[[^\\]]*\\]\\([^)\\s]+(?:\\s+"[^"]*")?\\))',
		"(?<bold>\\*\\*[^*]+\\*\\*|__[^_]+__)",
		"(?<strike>~~[^~]+~~)",
		"(?<italic>\\*[^*\\s][^*]*\\*|(?<=^|[\\s(])_[^_\\s][^_]*_(?=$|[\\s.,;:)!?]))",
		"(?<auto><?https?://[^\\s<>)\\]]+>?)",
	].join("|"),
	"g",
);

/** Splits inline markdown into styled segments (word-wrapping happens later). */
function inlineSegments(src: string, base = ""): Segment[] {
	const out: Segment[] = [];
	let last = 0;

	for (const m of src.matchAll(INLINE_RE)) {
		const g = m.groups ?? {};
		if (m.index > last) out.push({ text: src.slice(last, m.index), style: base });
		last = m.index + m[0].length;

		if (g.code) {
			out.push({ text: g.code.replace(/^`+|`+$/g, ""), style: C.cyan });
		} else if (g.image) {
			const alt = /^!\[([^\]]*)\]/.exec(g.image)?.[1] ?? "";
			out.push({ text: `🖼 ${alt || "image"}`, style: C.magenta });
		} else if (g.link) {
			const text = /^\[([^\]]*)\]/.exec(g.link)?.[1] ?? "";
			const url = /\(([^)\s]+)/.exec(g.link)?.[1] ?? "";
			out.push({ text: text || url, style: `${C.blue}${C.underline}` });
		} else if (g.bold) {
			out.push({ text: g.bold.slice(2, -2), style: `${base}${C.bold}` });
		} else if (g.strike) {
			out.push({ text: g.strike.slice(2, -2), style: `${base}${C.strike}` });
		} else if (g.italic) {
			out.push({ text: g.italic.slice(1, -1), style: `${base}${C.italic}` });
		} else if (g.auto) {
			out.push({ text: g.auto.replace(/^<|>$/g, ""), style: `${C.blue}${C.underline}` });
		}
	}

	if (last < src.length) out.push({ text: src.slice(last), style: base });
	return out;
}

function wrapSegments(segments: Segment[], width: number, indent = "", hangIndent = ""): string[] {
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	let prefix = indent;
	const avail = () => Math.max(8, width - displayWidth(prefix));

	const flush = () => {
		lines.push(prefix + line);
		prefix = hangIndent || indent;
		line = "";
		lineWidth = 0;
	};

	for (const seg of segments) {
		// keep the whitespace structure, break on spaces only
		const parts = seg.text.split(/(\s+)/).filter((p) => p !== "");
		for (const part of parts) {
			if (/^\s+$/.test(part)) {
				if (part.includes("\n")) {
					if (line) flush();
					continue;
				}
				if (lineWidth > 0 && lineWidth < avail()) {
					line += styled(seg.style, " ");
					lineWidth += 1;
				}
				continue;
			}

			let word = part;
			while (displayWidth(word) > avail()) {
				// a single word longer than the line (a URL, usually)
				const head = truncateToWidth(word, avail(), "");
				const headPlain = head.replace(/\x1b\[[0-9;]*m/g, "");
				if (line) flush();
				lines.push(prefix + styled(seg.style, headPlain));
				prefix = hangIndent || indent;
				word = word.slice(headPlain.length);
			}

			const w = displayWidth(word);
			if (lineWidth + w > avail() && lineWidth > 0) flush();
			line += styled(seg.style, word);
			lineWidth += w;
		}
	}

	if (line) lines.push(prefix + line);
	return lines.length > 0 ? lines : [""];
}

const text = (s: string): MdRow => ({ kind: "text", text: s });

// ------------------------------------------------------------------- blocks

let batChecked = false;
let batPath: string | null = null;

function highlight(code: string, lang: string): string[] {
	if (!batChecked) {
		batChecked = true;
		const which = Bun.spawnSync(["which", "bat"]);
		batPath = which.exitCode === 0 ? which.stdout.toString().trim() : null;
	}
	if (!batPath) return code.split("\n").map((l) => `${C.gray}${l}${C.reset}`);

	const args = [batPath, "--color=always", "--style=plain", "--paging=never"];
	if (lang) args.push(`--language=${lang}`);
	const out = Bun.spawnSync(args, { stdin: new TextEncoder().encode(code) });
	if (out.exitCode !== 0) return code.split("\n").map((l) => `${C.gray}${l}${C.reset}`);
	return out.stdout.toString().replace(/\n$/, "").split("\n");
}

const IMAGE_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;
const HTML_IMG_RE = /^<img[^>]*\ssrc=["']([^"']+)["'][^>]*>$/i;

function tableRow(line: string): string[] | null {
	if (!line.trim().startsWith("|")) return null;
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());
}

const plain = (s: string): string =>
	inlineSegments(s)
		.map((seg) => seg.text)
		.join("");

export function renderMarkdown(md: string, width: number): MdRow[] {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const rows: MdRow[] = [];
	let i = 0;

	const pushBlank = () => {
		if (rows.length > 0 && !(rows.at(-1) as { kind: string; text?: string }).text?.match(/^$/)) rows.push(text(""));
	};

	while (i < lines.length) {
		const line = lines[i] as string;
		const trimmed = line.trim();

		if (trimmed === "") {
			pushBlank();
			i += 1;
			continue;
		}

		// fenced code
		const fence = /^(```|~~~)\s*([\w+-]*)/.exec(trimmed);
		if (fence) {
			const marker = fence[1] as string;
			const lang = fence[2] ?? "";
			const body: string[] = [];
			i += 1;
			while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) {
				body.push(lines[i] as string);
				i += 1;
			}
			i += 1;
			for (const hl of highlight(body.join("\n"), lang)) {
				rows.push(text(`${C.gray}│${C.reset} ${truncateToWidth(hl, width - 2)}`));
			}
			pushBlank();
			continue;
		}

		// heading
		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			const level = (heading[1] as string).length;
			const color = level === 1 ? C.brightYellow : level === 2 ? C.yellow : C.brightCyan;
			const body = plain(heading[2] as string);
			i += 1;
			rows.push(text(`${C.bold}${color}${body}${C.reset}`));
			if (level <= 2) rows.push(text(`${C.gray}${"─".repeat(Math.min(width, displayWidth(body)))}${C.reset}`));
			continue;
		}

		// thematic break
		if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
			rows.push(text(`${C.gray}${"─".repeat(width)}${C.reset}`));
			i += 1;
			continue;
		}

		// standalone image
		const img = IMAGE_ONLY_RE.exec(trimmed) ?? null;
		const htmlImg = HTML_IMG_RE.exec(trimmed) ?? null;
		if (img || htmlImg) {
			rows.push({
				kind: "image",
				alt: img ? (img[1] as string) : "",
				url: img ? (img[2] as string) : (htmlImg?.[1] as string),
			});
			i += 1;
			continue;
		}

		// table
		const header = tableRow(line);
		const sep = i + 1 < lines.length ? tableRow(lines[i + 1] as string) : null;
		if (header && sep && sep.every((c) => /^:?-{2,}:?$/.test(c))) {
			const body: string[][] = [];
			i += 2;
			while (i < lines.length) {
				const r = tableRow(lines[i] as string);
				if (!r) break;
				body.push(r);
				i += 1;
			}
			const cols = header.length;
			const widths = header.map((h, c) =>
				Math.max(displayWidth(plain(h)), ...body.map((r) => displayWidth(plain(r[c] ?? "")))),
			);
			const total = widths.reduce((a, b) => a + b, 0) + 3 * cols;
			if (total > width) {
				const scale = (width - 3 * cols) / Math.max(1, total - 3 * cols);
				for (let c = 0; c < cols; c += 1) widths[c] = Math.max(4, Math.floor((widths[c] as number) * scale));
			}
			const row = (cells: string[], style: string) =>
				cells
					.map((cell, c) => {
						const w = widths[c] ?? 8;
						const t = truncateToWidth(plain(cell), w);
						return `${style}${t}${C.reset}${" ".repeat(Math.max(0, w - displayWidth(t)))}`;
					})
					.join(`${C.gray} │ ${C.reset}`);
			rows.push(text(row(header, C.bold)));
			rows.push(text(`${C.gray}${widths.map((w) => "─".repeat(w)).join("─┼─")}${C.reset}`));
			for (const r of body) rows.push(text(row(r, "")));
			pushBlank();
			continue;
		}

		// blockquote
		if (trimmed.startsWith(">")) {
			const body: string[] = [];
			while (i < lines.length && (lines[i] as string).trim().startsWith(">")) {
				body.push((lines[i] as string).trim().replace(/^>\s?/, ""));
				i += 1;
			}
			for (const l of wrapSegments(inlineSegments(body.join(" "), C.dim), width - 2)) {
				rows.push(text(`${C.gray}▏${C.reset} ${l}`));
			}
			pushBlank();
			continue;
		}

		// list item
		const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (item) {
			const depth = Math.floor((item[1] as string).length / 2);
			const bullet = /^\d/.test(item[2] as string) ? (item[2] as string) : "•";
			const indent = "  ".repeat(depth);
			const body = [item[3] as string];
			i += 1;
			// continuation lines of the same item
			while (i < lines.length) {
				const next = lines[i] as string;
				if (next.trim() === "" || /^(\s*)([-*+]|\d+[.)])\s+/.test(next) || /^#{1,6}\s/.test(next.trim())) break;
				body.push(next.trim());
				i += 1;
			}
			const head = `${indent}${C.yellow}${bullet}${C.reset} `;
			const wrapped = wrapSegments(
				inlineSegments(body.join(" ")),
				width,
				head,
				`${indent}${" ".repeat(displayWidth(bullet) + 1)}`,
			);
			for (const l of wrapped) rows.push(text(l));
			continue;
		}

		// paragraph
		const para: string[] = [];
		while (i < lines.length) {
			const l = lines[i] as string;
			if (
				l.trim() === "" ||
				/^(#{1,6}\s|>|```|~~~)/.test(l.trim()) ||
				/^(\s*)([-*+]|\d+[.)])\s+/.test(l) ||
				IMAGE_ONLY_RE.test(l.trim())
			)
				break;
			para.push(l.trim());
			i += 1;
		}
		for (const l of wrapSegments(inlineSegments(para.join(" ")), width)) rows.push(text(l));
		pushBlank();
	}

	while (rows.length > 0 && (rows.at(-1) as { kind: string; text?: string }).text === "") rows.pop();
	return rows;
}
