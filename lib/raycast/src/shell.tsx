// Shell — a zsh command line in Raycast. Given a command (its argument, or the
// root search text as a fallback command) it runs it straight away and shows
// the output as it comes. Without one it opens a prompt as wide as the search
// bar, over the commands run before. Commands run from the home directory in
// an interactive login zsh; closing the view stops what is still running.

import {
	Action,
	ActionPanel,
	Detail,
	Icon,
	type LaunchProps,
	List,
	LocalStorage,
	showToast,
	Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
	appendOutput,
	type Ended,
	outputMarkdown,
	parseShellHistory,
	rememberCommand,
	runShell,
	type ShellRun,
	stripAnsi,
} from "./shell-run";

const HISTORY_KEY = "shell-history";

// output arrives in bursts; drawing each chunk would redraw markdown thousands
// of times for a chatty command
const REDRAW_MS = 100;

async function updateHistory(change: (history: string[]) => string[]) {
	const next = change(
		parseShellHistory(await LocalStorage.getItem<string>(HISTORY_KEY)),
	);
	await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(next));
	return next;
}

export default function Command(
	props: LaunchProps<{ arguments: { command?: string } }>,
) {
	const given = (props.arguments.command || props.fallbackText || "").trim();
	return given ? <Output command={given} /> : <Prompt />;
}

function Prompt() {
	const [text, setText] = useState("");
	const [history, setHistory] = useState<string[]>([]);
	const reload = () =>
		LocalStorage.getItem<string>(HISTORY_KEY).then((raw) =>
			setHistory(parseShellHistory(raw)),
		);
	useEffect(() => {
		reload();
	}, []);

	const line = text.trim();
	const needle = line.toLowerCase();
	const earlier = history.filter(
		(entry) => entry !== line && entry.toLowerCase().includes(needle),
	);

	const runAction = (command: string) => (
		<Action.Push
			title="Run"
			icon={Icon.Play}
			target={<Output command={command} />}
			onPop={reload}
		/>
	);

	return (
		<List
			navigationTitle="Shell"
			searchBarPlaceholder="zsh command, runs in ~"
			searchText={text}
			onSearchTextChange={setText}
			filtering={false}
		>
			{line ? (
				<List.Section title="Run">
					<List.Item
						icon={Icon.Terminal}
						title={line}
						actions={<ActionPanel>{runAction(line)}</ActionPanel>}
					/>
				</List.Section>
			) : null}
			<List.Section title="History">
				{earlier.map((entry) => (
					<List.Item
						key={entry}
						icon={Icon.Clock}
						title={entry}
						actions={
							<ActionPanel>
								{runAction(entry)}
								<Action
									title="Edit"
									icon={Icon.Pencil}
									shortcut={{ modifiers: ["cmd"], key: "e" }}
									onAction={() => setText(entry)}
								/>
								<Action
									title="Remove from History"
									icon={Icon.Trash}
									style={Action.Style.Destructive}
									shortcut={{ modifiers: ["cmd"], key: "backspace" }}
									onAction={async () =>
										setHistory(
											await updateHistory((current) =>
												current.filter((kept) => kept !== entry),
											),
										)
									}
								/>
							</ActionPanel>
						}
					/>
				))}
			</List.Section>
			<List.EmptyView
				icon={Icon.Terminal}
				title="Type a command"
				description="It runs in zsh from your home directory, with your ~/.zshrc"
			/>
		</List>
	);
}

function Output(props: { command: string }) {
	const { command } = props;
	const [output, setOutput] = useState("");
	const [ended, setEnded] = useState<Ended>(null);
	const [runs, setRuns] = useState(0);
	const [current, setCurrent] = useState<ShellRun | null>(null);

	useEffect(() => {
		// a rerun or leaving the view ends this run; nothing it reports after that counts
		let alive = true;
		let pending = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = () => {
			timer = undefined;
			const chunk = pending;
			pending = "";
			if (alive && chunk) setOutput((shown) => appendOutput(shown, chunk));
		};

		setOutput("");
		setEnded(null);
		updateHistory((history) => rememberCommand(history, command));

		const run = runShell(command, {
			onOutput: (chunk) => {
				pending = appendOutput(pending, chunk);
				timer ??= setTimeout(flush, REDRAW_MS);
			},
		});
		setCurrent(run);
		run.done.then((result) => {
			if (timer) clearTimeout(timer);
			flush();
			if (!alive) return;
			setEnded(result);
			if (result !== 0)
				showToast({
					style: Toast.Style.Failure,
					title:
						typeof result === "string"
							? `Stopped (${result})`
							: `Exited with ${result}`,
				});
		});

		return () => {
			alive = false;
			run.stop();
		};
	}, [command, runs]);

	const text = stripAnsi(output);
	return (
		<Detail
			navigationTitle={command}
			isLoading={ended === null}
			markdown={outputMarkdown(command, text, ended)}
			actions={
				<ActionPanel>
					{ended === null ? (
						<Action
							title="Stop"
							icon={Icon.Stop}
							shortcut={{ modifiers: ["cmd"], key: "." }}
							onAction={() => current?.stop()}
						/>
					) : null}
					<Action.CopyToClipboard
						title="Copy Output"
						content={text}
						shortcut={{ modifiers: ["cmd"], key: "c" }}
					/>
					<Action
						title="Run Again"
						icon={Icon.ArrowClockwise}
						shortcut={{ modifiers: ["cmd"], key: "r" }}
						onAction={() => setRuns((count) => count + 1)}
					/>
					<Action.CopyToClipboard
						title="Copy Command"
						content={command}
						shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
					/>
				</ActionPanel>
			}
		/>
	);
}
