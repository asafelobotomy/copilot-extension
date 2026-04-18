import * as vscode from "vscode";
import { execSync } from "child_process";
import {
	appendTextFile,
	displayUriPath,
	getPrimaryWorkspaceUri,
	joinFromUri,
	pathExists,
	readJsonFile as readWorkspaceJsonFile,
	readTextFile as readWorkspaceTextFile,
	writeTextFile,
} from "../workspaceFs";

function jsonResult(obj: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(obj)),
	]);
}

function getWorkspacePaths(root: vscode.Uri) {
	const ws = joinFromUri(root, ".copilot", "workspace")!;
	return {
		workspace: ws,
		state: joinFromUri(ws, "runtime", "state.json")!,
		events: joinFromUri(ws, "runtime", ".heartbeat-events.jsonl")!,
		sentinel: joinFromUri(ws, "runtime", ".heartbeat-session")!,
		heartbeat: joinFromUri(ws, "operations", "HEARTBEAT.md")!,
		soul: joinFromUri(ws, "identity", "SOUL.md")!,
		memory: joinFromUri(ws, "knowledge", "MEMORY.md")!,
		user: joinFromUri(ws, "knowledge", "USER.md")!,
		diaries: joinFromUri(ws, "knowledge", "diaries")!,
		ledger: joinFromUri(ws, "operations", "ledger.md")!,
	};
}

function isoUtc(epochSeconds: number): string {
	return new Date(epochSeconds * 1000)
		.toISOString()
		.replace(/\.\d+Z$/, "Z");
}

async function writeJsonFile(filePath: vscode.Uri, payload: unknown): Promise<void> {
	await writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function persistReflectionCompletion(
	paths: ReturnType<typeof getWorkspacePaths>,
	state: Record<string, unknown>,
	now: number
): Promise<{
	updatedState: Record<string, unknown>;
	markers: {
		state: boolean;
		sentinel: boolean;
		event: boolean;
	};
	errors: string[];
}> {
	const sessionId = String(state.session_id ?? "unknown");
	const updatedState: Record<string, unknown> = {
		...state,
		retrospective_state: "complete",
		session_state: "complete",
		last_write_epoch: now,
	};
	const markers = {
		state: false,
		sentinel: false,
		event: false,
	};
	const errors: string[] = [];

	try {
		await writeJsonFile(paths.state, updatedState);
		markers.state = true;
	} catch (error) {
		errors.push(
			`state: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	try {
		await writeTextFile(
			paths.sentinel,
			`${sessionId}|${isoUtc(now)}|complete\n`,
		);
		markers.sentinel = true;
	} catch (error) {
		errors.push(
			`sentinel: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	try {
		await appendTextFile(
			paths.events,
			`${JSON.stringify({
				detail: "complete",
				session_id: sessionId,
				trigger: "session_reflect",
				ts: now,
				ts_utc: isoUtc(now),
			})}\n`,
		);
		markers.event = true;
	} catch (error) {
		errors.push(
			`event: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	return { updatedState, markers, errors };
}

async function loadState(statePath: vscode.Uri): Promise<Record<string, unknown>> {
	return (await readWorkspaceJsonFile<Record<string, unknown>>(statePath)) ?? {};
}

async function loadRecentEvents(
	eventsPath: vscode.Uri,
	limit: number = 50
): Promise<Record<string, unknown>[]> {
	const raw = await readWorkspaceTextFile(eventsPath);
	if (!raw) {
		return [];
	}

	const lines = raw.split("\n").filter((l) => l.trim());
	return lines
		.slice(-limit)
		.map((l) => {
			try {
				return JSON.parse(l) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((e): e is Record<string, unknown> => e !== null);
}

function gitModifiedCount(root: string): number {
	try {
		const output = execSync("git status --porcelain", {
			cwd: root,
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return output
			.split("\n")
			.filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

function sessionEventsFilter(
	events: Record<string, unknown>[],
	state: Record<string, unknown>
): Record<string, unknown>[] {
	const sessionId = String(state.session_id ?? "");
	const sessionStart = Number(state.session_start_epoch ?? 0);
	return events.filter((event) => {
		const eventSessionId = String(event.session_id ?? "");
		if (sessionId && eventSessionId) {
			return eventSessionId === sessionId;
		}
		const eventTs = Number(event.ts ?? 0);
		if (sessionStart > 0 && eventTs > 0) {
			return eventTs >= sessionStart;
		}
		return true;
	});
}

async function loadWorkspaceCues(paths: ReturnType<typeof getWorkspacePaths>): Promise<{
	soulValues: string[];
	userAttributes: string[];
}> {
	const cues = { soulValues: [] as string[], userAttributes: [] as string[] };

	// SOUL.md — extract bold values
	const soul = await readWorkspaceTextFile(paths.soul);
	if (soul) {
		for (const line of soul.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- **") && trimmed.indexOf("**", 4) > 4) {
				const key = trimmed.slice(4, trimmed.indexOf("**", 4));
				cues.soulValues.push(key);
				if (cues.soulValues.length >= 5) break;
			}
		}
	}

	// USER.md — extract table attributes
	const user = await readWorkspaceTextFile(paths.user);
	if (user) {
		let inTable = false;
		for (const line of user.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("| Attribute")) {
				inTable = true;
				continue;
			}
			if (inTable && trimmed.startsWith("|")) {
				if (trimmed.replace(/[|\- ]/g, "") === "") continue;
				const cells = trimmed
					.replace(/^\||\|$/g, "")
					.split("|")
					.map((c) => c.trim());
				if (
					cells.length >= 2 &&
					cells[1] &&
					!cells[1].includes("to be discovered")
				) {
					cues.userAttributes.push(`${cells[0]}: ${cells[1].slice(0, 80)}`);
					if (cues.userAttributes.length >= 3) break;
				}
			} else if (inTable && !trimmed.startsWith("|")) {
				inTable = false;
			}
		}
	}

	return cues;
}

async function readDiarySummaries(
	diariesDir: vscode.Uri,
	maxEntries: number = 3
): Promise<Record<string, string[]>> {
	const summaries: Record<string, string[]> = {};
	if (!(await pathExists(diariesDir))) {
		return summaries;
	}

	const entries = await vscode.workspace.fs.readDirectory(diariesDir);
	const files = entries
		.filter(
			([name, type]) =>
				(type & vscode.FileType.File) !== 0 && name.endsWith(".md") && name !== "README.md"
		)
		.map(([name]) => name)
		.sort();

	for (const file of files) {
		const content = await readWorkspaceTextFile(joinFromUri(diariesDir, file));
		if (!content) {
			continue;
		}

		const bulletLines = content
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("- "));
		if (bulletLines.length > 0) {
			summaries[file.replace(".md", "")] = bulletLines.slice(-maxEntries);
		}
	}

	return summaries;
}

async function readVocabulary(ledgerPath: vscode.Uri): Promise<string[]> {
	const content = await readWorkspaceTextFile(ledgerPath);
	if (!content) {
		return [];
	}

	const vocab: string[] = [];
	let inTable = false;
	for (const line of content.split("\n")) {
		if (line.includes("|") && (line.includes("Term") || line.includes("Meaning"))) {
			inTable = true;
			continue;
		}
		if (inTable && line.startsWith("|")) {
			if (line.replace(/[|\- ]/g, "").trim()) {
				vocab.push(line.trim());
			}
		} else if (inTable && !line.startsWith("|")) {
			break;
		}
	}
	return vocab;
}

function formatDuration(seconds: number): string {
	seconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours) return `${hours}h ${minutes}m`;
	if (minutes) return minutes < 10 ? `${minutes}m ${secs}s` : `${minutes}m`;
	return `${secs}s`;
}

// ── SessionReflectTool ──────────────────────────────────────────────
// Replaces: mcp-heartbeat-server.py session_reflect() MCP tool
class SessionReflectTool
	implements vscode.LanguageModelTool<Record<string, never>>
{
	async prepareInvocation() {
		return { invocationMessage: "Reflecting on current session…" };
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const rootUri = getPrimaryWorkspaceUri();
		if (!rootUri) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const paths = getWorkspacePaths(rootUri);
		const state = await loadState(paths.state);
		const now = Math.floor(Date.now() / 1000);
		const localRoot = rootUri.scheme === "file" ? rootUri.fsPath : null;

		// Metrics
		const sessionStart = Number(state.session_start_epoch ?? 0);
		const sessionDurationS = sessionStart
			? Math.max(0, now - sessionStart)
			: 0;

		let activeS = Number(state.active_work_seconds ?? 0);
		const twStart = Number(state.task_window_start_epoch ?? 0);
		const lastTool = Number(state.last_raw_tool_epoch ?? 0);
		if (twStart > 0 && lastTool >= twStart) {
			activeS += Math.max(0, lastTool - twStart);
		}

		const deltaFiles = Math.max(
			0,
			(localRoot ? gitModifiedCount(localRoot) : 0) -
				Number(state.session_start_git_count ?? 0)
		);
		const editCount = Number(state.copilot_edit_count ?? 0);
		const effectiveFiles = deltaFiles > 0 ? deltaFiles : editCount;

		const allEvents = await loadRecentEvents(paths.events, 50);
		const sessionEvents = sessionEventsFilter(allEvents, state);
		const compactions = sessionEvents.filter(
			(e) => e.trigger === "compaction"
		).length;

		// Magnitude
		const activeMin = Math.floor(activeS / 60);
		let magnitude: string;
		if (effectiveFiles >= 8 || activeMin >= 30) {
			magnitude = "large";
		} else if (effectiveFiles >= 5 || activeMin >= 15) {
			magnitude = "medium";
		} else {
			magnitude = "small";
		}

		// Reflection prompts
		const prompts: string[] = [];
		if (effectiveFiles > 0) {
			const label =
				deltaFiles > 0 ? "files changed" : "files edited (committed)";
			prompts.push(
				`${effectiveFiles} ${label}, ${activeMin}min — check accuracy+scope`
			);
		}
		if (compactions > 0) {
			prompts.push("Compaction — verify no decisions lost");
		}
		if (effectiveFiles >= 5) {
			prompts.push("Test coverage and docs kept pace?");
		}

		// Personalised cues
		const cues = await loadWorkspaceCues(paths);
		if (cues.soulValues.length > 0) {
			prompts.push(
				`SOUL values: ${cues.soulValues.slice(0, 3).join(", ")} — honoured?`
			);
		}
		if (cues.userAttributes.length > 0) {
			prompts.push(`USER: ${cues.userAttributes[0]} — aligned?`);
		}

		const today = new Date().toISOString().split("T")[0];
		const sessionId = String(state.session_id ?? "unknown");
		const shortId = sessionId.slice(0, 16);
		const completion = await persistReflectionCompletion(paths, state, now);

		return jsonResult({
			magnitude,
			metrics: {
				active_work_minutes: activeMin,
				files_changed: effectiveFiles,
				edits_tracked: editCount,
				compactions,
				session_duration_minutes: Math.floor(sessionDurationS / 60),
			},
			reflection_prompts: prompts,
			memory_protocol: "See §14 Alignment Protocol.",
			workspace_state: {
				soul_exists: await pathExists(paths.soul),
				memory_exists: await pathExists(paths.memory),
				user_exists: await pathExists(paths.user),
			},
			heartbeat_record: {
				file: displayUriPath(paths.heartbeat),
				instruction:
					"Append to ## History (keep last 5); set Result (PASS/WARN/FAIL) and Actions taken.",
				row_template: `| ${today} | ${shortId} | session_reflect | PASS | <actions taken> |`,
			},
			completion: {
				recorded: completion.errors.length === 0,
				markers: completion.markers,
				errors: completion.errors,
			},
		});
	}
}

// ── SpatialStatusTool ───────────────────────────────────────────────
// Replaces: mcp-heartbeat-server.py spatial_status() MCP tool
class SpatialStatusTool
	implements vscode.LanguageModelTool<Record<string, never>>
{
	async prepareInvocation() {
		return { invocationMessage: "Reading workspace spatial status…" };
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const rootUri = getPrimaryWorkspaceUri();
		if (!rootUri) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const paths = getWorkspacePaths(rootUri);
		const state = await loadState(paths.state);

		// Clock summary (replicates heartbeat_clock_summary.py logic)
		const now = Math.floor(Date.now() / 1000);
		const clockParts: string[] = [];

		const startEpoch = Number(state.session_start_epoch ?? 0);
		const sessionId = String(state.session_id ?? "unknown");
		const sessionState = String(state.session_state ?? "");
		if (startEpoch && sessionState !== "complete") {
			const activeFor = formatDuration(now - startEpoch);
			const startedAt = new Date(startEpoch * 1000)
				.toISOString()
				.replace(/\.\d+Z$/, "Z");
			clockParts.push(
				`session ${sessionId} active for ${activeFor} since ${startedAt} UTC`
			);
		}

		// Median session duration from completed events
		const allEvents = await loadRecentEvents(paths.events, 200);
		const completedDurations = allEvents
			.filter(
				(e) => e.trigger === "stop" && e.detail === "complete"
			)
			.map((e) => Number(e.duration_s))
			.filter((d) => d > 0)
			.sort((a, b) => a - b);

		if (completedDurations.length > 0) {
			const mid = Math.floor(completedDurations.length / 2);
			const median =
				completedDurations.length % 2
					? completedDurations[mid]
					: Math.floor(
							(completedDurations[mid - 1] + completedDurations[mid]) / 2
						);
			clockParts.push(
				`typical session ${formatDuration(median)} (median of ${completedDurations.length})`
			);
		}

		const clock =
			clockParts.length > 0 ? clockParts.join("; ") : "no session data";

		return jsonResult({
			vocabulary: await readVocabulary(paths.ledger),
			diaries: await readDiarySummaries(paths.diaries),
			clock,
		});
	}
}

export function registerHeartbeatTools(
	context: vscode.ExtensionContext
): void {
	context.subscriptions.push(
		vscode.lm.registerTool(
			"asafelobotomy_session_reflect",
			new SessionReflectTool()
		),
		vscode.lm.registerTool(
			"asafelobotomy_spatial_status",
			new SpatialStatusTool()
		)
	);
}
