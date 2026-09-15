// A merge request a pasted link points at, as one list row: ↵ copies the link
// titled with its name. Shared by GitLab: Show MRs, where a link pasted into
// the project search becomes this row, and GitLab: MR Name.

import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { STATE_ICON } from "./icons";
import { CopyLinkAction, CopyMarkdownAction } from "./link-actions";
import { MergeRequests } from "./merge-requests";
import type { MergeRequestLink } from "./mr-link";
import type { MergeRequest, Project } from "./queries";
import { rowTitle } from "./title";

/** The merge request a pasted link points at, as one row: ↵ copies the link
 *  titled with its name. */
export function LinkedMergeRequest(props: {
	link: MergeRequestLink;
	mr?: MergeRequest;
	error?: Error;
}) {
	const { link, mr } = props;
	if (link.kind === "unknown")
		return (
			<List.EmptyView
				icon={Icon.XMarkCircle}
				title={`No token for ${link.hostName} in glab's config`}
				description={`Run: glab auth login --hostname ${link.hostName}`}
			/>
		);
	if (!mr)
		return props.error ? (
			<List.EmptyView icon={Icon.XMarkCircle} title={props.error.message} />
		) : (
			<List.EmptyView icon={Icon.Link} title={`Looking up !${link.iid}…`} />
		);

	const project: Project = {
		fullPath: link.fullPath,
		name: link.fullPath.split("/").pop() ?? link.fullPath,
		webUrl: mr.webUrl.replace(/\/-\/merge_requests\/.*$/, ""),
		lastActivityAt: mr.updatedAt,
	};
	return (
		<List.Item
			icon={{ value: STATE_ICON[mr.state], tooltip: mr.state }}
			title={{ value: rowTitle(mr.title, mr.draft), tooltip: mr.title }}
			subtitle={`!${mr.iid}`}
			accessories={[{ text: link.fullPath }]}
			actions={
				<ActionPanel>
					<CopyLinkAction mr={mr} />
					<Action.OpenInBrowser
						url={mr.webUrl}
						shortcut={{ modifiers: ["shift"], key: "return" }}
					/>
					<CopyMarkdownAction mr={mr} />
					<Action.Push
						title="Show Merge Requests of the Project"
						icon={Icon.List}
						target={<MergeRequests host={link.host} project={project} />}
					/>
				</ActionPanel>
			}
		/>
	);
}
