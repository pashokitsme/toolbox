// Icons and labels shared by the screens.

import { Color, Icon, Image, List } from "@raycast/api";
import { getAvatarIcon } from "@raycast/utils";
import { pipelineMatches, type Role } from "./filters";
import type { MergeRequestState } from "./queries";

export const avatar = (person: {
	name: string;
	avatarUrl?: string;
}): Image.ImageLike =>
	person.avatarUrl
		? {
				source: person.avatarUrl,
				// uploads behind a login do not load for Raycast
				fallback: getAvatarIcon(person.name),
				mask: Image.Mask.Circle,
			}
		: getAvatarIcon(person.name);

export const STATE_ICON: Record<MergeRequestState, Image.ImageLike> = {
	opened: { source: Icon.Circle, tintColor: Color.Green },
	merged: { source: Icon.CheckCircle, tintColor: Color.Purple },
	closed: { source: Icon.XMarkCircle, tintColor: Color.Red },
	locked: { source: Icon.MinusCircle, tintColor: Color.SecondaryText },
};

export const ROLE_TITLE: Record<Role, string> = {
	author: "Author",
	reviewer: "Reviewer",
	assignee: "Assignee",
};

/** Always an icon, "no pipeline" included, so the column never goes missing. */
export function pipelineAccessory(status: string | null): List.Item.Accessory {
	if (!status)
		return {
			icon: { source: Icon.Circle, tintColor: Color.SecondaryText },
			tooltip: "No pipeline",
		};
	const tooltip = `Pipeline ${status.toLowerCase().replace(/_/g, " ")}`;
	if (pipelineMatches(status, "running"))
		return {
			icon: { source: Icon.CircleProgress, tintColor: Color.Blue },
			tooltip,
		};
	if (pipelineMatches(status, "passed"))
		return {
			icon: { source: Icon.CheckCircle, tintColor: Color.Green },
			tooltip,
		};
	if (pipelineMatches(status, "failed"))
		return {
			icon: { source: Icon.XMarkCircle, tintColor: Color.Red },
			tooltip,
		};
	return {
		icon: { source: Icon.MinusCircle, tintColor: Color.SecondaryText },
		tooltip,
	};
}
