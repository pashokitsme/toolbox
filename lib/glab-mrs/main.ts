#!/usr/bin/env bun
// glab-mrs — an interactive merge request and pipeline browser on top of glab.
// Also installed as `glmr`.
//
// Without a merge request the arguments go straight through to `glab mr list`:
//   glab-mrs --author @me
//   glab-mrs --all --search openapi -P 100
//   glab-mrs -R ics/doc-reader --reviewer @me
//
// With one it opens that merge request, from any directory:
//   glmr https://gitlab.example.com/group/project/-/merge_requests/3614
//   glmr 3614            (or !3614 — the repository of the current directory)
//   glmr -y 3614         copy the link and exit, no screen at all

import {
	cancelJob,
	cancelPipeline,
	copyRichLink,
	copyText,
	fetchMR,
	type Job,
	jobTrace,
	listMRs,
	type MR,
	mrPipelines,
	openInBrowser,
	parseMRRef,
	type Pipeline,
	pipelineForSha,
	pipelineJobs,
	type PipelineState,
	pipelineState,
	playJob,
	recentPipelines,
	retryJob,
	retryPipeline,
	tokenFor,
} from "./glab.ts";
import {
	clearImages,
	detectProtocol,
	type ImageData,
	imageCells,
	loadImage,
	type Protocol,
	renderImage,
} from "./images.ts";
import { type MdRow, renderMarkdown } from "./markdown.ts";
import {
	AltScreen,
	C,
	decodeKeys,
	disableKittyKeys,
	enableKittyKeys,
	displayWidth,
	fitTo,
	hideCursor,
	type Key,
	type Row,
	showCursor,
	stripAnsi,
	truncateToWidth,
	wrapAnsi,
} from "./term.ts";

// The command line is only worth reading before the screen is up, so --help
// prints USAGE and KEYS while the "?" screen shows KEYS alone — every line it
// does not spend is a line of keys that survives a short terminal, which
// truncates the help rather than scrolling it.
const USAGE = `glab-mrs — interactive merge request and pipeline browser
also installed as glmr

usage: glab-mrs [-y|-Y] [merge request] [glab mr list flags...]

  glab-mrs --author @me
  glab-mrs --all --search openapi -P 100
  glab-mrs -R ics/doc-reader --reviewer @me

The one argument that is not a flag is a merge request, and it opens instead of
a list. It is either a link, which carries its own host and works from any
directory, or a number, which means that merge request in -R, or in the
repository of the current directory.

  glmr https://gitlab.example.com/group/project/-/merge_requests/3614
  glmr 3614
  glmr '!3614'
  glmr -R ics/doc-reader 3614
  glmr -R https://gitlab.example.com/group/project 3614  (outside a repository)

A merge request of its own leaves nothing for the list flags to do, so they are
ignored — except -R, which says where a number lives.

  -y, --copy            copy the link and exit, without opening anything
  -Y, --copy-markdown   the same as [title](url)

The link is the rich kind: it pastes into a chat or a document as the title of
the merge request, and into a plain-text field as "title — url". These are the
y and Y of the screen, so -y and -Y are the same keys from the shell.
`;

const KEYS = `Letters are commands, so filtering lives behind "/" (the same physical key types
"." on ЙЦУКЕН, which works too). Arrows work everywhere, h/j/k/l do the same
thing, and nothing needs ctrl or cmd.

Commands follow the physical key, not the character it types, so they keep
working with a Cyrillic layout on: о is j, з is p, р is h, й is q. Terminals
that speak the kitty keyboard protocol report the real base-layout key, so
every other layout works there as well.

merge requests
  j k  up down      move                 / filter          esc leave the filter
  l  right  enter   open the request     o open in browser
  p                 pipeline and jobs    y copy link       Y copy as markdown
  u                 reload               ? this help       q quit

merge request
  j k  up down      scroll               space page down   g G  top bottom
  h  left  esc  q   back, and quit when the request came from the command line
  o open in browser
  p                 pipeline and jobs    y copy link       Y copy as markdown

pipeline jobs
  j k  up down      move                 l right enter  job log
  r                 retry the job        R retry the whole pipeline
  x                 cancel the job       X cancel the whole pipeline
  s                 start a manual job   u refresh (auto every 5s while running)
  o                 job in browser       O pipeline in browser
  h  left  esc  q   back

job log
  j k  up down      scroll               space page down   g G  top bottom
  u                 refresh              o open in browser
  h  left  esc  q   back

the dot in front of a merge request is its latest pipeline
  ● cyan running    ● green passed       ● red failed
  ● gray canceled   ○ dim no pipeline
the merge request number is colored by state: open, merged, closed

env
  GLAB_MRS_IMAGES=off       do not draw images
  GLAB_MRS_IMAGE_PROTOCOL   kitty | iterm | none (autodetected)
`;

const HELP = `${USAGE}\n${KEYS}`;

// ------------------------------------------------------------------ filtering

/** fzf-ish: every space-separated term must appear as a subsequence. */
function fuzzyScore(haystack: string, query: string): number | null {
	if (!query) return 0;
	const hay = haystack.toLowerCase();
	let total = 0;

	for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
		let idx = 0;
		let first = -1;
		let streak = 0;
		let best = 0;
		for (const ch of term) {
			const found = hay.indexOf(ch, idx);
			if (found === -1) return null;
			if (first === -1) first = found;
			streak = found === idx ? streak + 1 : 1;
			best = Math.max(best, streak);
			idx = found + 1;
		}
		total += best * 4 - first * 0.05 - (idx - first);
	}
	return total;
}

const haystackOf = (mr: MR): string =>
	[
		`!${mr.iid}`,
		mr.title,
		mr.author,
		mr.sourceBranch,
		mr.targetBranch,
		mr.labels.join(" "),
	].join(" ");

// -------------------------------------------------------------------- render

/** The dot shows the pipeline, the merge request number shows its state. */
const pipelineGlyph = (state: PipelineState | undefined): string => {
	switch (state) {
		case "running":
			return `${C.brightCyan}●${C.reset}`;
		case "success":
			return `${C.green}●${C.reset}`;
		case "failed":
			return `${C.red}●${C.reset}`;
		case "other":
			return `${C.gray}●${C.reset}`;
		case "none":
			return `${C.gray}${C.dim}○${C.reset}`;
		default:
			return `${C.gray}${C.dim}·${C.reset}`; // still being looked up
	}
};

const jobColor = (status: string): string => {
	switch (status) {
		case "success":
			return C.green;
		case "failed":
			return C.red;
		case "running":
			return C.brightCyan;
		case "pending":
		case "created":
		case "waiting_for_resource":
		case "preparing":
		case "scheduled":
			return C.yellow;
		case "manual":
			return C.magenta;
		default:
			return C.gray; // canceled, skipped
	}
};

const jobGlyph = (status: string): string => {
	const glyph =
		status === "manual"
			? "◌"
			: status === "skipped"
				? "○"
				: status === "canceled"
					? "◍"
					: "●";
	return `${jobColor(status)}${glyph}${C.reset}`;
};

const stateColor = (mr: MR): string =>
	mr.state === "merged"
		? C.brightBlue
		: mr.state === "closed"
			? C.red
			: C.yellow;

const shortDate = (iso: string): string =>
	iso.length >= 10 ? iso.slice(5, 10) : "     ";

function duration(seconds: number | null): string {
	if (seconds === null) return "";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/** One merge request as a row. The marker is what changes between the places
 *  it is used: the cursor on the list, a green check on the way out of --copy,
 *  which is the whole reason this is not just listLine. */
function mrRow(
	mr: MR,
	pipeline: PipelineState | undefined,
	marker: string,
	bold: boolean,
	width: number,
): string {
	const draft = mr.draft ? `${C.brightRed}[draft]${C.reset} ` : "";
	const title = bold ? `${C.bold}${mr.title}${C.reset}` : mr.title;
	const head = `${marker}${stateColor(mr)}${fitTo(`!${mr.iid}`, 6)}${C.reset} ${pipelineGlyph(pipeline)} ${C.gray}${shortDate(mr.updatedAt)}${C.reset} ${C.cyan}${fitTo(mr.author, 13)}${C.reset} `;
	return truncateToWidth(`${head}${draft}${title}`, width);
}

const listLine = (
	mr: MR,
	pipeline: PipelineState | undefined,
	selected: boolean,
	width: number,
): string =>
	mrRow(
		mr,
		pipeline,
		selected ? `${C.cyan}❯${C.reset} ` : "  ",
		selected,
		width,
	);

/** Commands are matched on the US-layout position of the key, so they keep
 *  working when the keyboard is switched to another layout. */
const command = (key: Key): string | undefined => key.base ?? key.char;

const hint = (keys: string, what: string): string =>
	`${C.bold}${keys}${C.reset}${C.gray} ${what}`;
const hints = (...pairs: [string, string][]): string =>
	pairs.map(([k, w]) => hint(k, w)).join(`${C.gray} · `);

const LIST_HINTS = hints(
	["jk", "move"],
	["l", "open"],
	["p", "pipeline"],
	["o", "browser"],
	["y", "link"],
	["/", "filter"],
	["u", "reload"],
	["?", "help"],
	["q", "quit"],
);

const DETAIL_HINTS = hints(
	["jk", "scroll"],
	["p", "pipeline"],
	["o", "browser"],
	["y", "link"],
	["h", "back"],
);

// a merge request named on the command line has no list behind it
const DETAIL_HINTS_ALONE = hints(
	["jk", "scroll"],
	["p", "pipeline"],
	["o", "browser"],
	["y", "link"],
	["q", "quit"],
);

const JOBS_HINTS = hints(
	["jk", "move"],
	["l", "log"],
	["r", "retry"],
	["R", "retry all"],
	["x", "cancel"],
	["X", "cancel all"],
	["s", "start"],
	["u", "refresh"],
	["h", "back"],
);

const LOG_HINTS = hints(
	["jk", "scroll"],
	["gG", "ends"],
	["u", "refresh"],
	["o", "browser"],
	["h", "back"],
);

// ---------------------------------------------------------------------- app

type ImageState =
	| { status: "loading" }
	| { status: "failed" }
	| {
			status: "ready";
			data: ImageData;
			cols: number;
			rows: number;
			blob: string | null;
	  };

type Mode = "list" | "detail" | "jobs" | "log" | "help";

type Confirm = { question: string; run: () => Promise<void> };

class App {
	private readonly screen = new AltScreen();
	private readonly protocol: Protocol = detectProtocol();
	private readonly images = new Map<string, ImageState>();
	private readonly pipelines = new Map<string, PipelineState>(); // keyed by head sha

	private all: MR[] = [];
	private view: MR[] = [];
	private query = "";
	private queryBackup = "";
	private filtering = false;
	private cursor = 0;
	private offset = 0;
	private status = "";
	private confirm: Confirm | null = null;

	private mode: Mode = "list";
	private previousMode: Mode = "list";
	private detail: { mr: MR; rows: MdRow[]; scroll: number } | null = null;
	private jobs: {
		mr: MR;
		pipeline: Pipeline | null;
		items: Job[];
		cursor: number;
		loading: boolean;
		origin: Mode;
	} | null = null;
	private log: {
		job: Job;
		lines: string[];
		scroll: number;
		loading: boolean;
	} | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	private busy = false;
	private page = 1;
	private moreToLoad = true;
	private loadingMore = false;
	private drawnImages = false;
	private done!: () => void;

	/** `single` is the merge request named on the command line: there is no list
	 *  behind it, so it is what opens and what leaving goes back to — nothing. */
	constructor(
		private readonly args: string[],
		private readonly single: MR | null = null,
	) {
		// a merge request list is one page deep; the rest arrives as the reader
		// walks down to it — unless the command line pinned a page of its own
		this.moreToLoad = !args.some((a) => /^(-p|--page)(=|\d|$)/.test(a));
	}

	private get height(): number {
		return Math.max(6, this.screen.rows - 2); // one line of chrome above and below
	}

	private get width(): number {
		return this.screen.cols;
	}

	async run(): Promise<void> {
		// kitty draws images on a separate layer — drop them before each repaint
		this.screen.setPrelude(() =>
			this.drawnImages
				? ((this.drawnImages = false), clearImages(this.protocol))
				: "",
		);

		if (this.single) {
			this.all = [this.single];
			this.view = [this.single];
		} else {
			await this.reload();
			if (this.all.length === 0) {
				// reload keeps what went wrong in the status line, which nothing
				// is going to draw now — say it here or it is lost
				console.error(
					this.status
						? stripAnsi(this.status)
						: "no merge requests match these filters",
				);
				process.exit(1);
			}
		}

		hideCursor();
		this.screen.enter();
		enableKittyKeys();
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.on("data", (data: Buffer) => {
			for (const key of decodeKeys(data)) this.onKey(key);
		});
		process.stdout.on("resize", () => this.render());
		process.on("exit", () => this.restore());

		// the terminal is measurable only now, and openDetail lays out to its width
		if (this.single) {
			this.openDetail();
			// the header names the pipeline, so redraw the request once it is known
			void this.loadPipelines().then(() => {
				if (this.mode === "detail") this.openDetail();
				this.render();
			});
		}

		this.render();
		await new Promise<void>((resolve) => {
			this.done = resolve;
		});
	}

	private restore(): void {
		this.stopAutoRefresh();
		disableKittyKeys();
		this.screen.exit();
		showCursor();
		process.stdin.setRawMode?.(false);
	}

	private quit(): void {
		this.restore();
		process.stdin.pause();
		this.done?.();
	}

	// ------------------------------------------------------------------ data

	private async reload(): Promise<void> {
		this.busy = true;
		this.render();
		try {
			this.all = await listMRs(this.args);
			this.pipelines.clear();
			this.status = "";
		} catch (err) {
			this.status = `${C.red}${(err as Error).message.split("\n")[0]}`;
		}
		this.busy = false;
		this.applyFilter();
		void this.loadPipelines();
	}

	/** One page of recent pipelines covers most of the list; the leftovers are
	 *  looked up per merge request, a few at a time. */
	private async loadPipelines(): Promise<void> {
		const projectId = this.all[0]?.projectId;
		if (!projectId) return;

		// one merge request is not worth a page of the project's pipelines
		if (this.single) {
			const mr = this.single;
			if (!mr.sha) return;
			this.pipelines.set(
				mr.sha,
				pipelineState(await pipelineForSha(mr.projectId, mr.sha)),
			);
			this.render();
			return;
		}

		const recent = await recentPipelines(projectId);
		for (const mr of this.all) {
			const status = recent.get(mr.sha);
			if (status) this.pipelines.set(mr.sha, pipelineState(status));
		}
		this.render();

		const queue = this.all.filter(
			(mr) => mr.sha && !this.pipelines.has(mr.sha),
		);
		const worker = async () => {
			for (let mr = queue.shift(); mr; mr = queue.shift()) {
				this.pipelines.set(
					mr.sha,
					pipelineState(await pipelineForSha(mr.projectId, mr.sha)),
				);
				this.render();
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(6, queue.length) }, worker),
		);
	}

	private applyFilter(): void {
		const selected = this.view[this.cursor]?.iid;
		const scored = this.all
			.map((mr) => ({ mr, score: fuzzyScore(haystackOf(mr), this.query) }))
			.filter((x) => x.score !== null) as { mr: MR; score: number }[];
		if (this.query) scored.sort((a, b) => b.score - a.score);
		this.view = scored.map((x) => x.mr);

		const keep = this.view.findIndex((mr) => mr.iid === selected);
		this.cursor = keep >= 0 ? keep : 0;
		this.clampScroll();
		this.render();
	}

	private clampScroll(): void {
		const height = this.height - 1; // the filter line sits above the list
		this.cursor = Math.max(0, Math.min(this.cursor, this.view.length - 1));
		if (this.cursor < this.offset) this.offset = this.cursor;
		if (this.cursor >= this.offset + height)
			this.offset = this.cursor - height + 1;
		this.offset = Math.max(
			0,
			Math.min(this.offset, Math.max(0, this.view.length - height)),
		);
	}

	private get currentMR(): MR | undefined {
		if (this.mode === "detail") return this.detail?.mr;
		if (this.mode === "jobs" || this.mode === "log") return this.jobs?.mr;
		return this.view[this.cursor];
	}

	// ------------------------------------------------------------------ keys

	private onKey(key: Key): void {
		if (key.name === "ctrl-c") {
			this.quit();
			return;
		}

		if (this.confirm) {
			const answer = this.confirm;
			this.confirm = null;
			if (key.name === "char" && command(key)?.toLowerCase() === "y") {
				this.status = `${C.gray}working…`;
				void answer.run();
			} else {
				this.status = `${C.gray}cancelled`;
			}
			this.render();
			return;
		}

		if (this.filtering) {
			this.filterKey(key);
			this.render();
			return;
		}

		this.status = "";
		switch (this.mode) {
			case "list":
				this.listKey(key);
				break;
			case "detail":
				this.detailKey(key);
				break;
			case "jobs":
				this.jobsKey(key);
				break;
			case "log":
				this.logKey(key);
				break;
			case "help":
				this.mode = this.previousMode;
				break;
		}
		this.render();
	}

	private filterKey(key: Key): void {
		switch (key.name) {
			case "escape":
				this.query = this.queryBackup;
				this.filtering = false;
				this.applyFilter();
				break;
			case "enter":
			case "down":
			case "up":
				this.filtering = false;
				break;
			case "backspace":
				this.query = this.query.slice(0, -1);
				this.applyFilter();
				break;
			case "char":
				this.query += key.char ?? "";
				this.applyFilter();
				break;
			default:
				break;
		}
	}

	/** Movement shared by every scrollable view. */
	private moveBy(key: Key, page: number): number | null {
		switch (key.name) {
			case "up":
				return -1;
			case "down":
				return 1;
			case "pageup":
				return -page;
			case "pagedown":
				return page;
			case "char": {
				const cmd = command(key);
				if (cmd === "k") return -1;
				if (cmd === "j") return 1;
				if (cmd === " ") return page;
				return null;
			}
			default:
				return null;
		}
	}

	private listKey(key: Key): void {
		const step = this.moveBy(key, this.height - 2);
		if (step !== null) {
			this.cursor += step;
			this.clampScroll();
			return;
		}

		switch (key.name) {
			case "right":
			case "enter":
				this.openDetail();
				return;
			case "home":
				this.cursor = 0;
				break;
			case "end":
				this.cursor = this.view.length - 1;
				break;
			case "escape":
				if (this.query) {
					this.query = "";
					this.applyFilter();
					return;
				}
				this.quit();
				return;
			case "char":
				switch (command(key)) {
					case "l":
						this.openDetail();
						return;
					case "q":
						this.quit();
						return;
					case "/":
					case ".":
						this.queryBackup = this.query;
						this.filtering = true;
						return;
					case "g":
						this.cursor = 0;
						break;
					case "G":
						this.cursor = this.view.length - 1;
						break;
					case "o":
						this.openBrowser(this.currentMR?.url);
						break;
					case "p":
						void this.openJobs("list");
						return;
					case "y":
						this.copy("rich");
						break;
					case "Y":
						this.copy("markdown");
						break;
					case "u":
						void this.reload();
						return;
					case "?":
						this.previousMode = "list";
						this.mode = "help";
						return;
					default:
						break;
				}
				break;
			default:
				break;
		}
		this.clampScroll();
	}

	/** Back out of a merge request — to the list, or out of the program when the
	 *  command line named the request and there is no list to go back to. */
	private leaveDetail(): void {
		if (this.single) {
			this.quit();
			return;
		}
		this.mode = "list";
		this.detail = null;
	}

	private detailKey(key: Key): void {
		const detail = this.detail;
		if (!detail) return;
		const page = this.height - 2;

		const step = this.moveBy(key, page);
		if (step !== null) {
			detail.scroll = Math.max(
				0,
				Math.min(detail.scroll + step, detail.rows.length - 1),
			);
			return;
		}

		switch (key.name) {
			case "left":
			case "escape":
				this.leaveDetail();
				return;
			case "home":
				detail.scroll = 0;
				break;
			case "end":
				detail.scroll = detail.rows.length - 1;
				break;
			case "enter":
				this.openBrowser(detail.mr.url);
				break;
			case "char":
				switch (command(key)) {
					case "h":
					case "q":
						this.leaveDetail();
						return;
					case "g":
						detail.scroll = 0;
						break;
					case "G":
						detail.scroll = detail.rows.length - 1;
						break;
					case "o":
						this.openBrowser(detail.mr.url);
						break;
					case "p":
						void this.openJobs("detail");
						return;
					case "y":
						this.copy("rich");
						break;
					case "Y":
						this.copy("markdown");
						break;
					case "?":
						this.previousMode = "detail";
						this.mode = "help";
						return;
					default:
						break;
				}
				break;
			default:
				break;
		}
	}

	private jobsKey(key: Key): void {
		const jobs = this.jobs;
		if (!jobs) return;

		const step = this.moveBy(key, this.height - 2);
		if (step !== null) {
			jobs.cursor = Math.max(
				0,
				Math.min(jobs.cursor + step, jobs.items.length - 1),
			);
			return;
		}

		const job = jobs.items[jobs.cursor];
		switch (key.name) {
			case "right":
			case "enter":
				void this.openLog();
				return;
			case "left":
			case "escape":
				this.closeJobs();
				return;
			case "char":
				switch (command(key)) {
					case "l":
						void this.openLog();
						return;
					case "h":
					case "q":
						this.closeJobs();
						return;
					case "g":
						jobs.cursor = 0;
						break;
					case "G":
						jobs.cursor = jobs.items.length - 1;
						break;
					case "u":
						void this.refreshJobs();
						return;
					case "o":
						this.openBrowser(job?.webUrl);
						break;
					case "O":
						this.openBrowser(jobs.pipeline?.webUrl);
						break;
					case "r":
						if (job)
							this.ask(`retry job ${job.name}?`, () =>
								retryJob(jobs.mr.projectId, job.id),
							);
						break;
					case "R":
						if (jobs.pipeline)
							this.ask(`retry the whole pipeline #${jobs.pipeline.id}?`, () =>
								retryPipeline(jobs.mr.projectId, jobs.pipeline?.id ?? 0),
							);
						break;
					case "x":
						if (job)
							this.ask(`cancel job ${job.name}?`, () =>
								cancelJob(jobs.mr.projectId, job.id),
							);
						break;
					case "X":
						if (jobs.pipeline)
							this.ask(`cancel the whole pipeline #${jobs.pipeline.id}?`, () =>
								cancelPipeline(jobs.mr.projectId, jobs.pipeline?.id ?? 0),
							);
						break;
					case "s":
						if (job)
							this.ask(`start manual job ${job.name}?`, () =>
								playJob(jobs.mr.projectId, job.id),
							);
						break;
					case "?":
						this.previousMode = "jobs";
						this.mode = "help";
						return;
					default:
						break;
				}
				break;
			default:
				break;
		}
	}

	private logKey(key: Key): void {
		const log = this.log;
		if (!log) return;
		const page = this.height - 2;

		const step = this.moveBy(key, page);
		if (step !== null) {
			log.scroll = Math.max(
				0,
				Math.min(log.scroll + step, Math.max(0, log.lines.length - 1)),
			);
			return;
		}

		switch (key.name) {
			case "left":
			case "escape":
				this.mode = "jobs";
				this.log = null;
				return;
			case "home":
				log.scroll = 0;
				break;
			case "end":
				log.scroll = Math.max(0, log.lines.length - page);
				break;
			case "char":
				switch (command(key)) {
					case "h":
					case "q":
						this.mode = "jobs";
						this.log = null;
						return;
					case "g":
						log.scroll = 0;
						break;
					case "G":
						log.scroll = Math.max(0, log.lines.length - page);
						break;
					case "u":
						void this.refreshLog();
						return;
					case "o":
						this.openBrowser(log.job.webUrl);
						break;
					case "?":
						this.previousMode = "log";
						this.mode = "help";
						return;
					default:
						break;
				}
				break;
			default:
				break;
		}
	}

	// --------------------------------------------------------------- actions

	private openBrowser(url: string | undefined): void {
		if (!url) return;
		openInBrowser(url);
		this.status = `${C.gray}opened in the browser`;
	}

	private copy(kind: "rich" | "markdown"): void {
		const mr = this.currentMR;
		if (!mr) return;
		if (kind === "rich") {
			this.status = copyRichLink(mr.title, mr.url)
				? `${C.green}copied link to !${mr.iid}`
				: `${C.red}could not reach the clipboard`;
		} else {
			copyText(`[${mr.title}](${mr.url})`);
			this.status = `${C.green}copied markdown for !${mr.iid}`;
		}
	}

	/** Anything that changes CI state asks first. */
	private ask(question: string, run: () => Promise<string | null>): void {
		this.confirm = {
			question,
			run: async () => {
				const error = await run();
				this.status = error ? `${C.red}${error}` : `${C.green}done`;
				await this.refreshJobs();
			},
		};
	}

	// ---------------------------------------------------------------- detail

	private openDetail(): void {
		const mr = this.view[this.cursor];
		if (!mr) return;
		// reopening the same request is a redraw — do not throw the reader's place
		// away; iids repeat across projects, so the project has to match too
		const same =
			this.detail?.mr.iid === mr.iid &&
			this.detail?.mr.projectId === mr.projectId;
		const scroll = same ? (this.detail?.scroll ?? 0) : 0;

		this.mode = "detail";
		const width = this.width - 2;
		const pipeline = this.pipelines.get(mr.sha);
		const meta: MdRow[] = [
			{
				kind: "text",
				text: `${C.bold}${stateColor(mr)}!${mr.iid}${C.reset} ${C.bold}${mr.title}${C.reset}`,
			},
			{
				kind: "text",
				text: [
					`${C.cyan}${mr.author}${C.reset}`,
					`${C.magenta}${mr.sourceBranch}${C.reset} ${C.gray}→${C.reset} ${C.magenta}${mr.targetBranch}${C.reset}`,
					`${mr.state}${mr.draft ? ` ${C.brightRed}draft${C.reset}` : ""}`,
					`${pipelineGlyph(pipeline)} ${C.gray}pipeline ${pipeline ?? "…"}${C.reset}`,
					`${C.gray}${mr.updatedAt.slice(0, 16).replace("T", " ")}${C.reset}`,
				].join(`${C.gray} · ${C.reset}`),
			},
		];
		const extras: string[] = [];
		if (mr.labels.length > 0)
			extras.push(`${C.gray}labels:${C.reset} ${mr.labels.join(", ")}`);
		if (mr.reviewers.length > 0)
			extras.push(`${C.gray}reviewers:${C.reset} ${mr.reviewers.join(", ")}`);
		if (mr.assignees.length > 0)
			extras.push(`${C.gray}assignees:${C.reset} ${mr.assignees.join(", ")}`);
		if (mr.comments > 0)
			extras.push(`${C.gray}comments:${C.reset} ${mr.comments}`);
		if (mr.hasConflicts) extras.push(`${C.red}conflicts${C.reset}`);
		if (extras.length > 0)
			meta.push({ kind: "text", text: extras.join(`${C.gray} · ${C.reset}`) });
		meta.push({ kind: "text", text: `${C.gray}${mr.url}${C.reset}` });
		meta.push({
			kind: "text",
			text: `${C.gray}${"─".repeat(Math.min(width, 60))}${C.reset}`,
		});

		const body = mr.description.trim()
			? renderMarkdown(mr.description, width)
			: [
					{
						kind: "text",
						text: `${C.gray}${C.italic}no description${C.reset}`,
					} as MdRow,
				];

		const rows = [...meta, ...body];
		this.detail = { mr, rows, scroll: Math.min(scroll, rows.length - 1) };
		void this.loadImages();
	}

	private async loadImages(): Promise<void> {
		const detail = this.detail;
		if (!detail || this.protocol === "none") return;

		const urls = detail.rows
			.filter((r): r is Extract<MdRow, { kind: "image" }> => r.kind === "image")
			.map((r) => r.url);
		if (urls.length === 0) return; // tokenFor spawns glab — not for nothing

		const host = new URL(detail.mr.url).host;
		const token = tokenFor(host);
		const base = detail.mr.url.replace(/\/-\/merge_requests\/\d+.*$/, "");

		await Promise.all(
			urls.map(async (url) => {
				if (this.images.has(url)) return;
				this.images.set(url, { status: "loading" });
				this.render();

				const absolute = /^https?:/.test(url)
					? url
					: `${base}${url.startsWith("/") ? "" : "/"}${url}`;
				const data = await loadImage(absolute, { host, token });
				if (!data) {
					this.images.set(url, { status: "failed" });
				} else {
					const [cols, rows] = imageCells(data, Math.min(this.width - 2, 60));
					this.images.set(url, {
						status: "ready",
						data,
						cols,
						rows,
						blob: renderImage(data, this.protocol, cols, rows),
					});
				}
				if (this.mode === "detail") this.render();
			}),
		);
	}

	// ------------------------------------------------------------------ jobs

	private async openJobs(origin: Mode): Promise<void> {
		const mr = this.currentMR;
		if (!mr) return;

		this.jobs = {
			mr,
			pipeline: null,
			items: [],
			cursor: 0,
			loading: true,
			origin,
		};
		this.mode = "jobs";
		this.render();

		const pipelines = await mrPipelines(mr.projectId, mr.iid);
		const pipeline = pipelines[0] ?? null;
		if (!this.jobs) return;
		this.jobs.pipeline = pipeline;
		if (!pipeline) {
			this.jobs.loading = false;
			this.status = `${C.gray}!${mr.iid} has no pipelines`;
			this.render();
			return;
		}
		await this.refreshJobs();
		this.startAutoRefresh();
	}

	private closeJobs(): void {
		this.stopAutoRefresh();
		this.mode = this.jobs?.origin === "detail" ? "detail" : "list";
		this.jobs = null;
	}

	private async refreshJobs(): Promise<void> {
		const jobs = this.jobs;
		if (!jobs?.pipeline) return;

		jobs.loading = true;
		this.render();
		const items = await pipelineJobs(jobs.mr.projectId, jobs.pipeline.id);
		if (this.jobs !== jobs) return;

		// stage order as GitLab returns it, jobs newest attempt last
		const stages: string[] = [];
		for (const job of items)
			if (!stages.includes(job.stage)) stages.push(job.stage);
		jobs.items = items.sort(
			(a, b) =>
				stages.indexOf(a.stage) - stages.indexOf(b.stage) ||
				a.name.localeCompare(b.name),
		);
		jobs.cursor = Math.min(jobs.cursor, Math.max(0, jobs.items.length - 1));
		jobs.loading = false;

		const fresh = await mrPipelines(jobs.mr.projectId, jobs.mr.iid);
		if (this.jobs === jobs && fresh[0]) {
			jobs.pipeline = fresh[0];
			this.pipelines.set(jobs.mr.sha, pipelineState(fresh[0].status));
		}
		this.render();
	}

	private startAutoRefresh(): void {
		this.stopAutoRefresh();
		this.refreshTimer = setInterval(() => {
			const jobs = this.jobs;
			if (!jobs || this.mode !== "jobs" || this.confirm) return;
			const active = jobs.items.some((j) =>
				[
					"running",
					"pending",
					"created",
					"preparing",
					"waiting_for_resource",
					"scheduled",
				].includes(j.status),
			);
			if (active) void this.refreshJobs();
		}, 5000);
	}

	private stopAutoRefresh(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = null;
	}

	// ------------------------------------------------------------------- log

	private async openLog(): Promise<void> {
		const jobs = this.jobs;
		const job = jobs?.items[jobs.cursor];
		if (!jobs || !job) return;

		this.log = { job, lines: [], scroll: 0, loading: true };
		this.mode = "log";
		this.render();
		await this.refreshLog();
	}

	private async refreshLog(): Promise<void> {
		const log = this.log;
		const projectId = this.jobs?.mr.projectId;
		if (!log || !projectId) return;

		log.loading = true;
		this.render();
		const trace = await jobTrace(projectId, log.job.id);
		if (this.log !== log) return;

		const width = this.width;
		log.lines = trace
			.split("\n")
			.flatMap((line) => wrapAnsi(line, width))
			.filter((line, i, arr) => !(line === "" && arr[i - 1] === ""));
		log.loading = false;
		log.scroll = Math.max(0, log.lines.length - (this.height - 1)); // logs are read from the end
		this.render();
	}

	// ---------------------------------------------------------------- paint

	private rowHeight(row: MdRow): number {
		if (row.kind === "text") return 1;
		const state = this.images.get(row.url);
		return state?.status === "ready" && state.blob ? state.rows : 1;
	}

	private toDrawRow(row: MdRow): Row {
		if (row.kind === "text") return row.text;
		const state = this.images.get(row.url);
		if (state?.status === "ready" && state.blob) {
			this.drawnImages = true;
			return { raw: state.blob, rows: state.rows };
		}
		const label =
			state?.status === "loading"
				? "loading image…"
				: this.protocol === "none"
					? "image (terminal has no graphics protocol)"
					: "image unavailable";
		return `${C.magenta}🖼 ${label}${C.reset} ${C.gray}${row.alt || row.url}${C.reset}`;
	}

	private footer(defaultHints: string, right = ""): string {
		if (this.confirm)
			return `${C.yellow}${this.confirm.question}${C.reset} ${C.bold}y/n${C.reset}`;
		const left = this.status
			? `${this.status}${C.reset}`
			: `${defaultHints}${C.reset}`;
		if (!right) return left;
		const pad = Math.max(
			1,
			this.width - displayWidth(left) - displayWidth(right),
		);
		return `${left}${" ".repeat(pad)}${C.gray}${right}${C.reset}`;
	}

	private pad(rows: Row[], used: number): void {
		for (let i = used; i < this.height; i += 1) rows.push("");
	}

	private render(): void {
		switch (this.mode) {
			case "list":
				return this.renderList();
			case "detail":
				return this.renderDetail();
			case "jobs":
				return this.renderJobs();
			case "log":
				return this.renderLog();
			case "help":
				return this.renderHelp();
		}
	}

	private renderList(): void {
		const rows: Row[] = [];
		const counter = this.busy
			? "loading…"
			: `${this.view.length}/${this.all.length}`;
		const prompt = this.filtering
			? `${C.bold}/${C.reset}${this.query}${C.cyan}▏${C.reset}`
			: this.query
				? `${C.gray}/${C.reset}${this.query}`
				: `${C.bold}merge requests${C.reset}`;
		rows.push(
			`${prompt}${" ".repeat(Math.max(1, this.width - displayWidth(prompt) - counter.length))}${C.gray}${counter}${C.reset}`,
		);

		const height = this.height - 1;
		const slice = this.view.slice(this.offset, this.offset + height);
		for (const [i, mr] of slice.entries()) {
			rows.push(
				listLine(
					mr,
					this.pipelines.get(mr.sha),
					this.offset + i === this.cursor,
					this.width,
				),
			);
		}
		this.pad(rows, slice.length + 1);

		rows.push(this.footer(LIST_HINTS));
		this.screen.draw(rows);
	}

	private renderDetail(): void {
		const detail = this.detail;
		if (!detail) return;

		const rows: Row[] = [];
		let used = 0;
		let index = detail.scroll;
		while (index < detail.rows.length && used < this.height) {
			const row = detail.rows[index] as MdRow;
			const h = this.rowHeight(row);
			if (used + h > this.height && used > 0) break;
			rows.push(this.toDrawRow(row));
			used += h;
			index += 1;
		}
		this.pad(rows, used);

		const position =
			detail.rows.length > 0
				? Math.round((index / detail.rows.length) * 100)
				: 100;
		rows.push(
			this.footer(
				this.single ? DETAIL_HINTS_ALONE : DETAIL_HINTS,
				`${position}%`,
			),
		);
		this.screen.draw(rows);
	}

	private renderJobs(): void {
		const jobs = this.jobs;
		if (!jobs) return;

		const rows: Row[] = [];
		const pipeline = jobs.pipeline;
		const head = pipeline
			? `${C.bold}!${jobs.mr.iid}${C.reset} ${C.gray}pipeline${C.reset} ${C.bold}#${pipeline.id}${C.reset} ${jobGlyph(pipeline.status)} ${jobColor(pipeline.status)}${pipeline.status}${C.reset} ${C.gray}${pipeline.ref}${C.reset}`
			: `${C.bold}!${jobs.mr.iid}${C.reset} ${C.gray}looking for pipelines…${C.reset}`;
		const counter = jobs.loading ? "refreshing…" : `${jobs.items.length} jobs`;
		rows.push(
			`${truncateToWidth(head, Math.max(10, this.width - counter.length - 1))}${" ".repeat(Math.max(1, this.width - displayWidth(truncateToWidth(head, Math.max(10, this.width - counter.length - 1))) - counter.length))}${C.gray}${counter}${C.reset}`,
		);

		// stage headers, then the jobs of that stage
		const lines: string[] = [];
		const cursorLines: number[] = [];
		let stage = "";
		for (const [i, job] of jobs.items.entries()) {
			if (job.stage !== stage) {
				stage = job.stage;
				lines.push(`${C.gray}${stage}${C.reset}`);
			}
			const selected = i === jobs.cursor;
			const marker = selected ? `${C.cyan}❯${C.reset} ` : "  ";
			const name = selected ? `${C.bold}${job.name}${C.reset}` : job.name;
			const extra = [
				job.duration !== null ? duration(job.duration) : "",
				job.failureReason && job.status === "failed" ? job.failureReason : "",
				job.allowFailure ? "allow_failure" : "",
			]
				.filter(Boolean)
				.join(" · ");
			cursorLines.push(lines.length);
			lines.push(
				truncateToWidth(
					`${marker}${jobGlyph(job.status)} ${jobColor(job.status)}${fitTo(job.status, 9)}${C.reset} ${fitTo(name, 42)} ${C.gray}${extra}${C.reset}`,
					this.width,
				),
			);
		}

		const height = this.height - 1;
		const focus = cursorLines[jobs.cursor] ?? 0;
		const start = Math.max(
			0,
			Math.min(
				focus - Math.floor(height / 2),
				Math.max(0, lines.length - height),
			),
		);
		const slice = lines.slice(start, start + height);
		for (const line of slice) rows.push(line);
		this.pad(rows, slice.length + 1);

		rows.push(this.footer(JOBS_HINTS));
		this.screen.draw(rows);
	}

	private renderLog(): void {
		const log = this.log;
		if (!log) return;

		const rows: Row[] = [];
		const head = `${C.bold}${log.job.name}${C.reset} ${jobGlyph(log.job.status)} ${jobColor(log.job.status)}${log.job.status}${C.reset} ${C.gray}${log.job.stage}${duration(log.job.duration) ? ` · ${duration(log.job.duration)}` : ""}${C.reset}`;
		const counter = log.loading ? "loading…" : `${log.lines.length} lines`;
		rows.push(
			`${head}${" ".repeat(Math.max(1, this.width - displayWidth(head) - counter.length))}${C.gray}${counter}${C.reset}`,
		);

		const height = this.height - 1;
		const slice = log.lines.slice(log.scroll, log.scroll + height);
		for (const line of slice) rows.push(line);
		this.pad(rows, slice.length + 1);

		const end = Math.min(log.scroll + height, log.lines.length);
		const position =
			log.lines.length > 0 ? Math.round((end / log.lines.length) * 100) : 100;
		rows.push(this.footer(LOG_HINTS, `${position}%`));
		this.screen.draw(rows);
	}

	private renderHelp(): void {
		const rows: Row[] = KEYS.split("\n").slice(0, this.height);
		this.pad(rows, rows.length);
		rows.push(this.footer(`${C.gray}any key returns${C.reset}`));
		this.screen.draw(rows);
	}
}

// --------------------------------------------------------------------- entry

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
	process.stdout.write(HELP);
	process.exit(0);
}

const die = (message: string, code = 1): never => {
	console.error(message);
	process.exit(code);
};

// `glab mr list` flags that eat the next argument. A merge request is the one
// positional argument of the command line, and this is how to tell it apart
// from `--search 3614`, which looks exactly like one.
const VALUED = new Set(
	`-a --assignee --author --created-after --created-before --deployed-after --deployed-before
	 --environment -g --group --jq -l --label -m --milestone --not-label -o --order -F --output
	 -p --page -P --per-page -R --repo -r --reviewer --search -S --sort -s --source-branch
	 -t --target-branch`.split(/\s+/),
);

/** One pass over the command line: -y and -Y are ours, the merge request is the
 *  argument that is neither a flag nor a flag's value, and everything left over
 *  belongs to `glab mr list`. Values are skipped rather than examined, so
 *  `--search -y` and `--search 3614` stay what the user meant. */
function parseArgv(list: string[]): {
	copyKind: "rich" | "markdown" | null;
	rest: string[];
	repo?: string;
	mrs: string[];
} {
	let copyKind: "rich" | "markdown" | null = null;
	const rest: string[] = [];
	const mrs: string[] = [];
	let repo: string | undefined;

	for (let i = 0; i < list.length; i += 1) {
		const a = list[i] ?? "";

		if (!a.startsWith("-")) {
			mrs.push(a);
			continue;
		}

		if (a === "-y" || a === "--copy") copyKind = "rich";
		else if (a === "-Y" || a === "--copy-markdown") copyKind = "markdown";
		else rest.push(a);

		// -R group/project, --repo=group/project and -Rgroup/project all count
		if (a === "-R" || a === "--repo") repo = list[i + 1];
		else repo = /^(?:--repo=|-R)(.+)$/.exec(a)?.[1] ?? repo;

		if (VALUED.has(a)) {
			const value = list[i + 1];
			if (value !== undefined) rest.push(value);
			i += 1;
		}
	}

	return { copyKind, rest, repo, mrs };
}

const { copyKind, rest: args, repo, mrs } = parseArgv(argv);

// one at a time — `glab mr list` has no positional arguments of its own, so a
// second one is a mistake rather than something to pass on
if (mrs.length > 1) die(`one merge request at a time, got ${mrs.length}`, 2);

const mr = mrs[0];
const ref = mr === undefined ? null : parseMRRef(mr, repo);
if (!ref && mr !== undefined) {
	die(`not a merge request: ${mr} — give a link, or !123 in its repository`, 2);
}

if (copyKind && !ref) {
	die("--copy needs a merge request: a link, or !123 in its repository", 2);
}

const single = ref
	? await fetchMR(ref).catch((err: Error) =>
			die(`${err.message.split("\n")[0]}`),
		)
	: null;

if (copyKind && single) {
	if (copyKind === "markdown") {
		copyText(`[${single.title}](${single.url})`);
	} else if (!copyRichLink(single.title, single.url)) {
		die(`could not reach the clipboard — !${single.iid} was not copied`);
	}

	// what was copied, in the row it has on the list — the check stands where
	// the cursor would. A pipe gets the same line without the colors.
	const pipeline = pipelineState(
		await pipelineForSha(single.projectId, single.sha),
	);
	const row = mrRow(
		single,
		pipeline,
		`${C.green}✓${C.reset} `,
		false,
		process.stdout.columns || 1000,
	);
	console.log(
		process.stdout.isTTY && !process.env.NO_COLOR ? row : stripAnsi(row),
	);
	process.exit(0);
}

if (!process.stdout.isTTY) {
	console.error("glab-mrs needs a terminal");
	process.exit(1);
}

await new App(args, single).run();
process.exit(0);
