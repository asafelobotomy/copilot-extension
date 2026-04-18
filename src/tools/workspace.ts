import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
	displayUriPath,
	getPrimaryWorkspaceUri,
	joinFromUri,
	pathExists,
	readJsonFile as readWorkspaceJsonFile,
	readTextFile as readWorkspaceTextFile,
} from "../workspaceFs";

function jsonResult(obj: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(obj)),
	]);
}

function tryExec(cmd: string, cwd?: string): string {
	try {
		return execSync(cmd, {
			cwd,
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
}

function getWorkspaceRoot(): string | null {
	return displayUriPath(getPrimaryWorkspaceUri());
}

// ── GetWorkspaceInfoTool ────────────────────────────────────────────
// Replaces: session-start.sh OS detection + project context injection
class GetWorkspaceInfoTool
	implements vscode.LanguageModelTool<Record<string, never>>
{
	async prepareInvocation() {
		return { invocationMessage: "Gathering workspace environment info…" };
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const rootUri = getPrimaryWorkspaceUri();
		const root = displayUriPath(rootUri);
		const localRoot = rootUri?.scheme === "file" ? rootUri.fsPath : null;

		// OS & environment — native Node.js APIs, no shell probing
		const platform = os.platform();
		const arch = os.arch();
		const release = os.release();
		let osDisplay = `${platform} ${release} (${arch})`;

		// Linux distro detection via /etc/os-release
		let distro: string | null = null;
		let distroVersion: string | null = null;
		let packageManager: string | null = null;
		if (platform === "linux") {
			try {
				const osRelease = fs.readFileSync("/etc/os-release", "utf-8");
				const idMatch = osRelease.match(/^ID=["']?([^"'\n]+)/m);
				const verMatch = osRelease.match(/^VERSION_ID=["']?([^"'\n]+)/m);
				distro = idMatch?.[1] ?? null;
				distroVersion = verMatch?.[1] ?? null;
				if (distro) {
					osDisplay = `${distro} ${distroVersion ?? ""} (${arch})`;
				}
			} catch {
				// /etc/os-release not available
			}
			// Package manager detection — use fs.existsSync to avoid spawning
			// a subprocess for each candidate (avoids up to ~35s worst-case timeout)
			const pmCandidates: [string, string][] = [
				["/usr/bin/apt", "apt"],
				["/usr/bin/pacman", "pacman"],
				["/usr/bin/dnf", "dnf"],
				["/usr/bin/rpm-ostree", "rpm-ostree"],
				["/usr/sbin/zypper", "zypper"],
				["/usr/bin/nix", "nix"],
				["/sbin/apk", "apk"],
			];
			for (const [binPath, name] of pmCandidates) {
				if (fs.existsSync(binPath)) {
					packageManager = name;
					break;
				}
			}
		} else if (platform === "darwin") {
			osDisplay = `macOS ${release} (${arch})`;
			packageManager =
				fs.existsSync("/opt/homebrew/bin/brew") ||
				fs.existsSync("/usr/local/bin/brew")
					? "brew"
					: null;
		} else if (platform === "win32") {
			osDisplay = `Windows (${arch})`;
			packageManager = tryExec("where winget") ? "winget" : null;
		}

		// Git context
		let branch: string | null = null;
		let commit: string | null = null;
		if (localRoot) {
			branch = tryExec("git rev-parse --abbrev-ref HEAD", localRoot) || null;
			commit = tryExec("git rev-parse --short HEAD", localRoot) || null;
		}

		// Project manifest detection
		let projectName: string | null = null;
		let projectVersion: string | null = null;
		let detectedLanguage: string | null = null;
		if (rootUri) {
			const packageJsonUri = joinFromUri(rootUri, "package.json");
			const pyprojectTomlUri = joinFromUri(rootUri, "pyproject.toml");
			const cargoTomlUri = joinFromUri(rootUri, "Cargo.toml");
			const goModUri = joinFromUri(rootUri, "go.mod");

			if (await pathExists(packageJsonUri)) {
				const pkg = await readWorkspaceJsonFile<Record<string, string>>(
					packageJsonUri
				);
				projectName = pkg?.name ?? null;
				projectVersion = pkg?.version ?? null;
				detectedLanguage = "javascript/typescript";
			} else if (await pathExists(pyprojectTomlUri)) {
				const content = await readWorkspaceTextFile(pyprojectTomlUri);
				projectName = content?.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				projectVersion =
					content?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				detectedLanguage = "python";
			} else if (await pathExists(cargoTomlUri)) {
				const content = await readWorkspaceTextFile(cargoTomlUri);
				projectName = content?.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				projectVersion =
					content?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				detectedLanguage = "rust";
			} else if (await pathExists(goModUri)) {
				const content = await readWorkspaceTextFile(goModUri);
				projectName = content?.match(/^module\s+(\S+)/m)?.[1] ?? null;
				detectedLanguage = "go";
			} else {
				projectName = path.posix.basename(rootUri.path) || null;
			}
		}

		// Runtime versions
		const nodeVersion = tryExec("node --version") || null;
		const pythonVersion =
			tryExec("python3 --version")?.replace("Python ", "") || null;

		// VS Code context
		const vscodeVersion = vscode.version;
		const appHost = vscode.env.appHost;

		return jsonResult({
			environment: {
				os: osDisplay,
				platform,
				arch,
				distro,
				distroVersion,
				packageManager,
			},
			project: {
				name: projectName,
				version: projectVersion,
				language: detectedLanguage,
				root,
			},
			git: {
				branch,
				commit,
			},
			runtime: {
				node: nodeVersion,
				python: pythonVersion,
			},
			vscode: {
				version: vscodeVersion,
				appHost,
				workspaceName: vscode.workspace.name ?? null,
			},
		});
	}
}

// ── GetWorkspaceStateTool ───────────────────────────────────────────
// Replaces: pulse_state.py reads / heartbeat state file access
class GetWorkspaceStateTool
	implements vscode.LanguageModelTool<Record<string, never>>
{
	async prepareInvocation() {
		return { invocationMessage: "Reading workspace session state…" };
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const rootUri = getPrimaryWorkspaceUri();
		if (!rootUri) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const workspaceDir = joinFromUri(rootUri, ".copilot", "workspace");
		const stateUri = joinFromUri(workspaceDir, "runtime", "state.json");
		const eventsUri = joinFromUri(
			workspaceDir,
			"runtime",
			".heartbeat-events.jsonl"
		);
		const sentinelUri = joinFromUri(
			workspaceDir,
			"runtime",
			".heartbeat-session"
		);
		const heartbeatUri = joinFromUri(
			workspaceDir,
			"operations",
			"HEARTBEAT.md"
		);

		// Read state.json
		const state =
			(await readWorkspaceJsonFile<Record<string, unknown>>(stateUri)) ?? {};

		// Read recent events (last 20 lines of JSONL)
		let recentEvents: unknown[] = [];
		const eventsRaw = await readWorkspaceTextFile(eventsUri);
		if (eventsRaw) {
			const lines = eventsRaw.split("\n").filter((l) => l.trim());
			recentEvents = lines.slice(-20).map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			}).filter(Boolean);
		}

		// Session active check
		const sessionActive = await pathExists(sentinelUri);

		// HEARTBEAT.md first line
		const heartbeatText = await readWorkspaceTextFile(heartbeatUri);
		const heartbeatSummary = heartbeatText
			?.split("\n")
			.find((l) => l.includes("HEARTBEAT"))
			?.trim() ?? null;

		return jsonResult({
			state,
			recentEvents,
			sessionActive,
			heartbeatSummary,
			paths: {
				state: displayUriPath(stateUri),
				events: displayUriPath(eventsUri),
				sentinel: displayUriPath(sentinelUri),
				heartbeat: displayUriPath(heartbeatUri),
			},
		});
	}
}

// ── GetWorkspaceIndexTool ────────────────────────────────────────────
// Reads .copilot/workspace/operations/workspace-index.json
class GetWorkspaceIndexTool
	implements vscode.LanguageModelTool<Record<string, never>>
{
	async prepareInvocation() {
		return { invocationMessage: "Reading workspace index…" };
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const rootUri = getPrimaryWorkspaceUri();
		if (!rootUri) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const indexUri = joinFromUri(
			rootUri,
			".copilot",
			"workspace",
			"operations",
			"workspace-index.json"
		);

		if (!(await pathExists(indexUri))) {
			return jsonResult({
				error: "workspace-index.json not found.",
				expectedPath: displayUriPath(indexUri),
				hint: "Run the workspace indexing hook or create .copilot/workspace/operations/workspace-index.json manually.",
			});
		}

		const index = await readWorkspaceJsonFile<unknown>(indexUri);
		if (index === null) {
			return jsonResult({
				error: "Could not parse workspace-index.json.",
				path: displayUriPath(indexUri),
			});
		}

		return jsonResult(index);
	}
}

export function registerWorkspaceTools(
	context: vscode.ExtensionContext
): void {
	context.subscriptions.push(
		vscode.lm.registerTool(
			"asafelobotomy_get_workspace_info",
			new GetWorkspaceInfoTool()
		),
		vscode.lm.registerTool(
			"asafelobotomy_get_workspace_state",
			new GetWorkspaceStateTool()
		),
		vscode.lm.registerTool(
			"asafelobotomy_get_workspace_index",
			new GetWorkspaceIndexTool()
		)
	);
}
