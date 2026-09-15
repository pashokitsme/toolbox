// The merge requests of one project: people in the search bar dropdown, the
// rest of the filters under ⌘F, details in a side panel on ↵.

import {
	Action,
	ActionPanel,
	Color,
	getPreferenceValues,
	Icon,
	List,
} from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { useState } from "react";
import {
	decodePeople,
	DEFAULT_FILTERS,
	describe,
	encodePeople,
	pipelineMatches,
	toVariables,
	type DraftFilter,
	type Filters,
	type People,
	type PipelineFilter,
	type Role,
	type StateFilter,
} from "./filters";
import type { Host } from "./glab-config";
import { AuthError } from "./gitlab";
import { avatar, pipelineAccessory, ROLE_TITLE, STATE_ICON } from "./icons";
import { CopyLinkAction, CopyMarkdownAction } from "./link-actions";
import { absolutizeMarkdown } from "./markdown";
import { MemberPicker } from "./member-picker";
import { collectMatching } from "./paging";
import {
	fetchCurrentUsername,
	fetchMergeRequestDetail,
	fetchMergeRequests,
	type MergeRequest,
	type MergeRequestDetail,
	type Project,
} from "./queries";
import { rowTitle } from "./title";

// a pipeline-filtered page: fill it to this many rows, reading at most this many GitLab pages
const WANT = 20;
const MAX_PAGES = 5;

const STATES: [StateFilter, string][] = [
	["opened", "Opened"],
	["merged", "Merged"],
	["closed", "Closed"],
	["all", "All"],
];
const DRAFTS: [DraftFilter, string][] = [
	["any", "Any"],
	["hide", "Hide Drafts"],
	["only", "Only Drafts"],
];
const PIPELINES: [PipelineFilter, string][] = [
	["any", "Any"],
	["running", "Running"],
	["passed", "Passed"],
	["failed", "Failed"],
	["canceled", "Canceled"],
	["none", "No Pipeline"],
];
const ROLES: Role[] = ["author", "reviewer", "assignee"];

export function MergeRequests(props: { host: Host; project: Project }) {
	const { host, project } = props;
	const [searchText, setSearchText] = useState("");
	const [filters, setFilters] = useCachedState<Filters>(
		"mr-filters",
		DEFAULT_FILTERS,
	);
	const [showingDetail, setShowingDetail] = useCachedState(
		"mr-detail-open",
		false,
	);
	const [selectedIid, setSelectedIid] = useState<string | null>(null);

	const me = useCachedPromise(
		(_host: string) => fetchCurrentUsername(host),
		[host.host],
	);

	const list = useCachedPromise(
		// everything the page depends on is an argument, so the cache and the
		// revalidation follow it; filters travel as JSON to stay comparable
		(
			_host: string,
			fullPath: string,
			filtersJson: string,
			search: string,
			username: string,
		) =>
			async ({ cursor }: { cursor?: string | null }) => {
				const current = JSON.parse(filtersJson) as Filters;
				const query = toVariables(current, username);
				const fetchPage = (after: string | null) =>
					fetchMergeRequests(host, fullPath, query, search, after);
				const page =
					current.pipeline === "any"
						? await fetchPage(cursor ?? null)
						: await collectMatching(
								fetchPage,
								(mr) => pipelineMatches(mr.pipelineStatus, current.pipeline),
								cursor ?? null,
								{
									want: WANT,
									maxPages: MAX_PAGES,
								},
							);
				return { data: page.items, hasMore: page.hasMore, cursor: page.cursor };
			},
		[
			host.host,
			project.fullPath,
			JSON.stringify(filters),
			searchText.trim(),
			me.data ?? "",
		],
		{ execute: Boolean(me.data), keepPreviousData: true },
	);

	const detail = useCachedPromise(
		(_host: string, fullPath: string, iid: string) =>
			fetchMergeRequestDetail(host, fullPath, iid),
		[host.host, project.fullPath, selectedIid ?? ""],
		{ execute: showingDetail && Boolean(selectedIid) },
	);

	const setFilter = (patch: Partial<Filters>) =>
		setFilters({ ...filters, ...patch });
	const claude =
		getPreferenceValues<{ claudeUsername?: string }>().claudeUsername?.trim() ||
		"claude";
	// the two authors asked for most get a key each; pressing it again lets go
	const byAuthor = (who: string, title: string, key: "1" | "2") => {
		const active =
			filters.people?.role === "author" && filters.people.who === who;
		return (
			<Action
				title={active ? `${title} (Clear)` : title}
				icon={Icon.Person}
				shortcut={{ modifiers: ["cmd"], key }}
				onAction={() =>
					setFilter({ people: active ? null : { role: "author", who } })
				}
			/>
		);
	};
	const authorKeys = (
		<>
			{byAuthor("me", "By Me", "1")}
			{byAuthor(claude, "By Claude", "2")}
		</>
	);
	const authError = [me.error, list.error].find(
		(error) => error instanceof AuthError,
	);

	const filterMenu = (
		<ActionPanel.Submenu
			title="Filters"
			icon={Icon.Filter}
			shortcut={{ modifiers: ["cmd"], key: "f" }}
		>
			<ActionPanel.Submenu title="State">
				{STATES.map(([value, title]) => (
					<Action
						key={value}
						title={title}
						icon={filters.state === value ? Icon.CheckCircle : Icon.Circle}
						onAction={() => setFilter({ state: value })}
					/>
				))}
			</ActionPanel.Submenu>
			<ActionPanel.Submenu title="Draft">
				{DRAFTS.map(([value, title]) => (
					<Action
						key={value}
						title={title}
						icon={filters.draft === value ? Icon.CheckCircle : Icon.Circle}
						onAction={() => setFilter({ draft: value })}
					/>
				))}
			</ActionPanel.Submenu>
			<ActionPanel.Submenu title="Pipeline">
				{PIPELINES.map(([value, title]) => (
					<Action
						key={value}
						title={title}
						icon={filters.pipeline === value ? Icon.CheckCircle : Icon.Circle}
						onAction={() => setFilter({ pipeline: value })}
					/>
				))}
			</ActionPanel.Submenu>
			<Action
				title="Review Requested from Me"
				icon={Icon.Person}
				onAction={() => setFilter({ people: { role: "reviewer", who: "me" } })}
			/>
			<Action
				title="Assigned to Me"
				icon={Icon.Person}
				onAction={() => setFilter({ people: { role: "assignee", who: "me" } })}
			/>
			{ROLES.map((role) => (
				<Action.Push
					key={role}
					title={`${ROLE_TITLE[role]}…`}
					icon={Icon.Person}
					target={
						<MemberPicker
							host={host}
							project={project}
							role={role}
							onPick={(username) =>
								setFilter({ people: { role, who: username } })
							}
						/>
					}
				/>
			))}
			<Action
				title="Reset Filters"
				icon={Icon.Trash}
				onAction={() => setFilters(DEFAULT_FILTERS)}
			/>
		</ActionPanel.Submenu>
	);

	const refresh = (
		<Action
			title="Refresh"
			icon={Icon.ArrowClockwise}
			shortcut={{ modifiers: ["cmd"], key: "r" }}
			onAction={() => {
				// revalidate runs even where execute is off, so only ask for what is shown
				if (!me.data) return me.revalidate();
				list.revalidate();
				if (showingDetail && selectedIid) detail.revalidate();
			}}
		/>
	);

	// a pipeline filter reads at most MAX_PAGES GitLab pages at a time, and a
	// short or empty result gives Raycast nothing to scroll past to ask for more
	const searchFurther =
		filters.pipeline !== "any" && list.pagination?.hasMore ? (
			<Action
				title="Search Further"
				icon={Icon.MagnifyingGlass}
				shortcut={{ modifiers: ["cmd"], key: "l" }}
				onAction={() => list.pagination?.onLoadMore()}
			/>
		) : null;

	return (
		<List
			navigationTitle={project.name}
			searchBarPlaceholder="Search merge requests by title"
			isLoading={me.isLoading || list.isLoading}
			onSearchTextChange={setSearchText}
			throttle
			isShowingDetail={showingDetail}
			onSelectionChange={setSelectedIid}
			pagination={list.pagination}
			searchBarAccessory={
				<PeopleDropdown
					claude={claude}
					people={filters.people}
					onChange={(people) => setFilter({ people })}
				/>
			}
		>
			{authError ? (
				<List.EmptyView
					icon={Icon.XMarkCircle}
					title={authError.message}
					description={`Run: glab auth login --hostname ${host.host}`}
				/>
			) : (
				<List.EmptyView
					icon={Icon.Filter}
					title={searchFurther ? "No matches yet" : "No merge requests"}
					description={
						searchFurther
							? `None in the last ${MAX_PAGES * 20} merge requests — ⌘L searches further`
							: describe(filters)
								? `Filters: ${describe(filters)}`
								: undefined
					}
					actions={
						<ActionPanel>
							{searchFurther}
							{authorKeys}
							{filterMenu}
							{refresh}
						</ActionPanel>
					}
				/>
			)}
			<List.Section title={describe(filters) || undefined}>
				{(list.data ?? []).map((mr) => (
					<List.Item
						key={mr.iid}
						id={mr.iid}
						icon={{ value: STATE_ICON[mr.state], tooltip: mr.state }}
						title={{ value: rowTitle(mr.title, mr.draft), tooltip: mr.title }}
						subtitle={`!${mr.iid}`}
						accessories={rowAccessories(mr, showingDetail)}
						detail={
							showingDetail ? (
								<DetailPanel
									host={host}
									project={project}
									mr={mr}
									// the hook keeps the last MR's data while the next one loads
									detail={
										detail.data?.webUrl === mr.webUrl ? detail.data : undefined
									}
									isLoading={detail.isLoading}
								/>
							) : undefined
						}
						actions={
							<ActionPanel>
								<ActionPanel.Section>
									<Action
										title={showingDetail ? "Hide Details" : "Show Details"}
										icon={Icon.Sidebar}
										onAction={() => setShowingDetail(!showingDetail)}
									/>
									<Action.OpenInBrowser
										url={mr.webUrl}
										shortcut={{ modifiers: ["shift"], key: "return" }}
									/>
									<CopyLinkAction
										mr={mr}
										shortcut={{ modifiers: ["cmd"], key: "c" }}
									/>
									<CopyMarkdownAction mr={mr} />
								</ActionPanel.Section>
								<ActionPanel.Section>
									{searchFurther}
									{authorKeys}
									{filterMenu}
									{refresh}
								</ActionPanel.Section>
							</ActionPanel>
						}
					/>
				))}
			</List.Section>
		</List>
	);
}

function rowAccessories(
	mr: MergeRequest,
	showingDetail: boolean,
): List.Item.Accessory[] {
	const pipeline = pipelineAccessory(mr.pipelineStatus);
	// the side panel leaves room for one small icon
	if (showingDetail) return [pipeline];
	const updated = new Date(mr.updatedAt);
	// Raycast lines accessories up from the right edge: the fixed-width icons go
	// last so they stay in columns, and what changes width — the draft tag, the
	// date — sits to their left, where it moves nothing but itself
	return [
		...(mr.draft ? [{ tag: { value: "draft", color: Color.Orange } }] : []),
		{ date: updated, tooltip: `Updated ${updated.toLocaleString()}` },
		{ icon: avatar(mr.author), tooltip: `@${mr.author.username}` },
		pipeline,
	];
}

function PeopleDropdown(props: {
	claude: string;
	people: People;
	onChange: (people: People) => void;
}) {
	const value = encodePeople(props.people);
	const presets: [string, string][] = [
		["any", "Anyone"],
		["author:me", "By Me"],
		[`author:${props.claude}`, "By Claude"],
	];
	// anything else set under ⌘F shows as its own entry, selected
	const picked = presets.some(([preset]) => preset === value)
		? null
		: props.people;
	return (
		<List.Dropdown
			tooltip="People"
			value={value}
			// Raycast reports the current value on mount too; only a real change is one
			onChange={(next) => {
				if (next !== value) props.onChange(decodePeople(next));
			}}
		>
			{presets.map(([preset, title]) => (
				<List.Dropdown.Item key={preset} value={preset} title={title} />
			))}
			{picked ? (
				<List.Dropdown.Section title="Picked">
					<List.Dropdown.Item
						value={value}
						title={`${ROLE_TITLE[picked.role]}: ${picked.who === "me" ? "Me" : `@${picked.who}`}`}
					/>
				</List.Dropdown.Section>
			) : null}
		</List.Dropdown>
	);
}

function DetailPanel(props: {
	host: Host;
	project: Project;
	mr: MergeRequest;
	detail?: MergeRequestDetail;
	isLoading: boolean;
}) {
	const { mr, detail } = props;
	const origin = new URL(props.host.webUrl).origin;
	const body = detail
		? absolutizeMarkdown(detail.description, origin, props.project.webUrl)
		: "";
	const Metadata = List.Item.Detail.Metadata;
	return (
		<List.Item.Detail
			isLoading={props.isLoading && !detail}
			markdown={`# ${mr.title}\n\n${body}`}
			metadata={
				detail ? (
					<Metadata>
						<Metadata.Label
							title="State"
							text={mr.draft ? `${mr.state} · draft` : mr.state}
							icon={STATE_ICON[mr.state]}
						/>
						{detail.pipeline?.webUrl ? (
							<Metadata.Link
								title="Pipeline"
								text={detail.pipeline.status.toLowerCase()}
								target={detail.pipeline.webUrl}
							/>
						) : (
							<Metadata.Label
								title="Pipeline"
								text={
									detail.pipeline
										? detail.pipeline.status.toLowerCase()
										: "none"
								}
							/>
						)}
						<Metadata.Label
							title="Author"
							text={`@${mr.author.username}`}
							icon={avatar(mr.author)}
						/>
						{detail.reviewers.length > 0 ? (
							<Metadata.TagList title="Reviewers">
								{detail.reviewers.map((reviewer) => (
									<Metadata.TagList.Item
										key={reviewer.username}
										text={`${reviewer.approved ? "✓ " : ""}@${reviewer.username}`}
										color={reviewer.approved ? Color.Green : undefined}
									/>
								))}
							</Metadata.TagList>
						) : null}
						{detail.assignees.length > 0 ? (
							<Metadata.TagList title="Assignees">
								{detail.assignees.map((username) => (
									<Metadata.TagList.Item key={username} text={`@${username}`} />
								))}
							</Metadata.TagList>
						) : null}
						<Metadata.Label
							title="Branches"
							text={`${detail.sourceBranch} → ${detail.targetBranch}`}
						/>
						{detail.labels.length > 0 ? (
							<Metadata.TagList title="Labels">
								{detail.labels.map((label) => (
									<Metadata.TagList.Item
										key={label.title}
										text={label.title}
										color={label.color}
									/>
								))}
							</Metadata.TagList>
						) : null}
						{detail.conflicts ? (
							<Metadata.Label
								title="Conflicts"
								text="yes"
								icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
							/>
						) : null}
						<Metadata.Separator />
						<Metadata.Label
							title="Created"
							text={new Date(detail.createdAt).toLocaleString()}
						/>
						<Metadata.Label
							title="Updated"
							text={new Date(detail.updatedAt).toLocaleString()}
						/>
						<Metadata.Link
							title="Link"
							text={`!${mr.iid}`}
							target={mr.webUrl}
						/>
					</Metadata>
				) : undefined
			}
		/>
	);
}
