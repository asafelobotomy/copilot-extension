import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

function jsonResult(obj: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(obj)),
	]);
}

function getWorkspaceRoot(): string | null {
	const folders = vscode.workspace.workspaceFolders;
	return folders?.length ? folders[0].uri.fsPath : null;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return typeof data === "object" && data !== null ? data : null;
	} catch {
		return null;
	}
}

function getWorkspacePaths(root: string) {
	const ws = path.join(root, ".copilot", "workspace");
	return {
		workspace: ws,
		state: path.join(ws, "runtime", "state.json"),
		events: path.join(ws, "runtime", ".heartbeat-events.jsonl"),
		sentinel: path.join(ws, "runtime", ".heartbeat-session"),
		heartbeat: path.join(ws, "operations", "HEARTBEAT.md"),
		soul: path.join(ws, "identity", "SOUL.md"),
		memory: path.join(ws, "knowledge", "MEMORY.md"),
		user: path.join(ws, "knowledge", "USER.md"),
		diaries: path.join(ws, "knowledge", "diaries"),
		ledger: path.join(ws, "operations", "ledger.md"),
	};
}

function isoUtc(epochSeconds: number): string {
	return new Date(epochSeconds * 1000)
		.toISOString()
		.replace(/\.\d+Z$/, "Z");
}

function ensureParentDir(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath: string, payload: unknown): void {
	ensureParentDir(filePath);
	fs.writeFileSync(
		filePath,
		`${JSON.stringify(payload, null, 2)}\n`,
		"utf-8"
	);
}

function persistReflectionCompletion(
	paths: ReturnType<typeof getWorkspacePaths>,
	state: Record<string, unknown>,
	now: number
): {
	updatedState: Record<string, unknown>;
	markers: {
		state: boolean;
		sentinel: boolean;
		event: boolean;
	};
	errors: string[];
} {
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
		writeJsonFile(paths.state, updatedState);
		markers.state = true;
	} catch (error) {
		errors.push(
			`state: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	try {
		ensureParentDir(paths.sentinel);
		fs.writeFileSync(
			paths.sentinel,
			`${sessionId}|${isoUtc(now)}|complete\n`,
			"utf-8"
		);
		markers.sentinel = true;
	} catch (error) {
		errors.push(
			`sentinel: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	try {
		ensureParentDir(paths.events);
		fs.appendFileSync(
			paths.events,
			`${JSON.stringify({
				detail: "complete",
				session_id: sessionId,
				trigger: "session_reflect",
				ts: now,
				ts_utc: isoUtc(now),
			})}\n`,
			"utf-8"
		);
		markers.event = true;
	} catch (error) {
		errors.push(
			`event: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	return { updatedState, markers, errors };
}

function loadState(statePath: string): Record<string, unknown> {
	return readJsonFile(statePath) ?? {};
}

function loadRecentEvents(
	eventsPath: string,
	limit: number = 50
): Record<string, unknown>[] {
	try {
		const raw = fs.readFileSync(eventsPath, "utf-8");
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
	} catch {
		return [];
	}
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

function loadWorkspaceCues(paths: ReturnType<typeof getWorkspacePaths>): {
	soulValues: string[];
	userAttributes: string[];
} {
	const cues = { soulValues: [] as string[], userAttributes: [] as string[] };

	// SOUL.md — extract bold values
	try {
		const soul = fs.readFileSync(paths.soul, "utf-8");
		for (const line of soul.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- **") && trimmed.indexOf("**", 4) > 4) {
				const key = trimmed.slice(4, trimmed.indexOf("**", 4));
				cues.soulValues.push(key);
				if (cues.soulValues.length >= 5) break;
			}
		}
	} catch {
		// SOUL.md not present
	}

	// USER.md — extract table attributes
	try {
		const user = fs.readFileSync(paths.user, "utf-8");
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
	} catch {
		// USER.md not present
	}

	return cues;
}

function readDiarySummaries(
	diariesDir: string,
	maxEntries: number = 3
): Record<string, string[]> {
	const summaries: Record<string, string[]> = {};
	try {
		const files = fs
			.readdirSync(diariesDir)
			.filter((f) => f.endsWith(".md") && f !== "README.md")
			.sort();
		for (const file of files) {
			try {
				const content = fs.readFileSync(
					path.join(diariesDir, file),
					"utf-8"
				);
				const bulletLines = content
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.startsWith("- "));
				if (bulletLines.length > 0) {
					summaries[file.replace(".md", "")] =
						bulletLines.slice(-maxEntries);
				}
			} catch {
				// skip unreadable diary
			}
		}
	} catch {
		// diaries dir doesn't exist
	}
	return summaries;
}

function readVocabulary(ledgerPath: string): string[] {
	try {
		const content = fs.readFileSync(ledgerPath, "utf-8");
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
	} catch {
		return [];
	}
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
		const root = getWorkspaceRoot();
		if (!root) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const paths = getWorkspacePaths(root);
		const state = loadState(paths.state);
		const now = Math.floor(Date.now() / 1000);

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
			gitModifiedCount(root) -
				Number(state.session_start_git_count ?? 0)
		);
		const editCount = Number(state.copilot_edit_count ?? 0);
		const effectiveFiles = deltaFiles > 0 ? deltaFiles : editCount;

		const allEvents = loadRecentEvents(paths.events, 50);
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
		const cues = loadWorkspaceCues(paths);
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
		const completion = persistReflectionCompletion(paths, state, now);

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
				soul_exists: fs.existsSync(paths.soul),
				memory_exists: fs.existsSync(paths.memory),
				user_exists: fs.existsSync(paths.user),
			},
			heartbeat_record: {
				file: paths.heartbeat,
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
		const root = getWorkspaceRoot();
		if (!root) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const paths = getWorkspacePaths(root);
		const state = loadState(paths.state);

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
		const allEvents = loadRecentEvents(paths.events, 200);
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
			vocabulary: readVocabulary(paths.ledger),
			diaries: readDiarySummaries(paths.diaries),
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
