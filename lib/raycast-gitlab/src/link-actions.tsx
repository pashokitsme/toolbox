// Copying a merge request, the same wherever it is listed: a link titled with
// its name (the pair `glmr -y` copies) or the same as markdown.

import { Action, Clipboard, Icon, Keyboard, showHUD } from "@raycast/api";
import { markdownLink, richLink } from "./copy";
import type { MergeRequest } from "./queries";

type Linkable = Pick<MergeRequest, "iid" | "title" | "webUrl">;

export function CopyLinkAction(props: {
	mr: Linkable;
	shortcut?: Keyboard.Shortcut;
}) {
	return (
		<Action
			title="Copy Link"
			icon={Icon.Link}
			shortcut={props.shortcut}
			onAction={async () => {
				await Clipboard.copy(richLink(props.mr.title, props.mr.webUrl));
				await showHUD(`Copied !${props.mr.iid}`);
			}}
		/>
	);
}

export function CopyMarkdownAction(props: { mr: Linkable }) {
	return (
		<Action.CopyToClipboard
			title="Copy as Markdown"
			content={markdownLink(props.mr.title, props.mr.webUrl)}
			shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
		/>
	);
}
