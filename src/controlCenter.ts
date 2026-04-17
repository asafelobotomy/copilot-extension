import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { McpProvider } from "./mcp/provider";
import { ensureRepoProfile } from "./tools/profile";

export const CONTROL_CENTER_CONTAINER_ID = "asafelobotomy-control-center";
export const CONTROL_CENTER_VIEW_ID = "asafelobotomy.controlCenter";

interface HealthCheckItem {
  severity: "ok" | "warn" | "error";
  title: string;
  message: string;
}

interface RecommendationSummary {
  exists: boolean;
  path: string | null;
  missing: string[];
  extra: string[];
  matched: string[];
}

interface McpSummary {
  providerActive: boolean;
  configExists: boolean;
  path: string | null;
  serverCount: number;
  enabled: number;
  disabled: number;
}

interface WorkspaceIndexSummary {
  exists: boolean;
  path: string | null;
  source: "workspace-runtime" | "template-baseline" | null;
  counts?: Record<string, number>;
}

interface HeartbeatSummary {
  sessionActive: boolean;
  heartbeatSummary: string | null;
  stateExists: boolean;
  eventsExists: boolean;
  root: string | null;
}

type RepoMode = "template-repo" | "consumer-repo" | "generic-workspace";

interface TemplateLifecycleSummary {
  repoMode: RepoMode;
  repoLabel: string;
  metadataState: "source" | "installed" | "partial" | "missing";
  currentVersion: string | null;
  sourceVersion: string | null;
  installedVersion: string | null;
  appliedDate: string | null;
  updatedDate: string | null;
  ownershipMode: string | null;
  pluginManifestExists: boolean;
  pluginManifestPath: string | null;
  versionFileExists: boolean;
  versionFilePath: string | null;
  instructionsFileExists: boolean;
  instructionsFilePath: string | null;
  sectionFingerprintCount: number;
  fileManifestCount: number;
  setupAnswerCount: number;
  nextAction: string;
  notes: string[];
}

interface ControlCenterSnapshot {
  generatedAt: string;
  extension: {
    version: string;
    vscodeVersion: string;
    appHost: string;
    proposedApiEnabled: boolean;
  };
  workspace: {
    name: string | null;
    root: string | null;
    profileName: string | null;
    knownProfiles: string[];
  };
  recommendations: RecommendationSummary;
  mcp: McpSummary;
  template: TemplateLifecycleSummary;
  workspaceIndex: WorkspaceIndexSummary;
  heartbeat: HeartbeatSummary;
  health: HealthCheckItem[];
}

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function firstContentLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("<!--") && line.endsWith("-->")) {
      continue;
    }

    return line;
  }

  return null;
}

function readCommentBlock(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) {
    return "";
  }

  const end = text.indexOf("-->", start);
  if (end === -1) {
    return "";
  }

  const block = text.slice(start, end);
  return block
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function parseMappingBlock(payload: string): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const rawLine of payload.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    mapping[key] = value;
  }

  return mapping;
}

function formatRepoMode(repoMode: RepoMode): string {
  switch (repoMode) {
    case "template-repo":
      return "Template Repo";
    case "consumer-repo":
      return "Consumer Repo";
    default:
      return "Generic Workspace";
  }
}

function formatTemplateMetadataState(
  template: TemplateLifecycleSummary
): string {
  switch (template.metadataState) {
    case "source":
      return "Plugin Source";
    case "installed":
      return "Installed";
    case "partial":
      return "Partial";
    default:
      return "Missing";
  }
}

function formatWorkspaceIndexSource(
  source: WorkspaceIndexSummary["source"]
): string {
  switch (source) {
    case "workspace-runtime":
      return "Workspace runtime";
    case "template-baseline":
      return "Template baseline";
    default:
      return "Unavailable";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

function renderList(items: string[], emptyMessage: string): string {
  if (!items.length) {
    return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  }

  const listItems = items
    .slice(0, 6)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const moreCount = items.length > 6 ? items.length - 6 : 0;
  const more =
    moreCount > 0
      ? `<li class="muted">+${moreCount} more</li>`
      : "";

  return `<ul class="compact-list">${listItems}${more}</ul>`;
}

function renderCounts(counts: Record<string, number> | undefined): string {
  if (!counts || !Object.keys(counts).length) {
    return '<p class="muted">No indexed counts available.</p>';
  }

  return Object.entries(counts)
    .map(
      ([key, value]) => `
        <div class="metric-row">
          <span>${escapeHtml(key)}</span>
          <strong>${value}</strong>
        </div>`
    )
    .join("");
}

function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 1500
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createDefaultRecommendationSummary(
  workspaceRoot: string | null
): RecommendationSummary {
  return {
    exists: false,
    path: workspaceRoot
      ? path.join(workspaceRoot, ".vscode", "extensions.json")
      : null,
    missing: [],
    extra: [],
    matched: [],
  };
}

function createDefaultMcpSummary(
  workspaceRoot: string | null,
  providerActive: boolean
): McpSummary {
  return {
    providerActive,
    configExists: false,
    path: workspaceRoot ? path.join(workspaceRoot, ".vscode", "mcp.json") : null,
    serverCount: 0,
    enabled: 0,
    disabled: 0,
  };
}

function createDefaultWorkspaceIndexSummary(
  workspaceRoot: string | null
): WorkspaceIndexSummary {
  return {
    exists: false,
    path: workspaceRoot
      ? path.join(
          workspaceRoot,
          ".copilot",
          "workspace",
          "operations",
          "workspace-index.json"
        )
      : null,
    source: null,
  };
}

function createDefaultHeartbeatSummary(
  workspaceRoot: string | null
): HeartbeatSummary {
  return {
    sessionActive: false,
    heartbeatSummary: null,
    stateExists: false,
    eventsExists: false,
    root: workspaceRoot
      ? path.join(workspaceRoot, ".copilot", "workspace")
      : null,
  };
}

function createDefaultTemplateLifecycleSummary(
  workspaceRoot: string | null
): TemplateLifecycleSummary {
  return {
    repoMode: "generic-workspace",
    repoLabel: formatRepoMode("generic-workspace"),
    metadataState: "missing",
    currentVersion: null,
    sourceVersion: null,
    installedVersion: null,
    appliedDate: null,
    updatedDate: null,
    ownershipMode: null,
    pluginManifestExists: false,
    pluginManifestPath: workspaceRoot ? path.join(workspaceRoot, "plugin.json") : null,
    versionFileExists: false,
    versionFilePath: workspaceRoot
      ? path.join(workspaceRoot, ".github", "copilot-version.md")
      : null,
    instructionsFileExists: false,
    instructionsFilePath: workspaceRoot
      ? path.join(workspaceRoot, ".github", "copilot-instructions.md")
      : null,
    sectionFingerprintCount: 0,
    fileManifestCount: 0,
    setupAnswerCount: 0,
    nextAction: "Run setup to install template-managed instructions into this workspace.",
    notes: ["Template lifecycle details could not be loaded."],
  };
}

class ControlCenterService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly mcpProvider: McpProvider
  ) {}

  async getSnapshot(): Promise<ControlCenterSnapshot> {
    const workspaceRoot = getWorkspaceRoot();
    const config = vscode.workspace.getConfiguration("asafelobotomy");
    const profileName = config.get<string>("profileName", "") || null;
    const knownProfiles = config.get<string[]>("knownProfiles", []);
    const collect = async <T>(
      label: string,
      loader: () => Promise<T>,
      fallback: T
    ): Promise<T> => {
      try {
        return await withTimeout(loader(), label);
      } catch (error) {
        this.reportError(`Failed to collect ${label}`, error);
        return fallback;
      }
    };

    const [template, recommendations, mcp, workspaceIndex, heartbeat] =
      await Promise.all([
        collect(
          "template lifecycle",
          () => this.getTemplateLifecycleSummary(workspaceRoot),
          createDefaultTemplateLifecycleSummary(workspaceRoot)
        ),
        collect(
          "extension recommendations",
          () => this.getRecommendationSummary(workspaceRoot),
          createDefaultRecommendationSummary(workspaceRoot)
        ),
        collect(
          "MCP summary",
          () => this.getMcpSummary(workspaceRoot),
          createDefaultMcpSummary(workspaceRoot, this.mcpProvider.isActive())
        ),
        collect(
          "workspace index",
          () => this.getWorkspaceIndexSummary(workspaceRoot),
          createDefaultWorkspaceIndexSummary(workspaceRoot)
        ),
        collect(
          "heartbeat summary",
          () => this.getHeartbeatSummary(workspaceRoot),
          createDefaultHeartbeatSummary(workspaceRoot)
        ),
      ]);

    const snapshotWithoutHealth = {
      generatedAt: new Date().toISOString(),
      extension: {
        version: this.context.extension.packageJSON.version ?? "unknown",
        vscodeVersion: vscode.version,
        appHost: vscode.env.appHost,
        proposedApiEnabled: true,
      },
      workspace: {
        name: vscode.workspace.name ?? null,
        root: workspaceRoot,
        profileName,
        knownProfiles,
      },
      recommendations,
      mcp,
      template,
      workspaceIndex,
      heartbeat,
    };

    return {
      ...snapshotWithoutHealth,
      health: this.buildHealth(snapshotWithoutHealth),
    };
  }

  log(message: string): void {
    this.output.appendLine(`[Control Center] ${message}`);
  }

  reportError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[Control Center] ${context}: ${message}`);
  }

  async startTemplateSetup(): Promise<void> {
    await this.openTemplateLifecycleChat("Set up this project");
  }

  async updateTemplateInstructions(): Promise<void> {
    await this.openTemplateLifecycleChat("Update your instructions");
  }

  async restoreTemplateInstructions(): Promise<void> {
    await this.openTemplateLifecycleChat("Restore instructions from backup");
  }

  async factoryRestoreTemplateInstructions(): Promise<void> {
    await this.openTemplateLifecycleChat("Factory restore instructions");
  }

  async promptAndEnsureProfile(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const currentProfile =
      vscode.workspace.getConfiguration("asafelobotomy").get<string>(
        "profileName",
        ""
      ) || "";
    const defaultProfile =
      currentProfile ||
      vscode.workspace.name ||
      (workspaceRoot ? path.basename(workspaceRoot) : "workspace");

    const profileName = await vscode.window.showInputBox({
      prompt: "Open the current workspace in a named profile",
      placeHolder: "copilot-extension",
      value: defaultProfile,
      validateInput(value) {
        return /^[\w\s\-.]+$/.test(value)
          ? null
          : "Only letters, numbers, spaces, hyphens, underscores, and dots are allowed.";
      },
    });

    if (!profileName) {
      return;
    }

    const result = await ensureRepoProfile(profileName);
    if (result.error) {
      this.output.appendLine(`Profile switch failed: ${result.error}`);
      void vscode.window.showErrorMessage(result.error);
      return;
    }

    this.output.appendLine(
      `Opening ${result.target ?? "workspace"} in profile ${result.profileName} via ${result.cli}.`
    );
    void vscode.window.showInformationMessage(
      `Opening ${result.profileName} via ${result.cli}.`
    );
  }

  async runHealthCheck(): Promise<void> {
    const snapshot = await this.getSnapshot();
    this.output.appendLine("Control Center health check");
    for (const item of snapshot.health) {
      this.output.appendLine(
        `[${item.severity.toUpperCase()}] ${item.title}: ${item.message}`
      );
    }

    const errorCount = snapshot.health.filter(
      (item) => item.severity === "error"
    ).length;
    const warnCount = snapshot.health.filter(
      (item) => item.severity === "warn"
    ).length;

    if (errorCount > 0) {
      void vscode.window.showErrorMessage(
        `Health check found ${errorCount} error${errorCount === 1 ? "" : "s"} and ${warnCount} warning${warnCount === 1 ? "" : "s"}.`
      );
      return;
    }

    if (warnCount > 0) {
      void vscode.window.showWarningMessage(
        `Health check found ${warnCount} warning${warnCount === 1 ? "" : "s"}.`
      );
      return;
    }

    void vscode.window.showInformationMessage("Health check passed.");
  }

  async showExtensionRecommendationDiff(): Promise<void> {
    const recommendations = (await this.getSnapshot()).recommendations;
    if (!recommendations.exists) {
      void vscode.window.showWarningMessage(
        "No .vscode/extensions.json recommendations file was found."
      );
      return;
    }

    this.logRecommendationSummary(recommendations);

    const message = `Recommended extensions: ${recommendations.matched.length} matched, ${recommendations.missing.length} missing, ${recommendations.extra.length} extra.`;
    if (!recommendations.missing.length && !recommendations.extra.length) {
      void vscode.window.showInformationMessage(message);
      return;
    }

    let requestedChanges = false;

    if (recommendations.missing.length > 0) {
      const installChoice = await vscode.window.showInformationMessage(
        `${message} Install the missing recommendations now?`,
        { modal: true },
        "Install Missing",
        "Not Now"
      );

      if (installChoice === "Install Missing") {
        const requestedCount = await this.requestExtensionInstall(
          recommendations.missing
        );
        requestedChanges = requestedChanges || requestedCount > 0;
      }
    }

    if (recommendations.extra.length > 0) {
      const reviewChoice = await vscode.window.showInformationMessage(
        `${recommendations.extra.length} installed extension${recommendations.extra.length === 1 ? " is" : "s are"} not listed in workspace recommendations. Review them now?`,
        "Review Extras",
        "Not Now"
      );

      if (reviewChoice === "Review Extras") {
        const selection = await vscode.window.showQuickPick(
          recommendations.extra.map((extensionId) => ({
            label: extensionId,
            description: "Installed in this profile but not recommended by the workspace",
          })),
          {
            canPickMany: true,
            title: "Uninstall extra extensions",
            placeHolder: "Select installed extensions to remove from this profile",
          }
        );

        if (selection?.length) {
          const confirmRemoval = await vscode.window.showWarningMessage(
            `Uninstall ${selection.length} selected extension${selection.length === 1 ? "" : "s"} from this profile?`,
            { modal: true },
            "Uninstall Selected",
            "Cancel"
          );

          if (confirmRemoval === "Uninstall Selected") {
            const requestedCount = await this.requestExtensionUninstall(
              selection.map((item) => item.label)
            );
            requestedChanges = requestedChanges || requestedCount > 0;
          }
        }
      }
    }

    if (requestedChanges) {
      void vscode.window.showInformationMessage(
        "Extension change requests were submitted. Refresh the Control Center after VS Code finishes the installs or removals."
      );
      return;
    }

    if (recommendations.missing.length > 0) {
      void vscode.window.showWarningMessage(message);
      return;
    }

    void vscode.window.showInformationMessage(message);
  }

  openOutput(): void {
    this.output.show(true);
  }

  restartMcp(): void {
    this.mcpProvider.triggerRestart();
    this.output.appendLine("Restart requested from Control Center.");
    void vscode.window.showInformationMessage("MCP server restart triggered.");
  }

  private async openTemplateLifecycleChat(query: string): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        mode: "agent",
        query,
        isPartialQuery: true,
      });
      this.output.appendLine(
        `[Control Center] Opened Copilot Chat with lifecycle trigger: ${query}`
      );
    } catch (error) {
      this.reportError(`Failed to open Copilot Chat for '${query}'`, error);
      await vscode.env.clipboard.writeText(query);
      void vscode.window.showWarningMessage(
        `Could not open Copilot Chat automatically. Copied trigger phrase to the clipboard: ${query}`
      );
    }
  }

  private logRecommendationSummary(recommendations: RecommendationSummary): void {
    this.output.appendLine(
      `Recommended extensions: ${recommendations.matched.length} matched, ${recommendations.missing.length} missing, ${recommendations.extra.length} extra.`
    );
    if (recommendations.missing.length) {
      this.output.appendLine(
        `Missing recommendations: ${recommendations.missing.join(", ")}`
      );
    }
    if (recommendations.extra.length) {
      this.output.appendLine(
        `Extra installed extensions: ${recommendations.extra.join(", ")}`
      );
    }
  }

  private async requestExtensionInstall(extensionIds: string[]): Promise<number> {
    let requestedCount = 0;

    for (const extensionId of extensionIds) {
      try {
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          extensionId
        );
        requestedCount += 1;
        this.output.appendLine(
          `[Control Center] Requested install for ${extensionId}.`
        );
      } catch (error) {
        this.reportError(`Failed to request install for ${extensionId}`, error);
      }
    }

    return requestedCount;
  }

  private async requestExtensionUninstall(
    extensionIds: string[]
  ): Promise<number> {
    let requestedCount = 0;

    for (const extensionId of extensionIds) {
      try {
        await vscode.commands.executeCommand(
          "workbench.extensions.uninstallExtension",
          extensionId
        );
        requestedCount += 1;
        this.output.appendLine(
          `[Control Center] Requested uninstall for ${extensionId}.`
        );
      } catch (error) {
        this.reportError(`Failed to request uninstall for ${extensionId}`, error);
      }
    }

    return requestedCount;
  }

  private async getMcpSummary(workspaceRoot: string | null): Promise<McpSummary> {
    const mcpPath = workspaceRoot
      ? path.join(workspaceRoot, ".vscode", "mcp.json")
      : null;
    const mcpData = mcpPath
      ? await readJsonFile<{ servers?: Record<string, { disabled?: boolean }> }>(
          mcpPath
        )
      : null;
    const servers = Object.values(mcpData?.servers ?? {});
    const disabled = servers.filter((server) => server.disabled === true).length;

    return {
      providerActive: this.mcpProvider.isActive(),
      configExists: Boolean(mcpData),
      path: mcpPath,
      serverCount: servers.length,
      enabled: servers.length - disabled,
      disabled,
    };
  }

  private async getRecommendationSummary(
    workspaceRoot: string | null
  ): Promise<RecommendationSummary> {
    const recommendationsPath = workspaceRoot
      ? path.join(workspaceRoot, ".vscode", "extensions.json")
      : null;
    const recommendationsFile = recommendationsPath
      ? await readJsonFile<{ recommendations?: string[] }>(recommendationsPath)
      : null;

    if (!recommendationsFile) {
      return {
        exists: false,
        path: recommendationsPath,
        missing: [],
        extra: [],
        matched: [],
      };
    }

    const recommendedIds = (recommendationsFile.recommendations ?? []).map(
      (value) => value.toLowerCase()
    );
    const installedIds = new Set(
      vscode.extensions.all
        .filter((extension) => !extension.id.startsWith("vscode."))
        .map((extension) => extension.id.toLowerCase())
    );

    return {
      exists: true,
      path: recommendationsPath,
      missing: recommendedIds.filter((value) => !installedIds.has(value)),
      extra: [...installedIds].filter(
        (value) => !recommendedIds.includes(value)
      ),
      matched: recommendedIds.filter((value) => installedIds.has(value)),
    };
  }

  private async getWorkspaceIndexSummary(
    workspaceRoot: string | null
  ): Promise<WorkspaceIndexSummary> {
    if (!workspaceRoot) {
      return {
        exists: false,
        path: null,
        source: null,
      };
    }

    const candidates = [
      {
        path: path.join(
          workspaceRoot,
          ".copilot",
          "workspace",
          "operations",
          "workspace-index.json"
        ),
        source: "workspace-runtime" as const,
      },
      {
        path: path.join(
          workspaceRoot,
          "template",
          "workspace",
          "operations",
          "workspace-index.json"
        ),
        source: "template-baseline" as const,
      },
    ];

    let workspaceIndex: Record<string, unknown> | null = null;
    let resolvedPath: string | null = candidates[0]?.path ?? null;
    let source: WorkspaceIndexSummary["source"] = null;

    for (const candidate of candidates) {
      const candidateData = await readJsonFile<Record<string, unknown>>(
        candidate.path
      );
      if (!candidateData) {
        continue;
      }

      workspaceIndex = candidateData;
      resolvedPath = candidate.path;
      source = candidate.source;
      break;
    }

    const rawCounts = workspaceIndex?.counts;
    const counts = rawCounts && typeof rawCounts === "object"
      ? Object.fromEntries(
          Object.entries(rawCounts)
            .filter(([, value]) => typeof value === "number")
            .map(([key, value]) => [key, value as number])
        )
      : undefined;

    return {
      exists: Boolean(workspaceIndex),
      path: resolvedPath,
      source,
      counts,
    };
  }

  private async getTemplateLifecycleSummary(
    workspaceRoot: string | null
  ): Promise<TemplateLifecycleSummary> {
    const pluginManifestPath = workspaceRoot
      ? path.join(workspaceRoot, "plugin.json")
      : null;
    const versionFilePath = workspaceRoot
      ? path.join(workspaceRoot, ".github", "copilot-version.md")
      : null;
    const instructionsFilePath = workspaceRoot
      ? path.join(workspaceRoot, ".github", "copilot-instructions.md")
      : null;

    const pluginManifest = pluginManifestPath
      ? await readJsonFile<{
          version?: string;
          agents?: string;
          skills?: string;
          hooks?: string;
          mcpServers?: string;
        }>(pluginManifestPath)
      : null;
    const versionFileText = versionFilePath
      ? await readTextFile(versionFilePath)
      : null;
    const instructionsFileExists = Boolean(
      instructionsFilePath && fs.existsSync(instructionsFilePath)
    );
    const pluginManifestExists = Boolean(pluginManifest);
    const versionFileExists = versionFileText !== null;
    const sourceVersion =
      typeof pluginManifest?.version === "string" ? pluginManifest.version : null;
    const installedVersionCandidate = versionFileText
      ? firstContentLine(versionFileText)
      : null;
    const installedVersion =
      installedVersionCandidate && /^\d+\.\d+\.\d+$/u.test(installedVersionCandidate)
        ? installedVersionCandidate
        : null;
    const ownershipBlock = parseMappingBlock(
      readCommentBlock(versionFileText ?? "", "<!-- ownership-mode")
    );
    const sectionFingerprints = parseMappingBlock(
      readCommentBlock(versionFileText ?? "", "<!-- section-fingerprints")
    );
    const fileManifest = parseMappingBlock(
      readCommentBlock(versionFileText ?? "", "<!-- file-manifest")
    );
    const setupAnswers = parseMappingBlock(
      readCommentBlock(versionFileText ?? "", "<!-- setup-answers")
    );
    const appliedDate =
      versionFileText?.match(/^Applied:\s*(.+?)\s*$/mu)?.[1]?.trim() ?? null;
    const updatedDate =
      versionFileText?.match(/^Updated:\s*(.+?)\s*$/mu)?.[1]?.trim() ?? null;
    const ownershipMode =
      ownershipBlock.OWNERSHIP_MODE ??
      versionFileText?.match(/^Ownership:\s*(.+?)\s*$/mu)?.[1]?.trim() ??
      null;

    const repoMode: RepoMode = pluginManifest?.agents &&
      pluginManifest?.skills &&
      pluginManifest?.hooks &&
      pluginManifest?.mcpServers
      ? "template-repo"
      : versionFileExists || instructionsFileExists
        ? "consumer-repo"
        : "generic-workspace";

    const metadataState = repoMode === "template-repo"
      ? "source"
      : repoMode === "consumer-repo"
        ? versionFileExists && installedVersion && Object.keys(fileManifest).length > 0 && Object.keys(setupAnswers).length > 0
          ? "installed"
          : "partial"
        : "missing";

    const notes: string[] = [];
    if (repoMode === "template-repo") {
      notes.push(
        sourceVersion
          ? `Plugin manifest version ${sourceVersion} is available in plugin.json.`
          : "plugin.json is present but does not expose a version."
      );
      notes.push(
        "Use a consumer workspace to exercise setup, update, backup restore, and factory restore flows."
      );
    } else if (repoMode === "consumer-repo") {
      notes.push(
        installedVersion
          ? `Installed template version ${installedVersion} was detected.`
          : "copilot-version.md is present but the installed semantic version could not be parsed."
      );
      if (ownershipMode) {
        notes.push(`Ownership mode is ${ownershipMode}.`);
      }
      if (Object.keys(fileManifest).length > 0) {
        notes.push(
          `${Object.keys(fileManifest).length} managed surfaces are tracked in the file manifest.`
        );
      }
      if (Object.keys(setupAnswers).length > 0) {
        notes.push(
          `${Object.keys(setupAnswers).length} setup answers were captured for recovery and update flows.`
        );
      }
    } else {
      notes.push("No installed template lifecycle metadata was detected.");
      notes.push(
        "Use the setup workflow if this workspace should be managed by copilot-instructions-template."
      );
    }

    return {
      repoMode,
      repoLabel: formatRepoMode(repoMode),
      metadataState,
      currentVersion:
        repoMode === "consumer-repo" ? installedVersion : sourceVersion,
      sourceVersion,
      installedVersion,
      appliedDate,
      updatedDate,
      ownershipMode,
      pluginManifestExists,
      pluginManifestPath,
      versionFileExists,
      versionFilePath,
      instructionsFileExists,
      instructionsFilePath,
      sectionFingerprintCount: Object.keys(sectionFingerprints).length,
      fileManifestCount: Object.keys(fileManifest).length,
      setupAnswerCount: Object.keys(setupAnswers).length,
      nextAction: repoMode === "template-repo"
        ? "Inspect plugin assets here, then test lifecycle flows from a consumer workspace."
        : repoMode === "consumer-repo"
          ? "Use update or restore when installed instructions drift from the template."
          : "Run setup to install template-managed instructions into this workspace.",
      notes,
    };
  }

  private async getHeartbeatSummary(
    workspaceRoot: string | null
  ): Promise<HeartbeatSummary> {
    if (!workspaceRoot) {
      return {
        sessionActive: false,
        heartbeatSummary: null,
        stateExists: false,
        eventsExists: false,
        root: null,
      };
    }

    const heartbeatRoot = path.join(workspaceRoot, ".copilot", "workspace");
    const runtimeRoot = path.join(heartbeatRoot, "runtime");
    const operationsRoot = path.join(heartbeatRoot, "operations");
    const statePath = path.join(runtimeRoot, "state.json");
    const eventsPath = path.join(runtimeRoot, ".heartbeat-events.jsonl");
    const sentinelPath = path.join(runtimeRoot, ".heartbeat-session");
    const heartbeatPath = path.join(operationsRoot, "HEARTBEAT.md");

    let heartbeatSummary: string | null = null;
    try {
      const heartbeatMarkdown = await fs.promises.readFile(heartbeatPath, "utf-8");
      heartbeatSummary =
        heartbeatMarkdown
          .split("\n")
          .find((line) => line.includes("HEARTBEAT"))
          ?.trim() ?? null;
    } catch {
      heartbeatSummary = null;
    }

    return {
      sessionActive: fs.existsSync(sentinelPath),
      heartbeatSummary,
      stateExists: fs.existsSync(statePath),
      eventsExists: fs.existsSync(eventsPath),
      root: heartbeatRoot,
    };
  }

  private buildHealth(
    snapshot: Omit<ControlCenterSnapshot, "health">
  ): HealthCheckItem[] {
    const health: HealthCheckItem[] = [];

    if (!snapshot.workspace.root) {
      health.push({
        severity: "error",
        title: "Workspace",
        message: "No workspace folder is open.",
      });
    }

    if (
      snapshot.template.repoMode !== "generic-workspace" &&
      !snapshot.workspace.profileName
    ) {
      health.push({
        severity: "warn",
        title: "Profile",
        message: "This workspace is not yet bound to a named profile.",
      });
    }

    if (snapshot.workspace.root && snapshot.template.repoMode === "generic-workspace") {
      health.push({
        severity: "warn",
        title: "Template Lifecycle",
        message:
          "No installed template metadata was detected. Run setup if this workspace should be managed by copilot-instructions-template.",
      });
    }

    if (
      snapshot.template.repoMode === "consumer-repo" &&
      !snapshot.template.versionFileExists
    ) {
      health.push({
        severity: "error",
        title: "Template Metadata",
        message:
          "Consumer template surfaces were detected but .github/copilot-version.md is missing.",
      });
    }

    if (
      snapshot.template.repoMode === "consumer-repo" &&
      snapshot.template.versionFileExists &&
      !snapshot.template.installedVersion
    ) {
      health.push({
        severity: "warn",
        title: "Installed Version",
        message:
          "copilot-version.md is present but the installed semantic version could not be parsed.",
      });
    }

    if (
      snapshot.template.repoMode === "consumer-repo" &&
      snapshot.template.versionFileExists &&
      snapshot.template.fileManifestCount === 0
    ) {
      health.push({
        severity: "warn",
        title: "Lifecycle Drift",
        message:
          "copilot-version.md is missing file-manifest entries, so managed surface drift cannot be verified.",
      });
    }

    if (
      snapshot.template.repoMode === "consumer-repo" &&
      snapshot.template.versionFileExists &&
      snapshot.template.setupAnswerCount === 0
    ) {
      health.push({
        severity: "warn",
        title: "Setup Recovery",
        message:
          "copilot-version.md is missing setup answers, which weakens update and restore flows.",
      });
    }

    if (!snapshot.mcp.providerActive) {
      health.push({
        severity: "warn",
        title: "MCP Provider",
        message: "The MCP server definition provider is not active in this window.",
      });
    }

    if (snapshot.workspace.root && !snapshot.mcp.configExists) {
      health.push({
        severity: "warn",
        title: "MCP Config",
        message: "No .vscode/mcp.json file was found for this workspace.",
      });
    }

    if (snapshot.workspace.root && !snapshot.workspaceIndex.exists) {
      health.push({
        severity: "warn",
        title: "Workspace Index",
        message: "workspace-index.json is missing.",
      });
    }

    if (snapshot.workspace.root && !snapshot.heartbeat.stateExists) {
      health.push({
        severity: "warn",
        title: "Heartbeat",
        message: "No workspace runtime state file was found.",
      });
    }

    if (
      snapshot.recommendations.exists &&
      snapshot.recommendations.missing.length > 0
    ) {
      health.push({
        severity: "warn",
        title: "Recommended Extensions",
        message: `${snapshot.recommendations.missing.length} recommended extension${snapshot.recommendations.missing.length === 1 ? " is" : "s are"} missing.`,
      });
    }

    if (!health.length) {
      health.push({
        severity: "ok",
        title: "Ready",
        message: "Core workspace, profile, and MCP signals look healthy.",
      });
    }

    return health;
  }
}

class ControlCenterViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly service: ControlCenterService) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView;
    this.service.log("Webview resolved.");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = renderControlCenterLoadingHtml();

    webviewView.webview.onDidReceiveMessage(
      async (message: { command?: string }) => {
        switch (message.command) {
          case "refresh":
            break;
          case "healthCheck":
            await this.service.runHealthCheck();
            break;
          case "restartMcp":
            this.service.restartMcp();
            break;
          case "ensureRepoProfile":
            await this.service.promptAndEnsureProfile();
            break;
          case "setupProject":
            await this.service.startTemplateSetup();
            break;
          case "updateInstructions":
            await this.service.updateTemplateInstructions();
            break;
          case "restoreInstructions":
            await this.service.restoreTemplateInstructions();
            break;
          case "factoryRestore":
            await this.service.factoryRestoreTemplateInstructions();
            break;
          case "checkExtensions":
            await this.service.showExtensionRecommendationDiff();
            break;
          case "openOutput":
            this.service.openOutput();
            break;
          default:
            return;
        }

        await this.refresh();
      }
    );

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      const snapshot = await this.service.getSnapshot();
      this.view.description = snapshot.workspace.name ?? "No workspace";
      this.view.webview.html = renderControlCenterHtml(
        this.view.webview,
        snapshot
      );
      this.service.log("View refreshed.");
    } catch (error) {
      this.service.reportError("Failed to refresh view", error);
      this.view.description = "Error";
      this.view.webview.html = renderControlCenterErrorHtml(error);
    }
  }
}

function renderControlCenterErrorHtml(error: unknown): string {
  const nonce = createNonce();
  const message = error instanceof Error ? error.message : String(error);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Control Center Error</title>
    <style nonce="${nonce}">
      body {
        margin: 0;
        padding: 14px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: 13px;
      }

      .card {
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 42%, transparent);
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
        padding: 12px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 14px;
      }

      p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <article class="card">
      <h1>Control Center failed to render</h1>
      <p>${escapeHtml(message)}</p>
    </article>
  </body>
</html>`;
}

function renderControlCenterLoadingHtml(): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Control Center</title>
    <style nonce="${nonce}">
      body {
        margin: 0;
        padding: 14px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: 13px;
      }

      .card {
        border-radius: 12px;
        border: 1px solid var(--vscode-panel-border);
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
        padding: 12px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 14px;
      }

      p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <article class="card">
      <h1>Loading Control Center</h1>
      <p>Collecting workspace, lifecycle, and MCP status.</p>
    </article>
  </body>
</html>`;
}

function renderControlCenterHtml(
  webview: vscode.Webview,
  snapshot: ControlCenterSnapshot
): string {
  const nonce = createNonce();
  const errorCount = snapshot.health.filter(
    (item) => item.severity === "error"
  ).length;
  const warnCount = snapshot.health.filter(
    (item) => item.severity === "warn"
  ).length;
  const statusTone = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";
  const templateState = formatTemplateMetadataState(snapshot.template);
  const healthCards = snapshot.health
    .map(
      (item) => `
        <article class="health-card ${item.severity}">
          <div class="health-title">${escapeHtml(item.title)}</div>
          <p>${escapeHtml(item.message)}</p>
        </article>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Control Center</title>
    <style nonce="${nonce}">
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 14px;
        color: var(--vscode-foreground);
        background:
          radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent), transparent 32%),
          linear-gradient(180deg, color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent), var(--vscode-editor-background));
        font-family: var(--vscode-font-family);
        font-size: 13px;
      }

      .shell {
        display: grid;
        gap: 12px;
      }

      .hero {
        border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 45%, var(--vscode-panel-border));
        border-radius: 16px;
        padding: 14px;
        background: linear-gradient(
          145deg,
          color-mix(in srgb, var(--vscode-button-background) 14%, var(--vscode-editorWidget-background)),
          color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent)
        );
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
      }

      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
      }

      h1 {
        margin: 0;
        font-size: 18px;
        line-height: 1.2;
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 3px 9px;
        font-size: 11px;
        border: 1px solid transparent;
      }

      .pill.ok {
        color: var(--vscode-testing-iconPassed);
        background: color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent);
        border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 38%, transparent);
      }

      .pill.warn {
        color: var(--vscode-testing-iconQueued);
        background: color-mix(in srgb, var(--vscode-testing-iconQueued) 16%, transparent);
        border-color: color-mix(in srgb, var(--vscode-testing-iconQueued) 40%, transparent);
      }

      .pill.error {
        color: var(--vscode-errorForeground);
        background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
        border-color: color-mix(in srgb, var(--vscode-errorForeground) 36%, transparent);
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .stat-card,
      .panel,
      .health-card {
        border-radius: 14px;
        border: 1px solid var(--vscode-panel-border);
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
      }

      .stat-card {
        padding: 12px;
      }

      .stat-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-descriptionForeground);
      }

      .stat-value {
        margin-top: 6px;
        font-size: 18px;
        font-weight: 700;
      }

      .stat-note {
        margin-top: 6px;
        color: var(--vscode-descriptionForeground);
      }

      .panel {
        padding: 12px;
      }

      .panel h2 {
        margin: 0 0 10px;
        font-size: 13px;
      }

      .metric-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 0;
        border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
      }

      .metric-row:first-of-type {
        border-top: 0;
        padding-top: 0;
      }

      .metric-row span {
        color: var(--vscode-descriptionForeground);
      }

      .compact-list {
        margin: 8px 0 0;
        padding-left: 16px;
      }

      .compact-list li + li {
        margin-top: 4px;
      }

      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      button {
        appearance: none;
        border: 1px solid color-mix(in srgb, var(--vscode-button-background) 45%, var(--vscode-panel-border));
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--vscode-button-background) 78%, white 8%),
          color-mix(in srgb, var(--vscode-button-background) 92%, black 8%)
        );
        color: var(--vscode-button-foreground);
        border-radius: 10px;
        padding: 10px 8px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        transition: transform 120ms ease, filter 120ms ease;
      }

      button:hover {
        filter: brightness(1.05);
      }

      button:active {
        transform: translateY(1px);
      }

      .health-grid {
        display: grid;
        gap: 8px;
      }

      .health-card {
        padding: 10px 12px;
      }

      .health-card.ok {
        border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 42%, transparent);
      }

      .health-card.warn {
        border-color: color-mix(in srgb, var(--vscode-testing-iconQueued) 42%, transparent);
      }

      .health-card.error {
        border-color: color-mix(in srgb, var(--vscode-errorForeground) 42%, transparent);
      }

      .health-title {
        font-weight: 700;
        margin-bottom: 4px;
      }

      .health-card p,
      .muted {
        margin: 0;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="eyebrow">aSafeLobotomy</div>
        <h1>Control Center</h1>
        <div class="hero-meta">
          <span class="pill ${statusTone}">${escapeHtml(
            errorCount > 0
              ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
              : warnCount > 0
                ? `${warnCount} warning${warnCount === 1 ? "" : "s"}`
                : "Healthy"
          )}</span>
          <span class="pill ok">v${escapeHtml(snapshot.extension.version)}</span>
          <span class="pill ok">${escapeHtml(snapshot.extension.appHost)}</span>
          <span class="pill ok">${escapeHtml(snapshot.template.repoLabel)}</span>
        </div>
      </section>

      <section class="stats">
        <article class="stat-card">
          <div class="stat-label">Template</div>
          <div class="stat-value">${escapeHtml(snapshot.template.repoLabel)}</div>
          <div class="stat-note">${escapeHtml(
            snapshot.template.currentVersion
              ? `Version ${snapshot.template.currentVersion}`
              : snapshot.template.nextAction
          )}</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">Lifecycle</div>
          <div class="stat-value">${escapeHtml(templateState)}</div>
          <div class="stat-note">${escapeHtml(
            snapshot.template.ownershipMode ?? "No ownership metadata"
          )}</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">Profile</div>
          <div class="stat-value">${escapeHtml(
            snapshot.workspace.profileName ?? "Unbound"
          )}</div>
          <div class="stat-note">${escapeHtml(
            snapshot.workspace.knownProfiles.length
              ? `${snapshot.workspace.knownProfiles.length} known profile${snapshot.workspace.knownProfiles.length === 1 ? "" : "s"}`
              : "No saved profiles"
          )}</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">MCP</div>
          <div class="stat-value">${snapshot.mcp.enabled}/${snapshot.mcp.serverCount}</div>
          <div class="stat-note">${escapeHtml(
            snapshot.mcp.providerActive ? "Provider active" : "Provider inactive"
          )}</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">Workspace Index</div>
          <div class="stat-value">${escapeHtml(
            snapshot.workspaceIndex.exists ? "Present" : "Missing"
          )}</div>
          <div class="stat-note">${escapeHtml(
            snapshot.workspaceIndex.exists
              ? formatWorkspaceIndexSource(snapshot.workspaceIndex.source)
              : snapshot.workspace.name ?? "No workspace open"
          )}</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">Recommendations</div>
          <div class="stat-value">${snapshot.recommendations.matched.length}</div>
          <div class="stat-note">${escapeHtml(
            snapshot.recommendations.exists
              ? `${snapshot.recommendations.missing.length} missing / ${snapshot.recommendations.extra.length} extra`
              : "No extensions.json"
          )}</div>
        </article>
      </section>

      <section class="health-grid">
        ${healthCards}
      </section>

      <section class="panel">
        <h2>Template Lifecycle</h2>
        <div class="metric-row"><span>Repo mode</span><strong>${escapeHtml(
          snapshot.template.repoLabel
        )}</strong></div>
        <div class="metric-row"><span>State</span><strong>${escapeHtml(
          templateState
        )}</strong></div>
        <div class="metric-row"><span>Version</span><strong>${escapeHtml(
          snapshot.template.currentVersion ?? "Unavailable"
        )}</strong></div>
        <div class="metric-row"><span>Ownership</span><strong>${escapeHtml(
          snapshot.template.ownershipMode ?? "Unknown"
        )}</strong></div>
        <div class="metric-row"><span>Applied</span><strong>${escapeHtml(
          snapshot.template.appliedDate ?? "Unknown"
        )}</strong></div>
        <div class="metric-row"><span>Updated</span><strong>${escapeHtml(
          snapshot.template.updatedDate ?? "Unknown"
        )}</strong></div>
        <div class="metric-row"><span>Fingerprints</span><strong>${snapshot.template.sectionFingerprintCount}</strong></div>
        <div class="metric-row"><span>Manifest entries</span><strong>${snapshot.template.fileManifestCount}</strong></div>
        <div class="metric-row"><span>Setup answers</span><strong>${snapshot.template.setupAnswerCount}</strong></div>
        ${renderList(snapshot.template.notes, "No lifecycle notes available.")}
      </section>

      <section class="panel">
        <h2>Workspace</h2>
        <div class="metric-row"><span>Name</span><strong>${escapeHtml(
          snapshot.workspace.name ?? "No workspace"
        )}</strong></div>
        <div class="metric-row"><span>Root</span><strong>${escapeHtml(
          snapshot.workspace.root ?? "Unavailable"
        )}</strong></div>
        <div class="metric-row"><span>Heartbeat</span><strong>${escapeHtml(
          snapshot.heartbeat.sessionActive ? "Active" : "Idle"
        )}</strong></div>
        <div class="metric-row"><span>Summary</span><strong>${escapeHtml(
          snapshot.heartbeat.heartbeatSummary ?? "No HEARTBEAT.md summary"
        )}</strong></div>
      </section>

      <section class="panel">
        <h2>MCP</h2>
        <div class="metric-row"><span>Provider</span><strong>${escapeHtml(
          snapshot.mcp.providerActive ? "Active" : "Inactive"
        )}</strong></div>
        <div class="metric-row"><span>Config</span><strong>${escapeHtml(
          snapshot.mcp.configExists ? "Found" : "Missing"
        )}</strong></div>
        <div class="metric-row"><span>Servers</span><strong>${snapshot.mcp.serverCount}</strong></div>
        <div class="metric-row"><span>Disabled</span><strong>${snapshot.mcp.disabled}</strong></div>
      </section>

      <section class="panel">
        <h2>Workspace Index</h2>
        <div class="metric-row"><span>Source</span><strong>${escapeHtml(
          formatWorkspaceIndexSource(snapshot.workspaceIndex.source)
        )}</strong></div>
        ${renderCounts(snapshot.workspaceIndex.counts)}
      </section>

      <section class="panel">
        <h2>Extension Recommendations</h2>
        <div class="metric-row"><span>Recommendations file</span><strong>${escapeHtml(
          snapshot.recommendations.exists ? "Found" : "Missing"
        )}</strong></div>
        <div class="metric-row"><span>Missing</span><strong>${snapshot.recommendations.missing.length}</strong></div>
        <div class="metric-row"><span>Extra</span><strong>${snapshot.recommendations.extra.length}</strong></div>
        ${renderList(
          snapshot.recommendations.missing,
          "No missing recommended extensions."
        )}
      </section>

      <section class="panel">
        <h2>Actions</h2>
        <p class="muted">Template lifecycle actions open Copilot Chat with the canonical trigger phrases from the template.</p>
        <div class="actions">
          <button type="button" data-command="setupProject">Set Up Project</button>
          <button type="button" data-command="updateInstructions">Update Instructions</button>
          <button type="button" data-command="restoreInstructions">Restore Backup</button>
          <button type="button" data-command="factoryRestore">Factory Restore</button>
          <button type="button" data-command="refresh">Refresh</button>
          <button type="button" data-command="healthCheck">Run Health Check</button>
          <button type="button" data-command="restartMcp">Restart MCP</button>
          <button type="button" data-command="ensureRepoProfile">Switch Profile</button>
          <button type="button" data-command="checkExtensions">Review Extensions</button>
          <button type="button" data-command="openOutput">Open Output</button>
        </div>
      </section>
    </main>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      for (const button of document.querySelectorAll("button[data-command]")) {
        button.addEventListener("click", () => {
          const command = button.getAttribute("data-command");
          if (command) {
            vscode.postMessage({ command });
          }
        });
      }
    </script>
  </body>
</html>`;
}

export function registerControlCenter(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  mcpProvider: McpProvider
): void {
  const service = new ControlCenterService(context, output, mcpProvider);
  const provider = new ControlCenterViewProvider(service);
  const refresh = () => {
    void provider.refresh();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CONTROL_CENTER_VIEW_ID, provider),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.setupProject",
      async () => {
        await service.startTemplateSetup();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.updateInstructions",
      async () => {
        await service.updateTemplateInstructions();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.restoreInstructions",
      async () => {
        await service.restoreTemplateInstructions();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.factoryRestoreInstructions",
      async () => {
        await service.factoryRestoreTemplateInstructions();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.refresh",
      async () => {
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.healthCheck",
      async () => {
        await service.runHealthCheck();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.restartMcp",
      async () => {
        service.restartMcp();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.ensureRepoProfile",
      async () => {
        await service.promptAndEnsureProfile();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.checkExtensions",
      async () => {
        await service.showExtensionRecommendationDiff();
        await provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.controlCenter.openOutput",
      () => {
        service.openOutput();
      }
    ),
    vscode.workspace.onDidChangeConfiguration(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh)
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const watcherPatterns = [
    "plugin.json",
    ".github/copilot-instructions.md",
    ".github/copilot-version.md",
    ".vscode/mcp.json",
    ".vscode/extensions.json",
    ".copilot/workspace/operations/workspace-index.json",
    "template/workspace/operations/workspace-index.json",
    ".copilot/workspace/operations/HEARTBEAT.md",
    ".copilot/workspace/runtime/state.json",
    ".copilot/workspace/runtime/.heartbeat-events.jsonl",
  ];

  for (const relativePattern of watcherPatterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, relativePattern)
    );
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    context.subscriptions.push(watcher);
  }
}