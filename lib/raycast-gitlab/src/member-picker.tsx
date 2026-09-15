// Who a merge request filter is about, when "me" is not the answer: the
// project's members, searched on the server.

import { Action, ActionPanel, Icon, List, useNavigation } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import type { Role } from "./filters";
import type { Host } from "./glab-config";
import { avatar, ROLE_TITLE } from "./icons";
import { fetchMembers, type Project } from "./queries";

export function MemberPicker(props: {
	host: Host;
	project: Project;
	role: Role;
	onPick: (username: string) => void;
}) {
	const { pop } = useNavigation();
	const [searchText, setSearchText] = useState("");
	const members = useCachedPromise(
		(_host: string, fullPath: string, search: string) =>
			async ({ cursor }: { cursor?: string | null }) => {
				const page = await fetchMembers(
					props.host,
					fullPath,
					search,
					cursor ?? null,
				);
				return { data: page.items, hasMore: page.hasMore, cursor: page.cursor };
			},
		[props.host.host, props.project.fullPath, searchText],
		{ keepPreviousData: true },
	);

	return (
		<List
			navigationTitle={`${ROLE_TITLE[props.role]} in ${props.project.name}`}
			searchBarPlaceholder="Search people"
			isLoading={members.isLoading}
			onSearchTextChange={setSearchText}
			throttle
			pagination={members.pagination}
		>
			{(members.data ?? []).map((person, index) => (
				<List.Item
					// direct and inherited memberships can list one person twice
					key={`${person.username}-${index}`}
					title={person.name}
					subtitle={`@${person.username}`}
					icon={avatar(person)}
					actions={
						<ActionPanel>
							<Action
								title={`Filter by ${ROLE_TITLE[props.role]}`}
								icon={Icon.Person}
								onAction={() => {
									props.onPick(person.username);
									pop();
								}}
							/>
						</ActionPanel>
					}
				/>
			))}
		</List>
	);
}
