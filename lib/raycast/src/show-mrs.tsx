// GitLab: Show MRs — pick a project, then its merge requests. Projects come in
// the order you last opened them here, then GitLab's own frecent ones, then
// the rest by activity. A merge request link pasted into the search turns
// into that merge request, ready to copy as a link titled with its name.

import {
	Action,
	ActionPanel,
	environment,
	Icon,
	Image,
	List,
	LocalStorage,
} from "@raycast/api";
import {
	getAvatarIcon,
	useCachedPromise,
	useCachedState,
	usePromise,
} from "@raycast/utils";
import { join } from "node:path";
import { useEffect, useRef, useState } from "react";
import { projectAvatarFile } from "./avatars";
import { loadHosts, type Host } from "./glab-config";
import { AuthError } from "./gitlab";
import { MergeRequests } from "./merge-requests";
import { LinkedMergeRequest } from "./linked-merge-request";
import { parseMergeRequestLink } from "./mr-link";
import {
	fetchFrecentProjects,
	fetchMergeRequest,
	fetchProjects,
	MIN_SEARCH,
} from "./queries";
import {
	orderProjects,
	parseHistory,
	recentKey,
	recordOpen,
	removeRecent,
	type RecentProject,
} from "./recent";

export default function Command() {
	// not useCachedPromise: a Host carries its token, and Raycast's cache is a plain file
	const hosts = usePromise(loadHosts);
	const [hostName, setHostName] = useCachedState("host", "");
	const available = hosts.data ?? [];
	const host =
		available.find((candidate) => candidate.host === hostName) ?? available[0];

	if (!hosts.isLoading && !host) {
		return (
			<List>
				<List.EmptyView
					icon={Icon.XMarkCircle}
					title="No GitLab token in glab's config"
					description="Run: glab auth login --hostname <host>"
				/>
			</List>
		);
	}
	if (!host) return <List isLoading />;
	return (
		<ProjectPicker
			key={host.host}
			host={host}
			hosts={available}
			onHostChange={setHostName}
		/>
	);
}

function ProjectPicker(props: {
	host: Host;
	hosts: Host[];
	onHostChange: (host: string) => void;
}) {
	const { host } = props;
	const [searchText, setSearchText] = useState("");
	const [history, setHistory] = useState<RecentProject[]>([]);

	useEffect(() => {
		LocalStorage.getItem<string>(recentKey(host.host)).then((raw) =>
			setHistory(parseHistory(raw)),
		);
	}, [host.host]);

	// read what is stored rather than the state: ↵ can come before the first
	// read has landed, and saving over it then would wipe the history
	const updateHistory = async (
		change: (history: RecentProject[]) => RecentProject[],
	) => {
		const key = recentKey(host.host);
		const next = change(parseHistory(await LocalStorage.getItem<string>(key)));
		await LocalStorage.setItem(key, JSON.stringify(next));
		setHistory(next);
	};

	const frecent = useCachedPromise(
		(_host: string) => fetchFrecentProjects(host),
		[host.host],
	);

	const link = parseMergeRequestLink(searchText, props.hosts);
	const known = link?.kind === "known" ? link : null;
	const linked = useCachedPromise(
		(_host: string, fullPath: string, iid: string) =>
			// execute is off without a link, so known is there when this runs
			fetchMergeRequest(known?.host ?? host, fullPath, iid),
		[known?.host.host ?? "", known?.fullPath ?? "", known?.iid ?? ""],
		{ execute: Boolean(known) },
	);

	const trimmed = searchText.trim();
	// a pasted link is not a project name to look for
	const serverSearch = !link && trimmed.length >= MIN_SEARCH ? trimmed : "";
	const server = useCachedPromise(
		(_host: string, search: string) =>
			async ({ cursor }: { cursor?: string | null }) => {
				const page = await fetchProjects(host, search, cursor ?? null);
				return { data: page.items, hasMore: page.hasMore, cursor: page.cursor };
			},
		// no keepPreviousData: a page kept from another search would pass for
		// matches of this one in orderProjects
		[host.host, serverSearch],
	);

	const listed = link
		? []
		: orderProjects({
				history,
				frecent: frecent.data ?? [],
				server: server.data ?? [],
				searchText,
			});
	const avatarFiles = useAvatarFiles(
		host,
		listed.map((entry) => entry.project),
	);
	const authError = [frecent.error, server.error].find(
		(error) => error instanceof AuthError,
	);

	return (
		<List
			searchBarPlaceholder="Search projects, or paste a merge request link"
			isLoading={
				frecent.isLoading || server.isLoading || (known ? linked.isLoading : false)
			}
			onSearchTextChange={setSearchText}
			throttle
			pagination={server.pagination}
			searchBarAccessory={
				props.hosts.length > 1 ? (
					<List.Dropdown
						tooltip="GitLab Host"
						value={host.host}
						onChange={(next) => {
							if (next !== host.host) props.onHostChange(next);
						}}
					>
						{props.hosts.map((candidate) => (
							<List.Dropdown.Item
								key={candidate.host}
								value={candidate.host}
								title={candidate.host}
							/>
						))}
					</List.Dropdown>
				) : undefined
			}
		>
			{link ? (
				<LinkedMergeRequest
					link={link}
					mr={
						// the hook keeps the last link's merge request while the next one loads
						linked.data?.webUrl && known && linked.data.iid === known.iid
							? linked.data
							: undefined
					}
					error={linked.error}
				/>
			) : null}
			{authError ? (
				<List.EmptyView
					icon={Icon.XMarkCircle}
					title={authError.message}
					description={`Run: glab auth login --hostname ${host.host}`}
				/>
			) : null}
			{listed.map(({ project, source, openedAt }) => (
				<List.Item
					key={project.fullPath}
					icon={
						avatarFiles[project.fullPath]
							? { source: avatarFiles[project.fullPath], mask: Image.Mask.Circle }
							: getAvatarIcon(project.name)
					}
					title={project.name}
					subtitle={project.fullPath}
					accessories={[
						source === "recent" && openedAt
							? {
									icon: Icon.Clock,
									date: new Date(openedAt),
									tooltip: `Opened in Raycast ${new Date(openedAt).toLocaleString()}`,
								}
							: {
									date: new Date(project.lastActivityAt),
									tooltip: `Last activity ${new Date(project.lastActivityAt).toLocaleString()}`,
								},
					]}
					actions={
						<ActionPanel>
							<Action.Push
								title="Show Merge Requests"
								target={<MergeRequests host={host} project={project} />}
								onPush={() =>
									updateHistory((current) => recordOpen(current, project, new Date()))
								}
							/>
							<Action.OpenInBrowser
								url={project.webUrl}
								shortcut={{ modifiers: ["shift"], key: "return" }}
							/>
							<Action.CopyToClipboard
								title="Copy Project Link"
								content={project.webUrl}
								shortcut={{ modifiers: ["cmd"], key: "c" }}
							/>
							{source === "recent" ? (
								<Action
									title="Remove from Recent"
									icon={Icon.Trash}
									style={Action.Style.Destructive}
									shortcut={{ modifiers: ["cmd"], key: "backspace" }}
									onAction={() =>
										updateHistory((current) => removeRecent(current, project.fullPath))
									}
								/>
							) : null}
						</ActionPanel>
					}
				/>
			))}
		</List>
	);
}

/** Local copies of the listed projects' avatars, by project path — each one
 *  asked for once per run, drawn once it is on disk. */
function useAvatarFiles(
	host: Host,
	projects: { fullPath: string; avatarUrl?: string }[],
): Record<string, string> {
	const [files, setFiles] = useState<Record<string, string>>({});
	const requested = useRef(new Set<string>());
	const wanted = projects.filter(
		(project) => project.avatarUrl && !requested.current.has(project.fullPath),
	);

	useEffect(() => {
		const dir = join(environment.supportPath, "avatars");
		for (const project of wanted) {
			requested.current.add(project.fullPath);
			projectAvatarFile(host, project, dir)
				.then((file) => {
					if (file) setFiles((current) => ({ ...current, [project.fullPath]: file }));
				})
				// a missing avatar keeps the letter icon; nothing to report
				.catch(() => {});
		}
	}, [wanted.map((project) => project.fullPath).join("\n")]);

	return files;
}
