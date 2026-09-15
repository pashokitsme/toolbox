// The GitLab hosts this extension can talk to, straight out of glab's own
// config — the same tokens `glab auth login` saved. Raycast gives an extension
// none of the shell's environment, so GITLAB_TOKEN and GLAB_CONFIG_DIR are not
// consulted, and glab itself is never run.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export type Host = {
	host: string;
	apiUrl: string;
	webUrl: string;
	token: string;
};

export const GLAB_CONFIG_PATHS = [
	join(homedir(), "Library", "Application Support", "glab-cli", "config.yml"),
	join(homedir(), ".config", "glab-cli", "config.yml"),
];

const text = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";

export function parseGlabConfig(source: string): Host[] {
	const config = parse(source) as {
		hosts?: Record<string, Record<string, unknown> | null>;
	} | null;
	return Object.entries(config?.hosts ?? {}).flatMap(([host, entry]) => {
		const token = text(entry?.token);
		// a host without a token in the file keeps it in the keychain, or has none
		if (!token) return [];
		const protocol = text(entry?.api_protocol) || "https";
		const apiHost = text(entry?.api_host) || host;
		const subfolder = text(entry?.subfolder).replace(/^\/+|\/+$/g, "");
		const suffix = subfolder ? `/${subfolder}` : "";
		return [
			{
				host,
				apiUrl: `${protocol}://${apiHost}${suffix}`,
				webUrl: `${protocol}://${host}${suffix}`,
				token,
			},
		];
	});
}

export async function loadHosts(
	paths: string[] = GLAB_CONFIG_PATHS,
): Promise<Host[]> {
	for (const path of paths) {
		let source: string;
		try {
			source = await readFile(path, "utf8");
		} catch {
			continue;
		}
		return parseGlabConfig(source);
	}
	return [];
}
