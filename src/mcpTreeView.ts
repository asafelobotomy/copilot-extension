import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { McpProvider } from "./mcp/provider";

const MCP_TREE_VIEW_ID = "asafelobotomy.mcpServers";

interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  disabled?: boolean;
  sandbox?: McpSandboxConfig;
}

interface McpSandboxConfig {
  filesystem?: {
    allowWrite?: string[];
  };
  network?: {
    allowedDomains?: string[];
  };
}

interface McpJsonFile {
  sandbox?: McpSandboxConfig;
  servers?: Record<string, McpServerConfig>;
}

interface McpReadResult {
  filePath: string | null;
  data: McpJsonFile | null;
  error?: string;
  missing?: boolean;
}

interface McpValidationReport {
  errors: string[];
  warnings: string[];
}

class McpServerItem extends vscode.TreeItem {
  constructor(
    readonly serverName: string,
    readonly config: McpServerConfig
  ) {
    super(serverName, vscode.TreeItemCollapsibleState.None);

    const type = config.type ?? (config.url ? "http" : "stdio");
    const disabled = config.disabled === true;
    this.description = `${disabled ? "disabled" : "enabled"} · ${type}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${serverName}**`,
        `Transport: ${type}`,
        config.url
          ? `URL: ${config.url}`
          : `Command: ${config.command ?? "unconfigured"}`,
        config.args?.length ? `Args: ${config.args.join(" ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    this.contextValue = disabled
      ? "asafelobotomy.mcpServer.disabled"
      : "asafelobotomy.mcpServer.enabled";
    this.iconPath = disabled
      ? new vscode.ThemeIcon("circle-slash")
      : new vscode.ThemeIcon(type === "http" ? "globe" : "server-process");
  }
}

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function getTransport(config: McpServerConfig): string {
  return config.type ?? (config.url ? "http" : "stdio");
}

function getCommandName(command: string | undefined): string {
  return path.basename(command ?? "").toLowerCase();
}

function containsPathFragment(entries: string[] | undefined, fragment: string): boolean {
  return (entries ?? []).some((entry) => entry.includes(fragment));
}

function containsDomain(entries: string[] | undefined, domain: string): boolean {
  return (entries ?? []).some((entry) => entry === domain);
}

function buildValidationReport(data: McpJsonFile): McpValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries = Object.entries(data.servers ?? {});

  if (!entries.length) {
    warnings.push("No MCP servers are configured under servers.");
  }

  for (const [serverName, config] of entries) {
    const transport = getTransport(config);
    if (transport === "http") {
      if (!config.url) {
        errors.push(`${serverName}: http transport is missing a url.`);
      }
    } else if (!config.command) {
      errors.push(`${serverName}: stdio transport is missing a command.`);
    }

    const commandName = getCommandName(config.command);
    const effectiveSandbox = config.sandbox ?? data.sandbox;
    const allowWrite = effectiveSandbox?.filesystem?.allowWrite;
    const allowedDomains = effectiveSandbox?.network?.allowedDomains;
    const perServerOverride = Boolean(config.sandbox);
    const overrideSuffix = perServerOverride
      ? " Per-server sandbox blocks replace global sandbox settings."
      : "";

    if (commandName === "npx") {
      if (!containsPathFragment(allowWrite, ".npm")) {
        warnings.push(
          `${serverName}: npx server sandbox should allow writes to \\${userHome}/.npm.${overrideSuffix}`
        );
      }
      if (!containsDomain(allowedDomains, "registry.npmjs.org")) {
        warnings.push(
          `${serverName}: npx server sandbox should allow network access to registry.npmjs.org.${overrideSuffix}`
        );
      }
    }

    if (commandName === "uvx") {
      if (!containsPathFragment(allowWrite, ".cache/uv")) {
        warnings.push(
          `${serverName}: uvx server sandbox should allow writes to \\${userHome}/.cache/uv.${overrideSuffix}`
        );
      }
      if (!containsPathFragment(allowWrite, ".local/share/uv")) {
        warnings.push(
          `${serverName}: uvx server sandbox should allow writes to \\${userHome}/.local/share/uv.${overrideSuffix}`
        );
      }
      if (!containsDomain(allowedDomains, "pypi.org")) {
        warnings.push(
          `${serverName}: uvx server sandbox should allow network access to pypi.org.${overrideSuffix}`
        );
      }
      if (!containsDomain(allowedDomains, "files.pythonhosted.org")) {
        warnings.push(
          `${serverName}: uvx server sandbox should allow network access to files.pythonhosted.org.${overrideSuffix}`
        );
      }
    }
  }

  return { errors, warnings };
}

async function readMcpJson(): Promise<McpReadResult> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return {
      filePath: null,
      data: null,
      error: "No workspace folder open.",
    };
  }

  const filePath = path.join(workspaceRoot, ".vscode", "mcp.json");
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    try {
      return { filePath, data: JSON.parse(raw) as McpJsonFile };
    } catch {
      return {
        filePath,
        data: null,
        error: "Could not parse .vscode/mcp.json",
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        filePath,
        data: null,
        missing: true,
      };
    }

    return {
      filePath,
      data: null,
      error: "Could not read .vscode/mcp.json",
    };
  }
}

async function writeMcpJson(filePath: string, data: McpJsonFile): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, "\t") + "\n");
}

async function openOrCreateMcpConfig(
  output: vscode.OutputChannel
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder before editing MCP configuration."
    );
    return;
  }

  const filePath = path.join(workspaceRoot, ".vscode", "mcp.json");
  if (!fs.existsSync(filePath)) {
    const createChoice = await vscode.window.showInformationMessage(
      "No .vscode/mcp.json exists for this workspace. Create one now?",
      "Create Config",
      "Cancel"
    );

    if (createChoice !== "Create Config") {
      return;
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await writeMcpJson(filePath, { servers: {} });
    output.appendLine("[MCP Tree] Created .vscode/mcp.json.");
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function validateMcpConfig(output: vscode.OutputChannel): Promise<void> {
  const { data, missing, error } = await readMcpJson();
  if (!data) {
    if (missing) {
      const choice = await vscode.window.showWarningMessage(
        "No .vscode/mcp.json exists for this workspace.",
        "Create Config"
      );
      if (choice === "Create Config") {
        await openOrCreateMcpConfig(output);
      }
      return;
    }

    void vscode.window.showErrorMessage(error ?? "Could not read MCP config.");
    return;
  }

  const report = buildValidationReport(data);
  output.appendLine("[MCP Tree] Validation summary");
  for (const item of report.errors) {
    output.appendLine(`[MCP Tree][ERROR] ${item}`);
  }
  for (const item of report.warnings) {
    output.appendLine(`[MCP Tree][WARN] ${item}`);
  }

  if (!report.errors.length && !report.warnings.length) {
    output.appendLine("[MCP Tree][OK] MCP config looks healthy.");
    void vscode.window.showInformationMessage("MCP config looks healthy.");
    return;
  }

  if (report.errors.length > 0) {
    void vscode.window.showErrorMessage(
      `MCP config validation found ${report.errors.length} error${report.errors.length === 1 ? "" : "s"} and ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}. See the extension output for details.`
    );
    return;
  }

  void vscode.window.showWarningMessage(
    `MCP config validation found ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}. See the extension output for details.`
  );
}

class McpServersProvider implements vscode.TreeDataProvider<McpServerItem> {
  private readonly didChangeTreeData = new vscode.EventEmitter<
    McpServerItem | undefined | void
  >();
  private treeView: vscode.TreeView<McpServerItem> | undefined;

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly mcpProvider: McpProvider
  ) {}

  attach(treeView: vscode.TreeView<McpServerItem>): void {
    this.treeView = treeView;
  }

  refresh(): void {
    this.didChangeTreeData.fire();
  }

  getTreeItem(element: McpServerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: McpServerItem): Promise<McpServerItem[]> {
    if (element) {
      return [];
    }

    const { data, error } = await readMcpJson();
    if (!data) {
      if (this.treeView) {
        this.treeView.message = error;
      }
      return [];
    }

    const entries = Object.entries(data.servers ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    );

    if (!entries.length) {
      if (this.treeView) {
        this.treeView.message = undefined;
      }
      return [];
    }

    if (this.treeView) {
      const disabledCount = entries.filter(
        ([, config]) => config.disabled === true
      ).length;
      this.treeView.message = this.mcpProvider.isActive()
        ? `${entries.length} server${entries.length === 1 ? "" : "s"} • ${disabledCount} disabled`
        : `Provider inactive • ${entries.length} configured server${entries.length === 1 ? "" : "s"}`;
    }

    return entries.map(
      ([serverName, config]) => new McpServerItem(serverName, config)
    );
  }

  async setServerEnabled(
    item: McpServerItem,
    enabled: boolean
  ): Promise<void> {
    const { filePath, data, error } = await readMcpJson();
    if (!filePath || !data) {
      void vscode.window.showErrorMessage(error ?? "Could not read MCP config.");
      return;
    }

    if (!data.servers?.[item.serverName]) {
      void vscode.window.showErrorMessage(
        `Server ${item.serverName} no longer exists in .vscode/mcp.json.`
      );
      return;
    }

    if (enabled) {
      delete data.servers[item.serverName].disabled;
    } else {
      data.servers[item.serverName].disabled = true;
    }

    await writeMcpJson(filePath, data);
    this.output.appendLine(
      `[MCP Tree] ${enabled ? "Enabled" : "Disabled"} ${item.serverName}.`
    );
    this.mcpProvider.triggerRestart();
    this.refresh();
  }
}

export function registerMcpTreeView(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  mcpProvider: McpProvider
): void {
  const provider = new McpServersProvider(output, mcpProvider);
  const treeView = vscode.window.createTreeView(MCP_TREE_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  provider.attach(treeView);

  const refresh = () => provider.refresh();

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("asafelobotomy.mcpTree.refresh", refresh),
    vscode.commands.registerCommand("asafelobotomy.mcpTree.restart", () => {
      mcpProvider.triggerRestart();
      output.appendLine("[MCP Tree] Restart requested.");
      provider.refresh();
      void vscode.window.showInformationMessage("MCP server restart triggered.");
    }),
    vscode.commands.registerCommand("asafelobotomy.mcpTree.openConfig", async () => {
      await openOrCreateMcpConfig(output);
      provider.refresh();
    }),
    vscode.commands.registerCommand(
      "asafelobotomy.mcpTree.validateConfig",
      async () => {
        await validateMcpConfig(output);
        provider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.mcpTree.enableServer",
      async (item: McpServerItem) => {
        await provider.setServerEnabled(item, true);
      }
    ),
    vscode.commands.registerCommand(
      "asafelobotomy.mcpTree.disableServer",
      async (item: McpServerItem) => {
        await provider.setServerEnabled(item, false);
      }
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration(refresh)
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, ".vscode/mcp.json")
  );
  watcher.onDidChange(refresh);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);
}