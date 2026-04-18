import * as vscode from "vscode";
import { joinWorkspaceUri, readTextFile } from "../workspaceFs";

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

  private async provideMcpServerDefinitions(
    _token: vscode.CancellationToken
  ): Promise<unknown[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const mcpJsonUri = joinWorkspaceUri(".vscode", "mcp.json");
    if (!mcpJsonUri) {
      return [];
    }

    try {
      const raw = await readTextFile(mcpJsonUri);
      if (!raw) {
        throw new Error("Could not read mcp.json for provider.");
      }

      const parsed = JSON.parse(raw);
      const servers = parsed.servers ?? {};
      const cwdUri = workspaceFolder.uri;
      const definitions: unknown[] = [];

      for (const [name, config] of Object.entries(servers)) {
        const c = config as Record<string, unknown>;
        const label = name;

        if (c.type === "stdio" || (!c.type && c.command)) {
          const def = new vscode.McpStdioServerDefinition(
            label,
            c.command as string,
            (c.args as string[] | undefined) ?? [],
            (c.env as Record<string, string | null> | undefined) ?? {}
          );
          def.cwd = cwdUri;
          definitions.push(def);
        } else if (c.type === "http" && c.url) {
          const def = new vscode.McpHttpServerDefinition(
            label,
            vscode.Uri.parse(c.url as string),
            (c.headers as Record<string, string> | undefined) ?? {}
          );
          definitions.push(def);
        }
      }

      return definitions;
    } catch {
      this.output.appendLine("Could not read mcp.json for provider.");
      return [];
    }
  }

  private async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition
  ): Promise<vscode.McpServerDefinition | undefined> {
    // Pass through — no additional resolution needed
    return server;
  }
}
