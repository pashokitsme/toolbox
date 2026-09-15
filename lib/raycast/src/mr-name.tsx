// GitLab: MR Name — a merge request link in, the same link titled with the
// merge request's name out, on the clipboard. Given a link (its argument, or
// the root search text as a fallback command) it copies straight away and
// closes Raycast. Without one it opens a prompt as wide as the search bar,
// filled in with the clipboard when that holds a link, where ↵ copies.

import {
	Clipboard,
	Detail,
	Icon,
	type LaunchProps,
	List,
	PopToRootType,
	showHUD,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useEffect, useState } from "react";
import { richLink } from "./copy";
import { type Host, loadHosts } from "./glab-config";
import { LinkedMergeRequest } from "./linked-merge-request";
import { type MergeRequestLink, parseMergeRequestLink } from "./mr-link";
import { fetchMergeRequest } from "./queries";
import { rowTitle } from "./title";

type KnownLink = Extract<MergeRequestLink, { kind: "known" }>;

export default function Command(
	props: LaunchProps<{ arguments: { link?: string } }>,
) {
	// not useCachedPromise: a Host carries its token, and Raycast's cache is a plain file
	const hosts = usePromise(loadHosts);
	if (hosts.isLoading || !hosts.data) return <List isLoading />;

	const given = (props.arguments.link || props.fallbackText || "").trim();
	const link = given ? parseMergeRequestLink(given, hosts.data) : null;
	return link?.kind === "known" ? (
		<CopyNow link={link} />
	) : (
		<Prompt hosts={hosts.data} initial={given} />
	);
}

function CopyNow(props: { link: KnownLink }) {
	const { link } = props;
	const [error, setError] = useState<string>();

	useEffect(() => {
		let alive = true;
		fetchMergeRequest(link.host, link.fullPath, link.iid)
			.then(async (mr) => {
				await Clipboard.copy(richLink(mr.title, mr.webUrl));
				await showHUD(`Copied !${mr.iid} — ${rowTitle(mr.title, mr.draft)}`, {
					clearRootSearch: true,
					popToRootType: PopToRootType.Immediate,
				});
			})
			.catch((reason: unknown) => {
				if (alive)
					setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			alive = false;
		};
	}, [link.host.host, link.fullPath, link.iid]);

	return (
		<Detail
			isLoading={!error}
			markdown={
				error
					? `# Nothing copied\n\n${error}`
					: `Looking up !${link.iid} in ${link.fullPath}…`
			}
		/>
	);
}

function Prompt(props: { hosts: Host[]; initial: string }) {
	const [text, setText] = useState(props.initial);

	// a link already on the clipboard is what the prompt is most likely for
	useEffect(() => {
		if (props.initial) return;
		Clipboard.readText().then((clipboard) => {
			const candidate = clipboard?.trim() ?? "";
			if (parseMergeRequestLink(candidate, props.hosts))
				setText((typed) => typed || candidate);
		});
	}, []);

	const link = parseMergeRequestLink(text, props.hosts);
	const known = link?.kind === "known" ? link : null;
	const merged = usePromise(
		(host: Host | undefined, fullPath: string, iid: string) =>
			host
				? fetchMergeRequest(host, fullPath, iid)
				: Promise.resolve(undefined),
		[known?.host, known?.fullPath ?? "", known?.iid ?? ""],
		{ execute: Boolean(known) },
	);

	return (
		<List
			navigationTitle="GitLab: MR Name"
			searchBarPlaceholder="Paste a merge request link"
			searchText={text}
			onSearchTextChange={setText}
			filtering={false}
			isLoading={known ? merged.isLoading : false}
		>
			{link ? (
				<LinkedMergeRequest
					link={link}
					mr={
						// the hook keeps the last link's merge request while the next one loads
						known && merged.data?.iid === known.iid ? merged.data : undefined
					}
					error={merged.error}
				/>
			) : (
				<List.EmptyView
					icon={Icon.Link}
					title={
						text.trim()
							? "Not a merge request link"
							: "Paste a merge request link"
					}
					description="It is copied as a link titled with the merge request's name"
				/>
			)}
		</List>
	);
}
