import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * McpProvider registers as an MCP server definition provider using the
 * proposed `registerMcpServerDefinitionProvider` API. It reads server
 * definitions from `.vscode/mcp.json` and exposes them to VS Code,
 * allowing programmatic restart via `onDidChangeMcpServerDefinitions`.
 *
 * NOTE: This uses a proposed API (`mcpServerDefinitionProvider`) that
 * requires `enabledApiProposals` in package.json.
 */
export class McpProvider {
  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  private active = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  get onDidChangeMcpServerDefinitions(): vscode.Event<void> {
    return this.didChangeEmitter.event;
  }

  isActive(): boolean {
    return this.active;
  }

  triggerRestart(): void {
    this.output.appendLine("MCP restart triggered — firing didChange event.");
    this.didChangeEmitter.fire();
  }

  register(): void {
    try {
      // The proposed API may not exist at runtime if VS Code version is too old
      // or if the proposal is not enabled. Guard with a try-catch.
      const lm = vscode.lm as typeof vscode.lm & {
        registerMcpServerDefinitionProvider?: (
          id: string,
          provider: unknown
        ) => vscode.Disposable;
      };

      if (typeof lm.registerMcpServerDefinitionProvider !== "function") {
        this.output.appendLine(
          "MCP server definition provider API not available — skipping Phase 2 registration."
        );
        return;
      }

      const disposable = lm.registerMcpServerDefinitionProvider(
        "asafelobotomyMcp",
        {
          onDidChangeMcpServerDefinitions:
            this.onDidChangeMcpServerDefinitions,
          provideMcpServerDefinitions:
            this.provideMcpServerDefinitions.bind(this),
          resolveMcpServerDefinition:
            this.resolveMcpServerDefinition.bind(this),
        }
      );

      this.context.subscriptions.push(disposable);
      this.context.subscriptions.push(this.didChangeEmitter);
      this.active = true;
      this.output.appendLine("MCP server definition provider registered.");

      // Watch for mcp.json changes to auto-refresh
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders?.length) {
        const mcpJsonPattern = new vscode.RelativePattern(
          workspaceFolders[0],
          ".vscode/mcp.json"
        );
        const watcher = vscode.workspace.createFileSystemWatcher(mcpJsonPattern);
        watcher.onDidChange(() => {
          this.output.appendLine("mcp.json changed — triggering MCP re-resolution.");
          this.didChangeEmitter.fire();
        });
        this.context.subscriptions.push(watcher);
      }
    } catch (err) {
      this.output.appendLine(
        `MCP provider registration failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async provideMcpServerDefinitions(): Promise<unknown[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      return [];
    }

    const mcpJsonPath = path.join(
      workspaceFolders[0].uri.fsPath,
      ".vscode",
      "mcp.json"
    );

    try {
      const raw = fs.readFileSync(mcpJsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      const servers = parsed.servers ?? {};

      return Object.entries(servers)
        .filter(
          ([, config]: [string, unknown]) =>
            (config as Record<string, unknown>).type === "stdio"
        )
        .map(([name, config]: [string, unknown]) => {
          const c = config as Record<string, unknown>;
          return {
            name: `asafelobotomy-${name}`,
            label: name,
            version: "1",
            command: c.command as string,
            args: (c.args as string[]) ?? [],
            env: (c.env as Record<string, string>) ?? {},
            cwd: workspaceFolders[0].uri.fsPath,
          };
        });
    } catch {
      this.output.appendLine("Could not read mcp.json for provider.");
      return [];
    }
  }

  private async resolveMcpServerDefinition(
    server: unknown
  ): Promise<unknown | undefined> {
    // Pass through — no additional resolution needed
    return server;
  }
}
