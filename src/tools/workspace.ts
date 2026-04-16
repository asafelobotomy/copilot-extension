import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

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
	const folders = vscode.workspace.workspaceFolders;
	return folders?.length ? folders[0].uri.fsPath : null;
}

function readJsonFile(filePath: string): unknown | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
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
		const root = getWorkspaceRoot();

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
			// Package manager detection
			for (const [cmd, name] of [
				["apt", "apt"],
				["pacman", "pacman"],
				["dnf", "dnf"],
				["rpm-ostree", "rpm-ostree"],
				["zypper", "zypper"],
				["nix", "nix"],
				["apk", "apk"],
			] as const) {
				if (tryExec(`command -v ${cmd}`)) {
					packageManager = name;
					break;
				}
			}
		} else if (platform === "darwin") {
			osDisplay = `macOS ${release} (${arch})`;
			packageManager = tryExec("command -v brew") ? "brew" : null;
		} else if (platform === "win32") {
			osDisplay = `Windows (${arch})`;
			packageManager = tryExec("where winget") ? "winget" : null;
		}

		// Git context
		let branch: string | null = null;
		let commit: string | null = null;
		if (root) {
			branch = tryExec("git rev-parse --abbrev-ref HEAD", root) || null;
			commit = tryExec("git rev-parse --short HEAD", root) || null;
		}

		// Project manifest detection
		let projectName: string | null = null;
		let projectVersion: string | null = null;
		let detectedLanguage: string | null = null;
		if (root) {
			const packageJson = path.join(root, "package.json");
			const pyprojectToml = path.join(root, "pyproject.toml");
			const cargoToml = path.join(root, "Cargo.toml");
			const goMod = path.join(root, "go.mod");

			if (fs.existsSync(packageJson)) {
				const pkg = readJsonFile(packageJson) as Record<string, string> | null;
				projectName = pkg?.name ?? null;
				projectVersion = pkg?.version ?? null;
				detectedLanguage = "javascript/typescript";
			} else if (fs.existsSync(pyprojectToml)) {
				const content = fs.readFileSync(pyprojectToml, "utf-8");
				projectName = content.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				projectVersion =
					content.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				detectedLanguage = "python";
			} else if (fs.existsSync(cargoToml)) {
				const content = fs.readFileSync(cargoToml, "utf-8");
				projectName = content.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				projectVersion =
					content.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
				detectedLanguage = "rust";
			} else if (fs.existsSync(goMod)) {
				const content = fs.readFileSync(goMod, "utf-8");
				projectName = content.match(/^module\s+(\S+)/m)?.[1] ?? null;
				detectedLanguage = "go";
			} else {
				projectName = path.basename(root);
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
		const root = getWorkspaceRoot();
		if (!root) {
			return jsonResult({ error: "No workspace folder open." });
		}

		const workspaceDir = path.join(root, ".copilot", "workspace");
		const statePath = path.join(workspaceDir, "runtime", "state.json");
		const eventsPath = path.join(
			workspaceDir,
			"runtime",
			".heartbeat-events.jsonl"
		);
		const sentinelPath = path.join(
			workspaceDir,
			"runtime",
			".heartbeat-session"
		);
		const heartbeatPath = path.join(
			workspaceDir,
			"operations",
			"HEARTBEAT.md"
		);

		// Read state.json
		const state = (readJsonFile(statePath) as Record<string, unknown>) ?? {};

		// Read recent events (last 20 lines of JSONL)
		let recentEvents: unknown[] = [];
		try {
			const eventsRaw = fs.readFileSync(eventsPath, "utf-8");
			const lines = eventsRaw.split("\n").filter((l) => l.trim());
			recentEvents = lines.slice(-20).map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			}).filter(Boolean);
		} catch {
			// Events file doesn't exist yet
		}

		// Session active check
		let sessionActive = false;
		try {
			sessionActive = fs.existsSync(sentinelPath);
		} catch {
			// ignore
		}

		// HEARTBEAT.md first line
		let heartbeatSummary: string | null = null;
		try {
			const hb = fs.readFileSync(heartbeatPath, "utf-8");
			const firstLine = hb.split("\n").find((l) => l.includes("HEARTBEAT"));
			heartbeatSummary = firstLine?.trim() ?? null;
		} catch {
			// HEARTBEAT.md doesn't exist
		}

		return jsonResult({
			state,
			recentEvents,
			sessionActive,
			heartbeatSummary,
			paths: {
				state: statePath,
				events: eventsPath,
				sentinel: sentinelPath,
				heartbeat: heartbeatPath,
			},
		});
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
		)
	);
}
