import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { McpProvider } from "../mcp/provider";

interface McpServerConfig {
  type: string;
  command?: string;
  args?: string[];
  url?: string;
}

class GetMcpStatusTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(private readonly provider: McpProvider) {}

  async prepareInvocation() {
    return { invocationMessage: "Checking MCP server status…" };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({ error: "No workspace folder open." })
        ),
      ]);
    }

    const mcpJsonPath = path.join(
      workspaceFolders[0].uri.fsPath,
      ".vscode",
      "mcp.json"
    );

    let servers: Record<string, McpServerConfig> = {};
    try {
      const raw = fs.readFileSync(mcpJsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      servers = parsed.servers ?? {};
    } catch {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            error: "Could not read .vscode/mcp.json",
            path: mcpJsonPath,
          })
        ),
      ]);
    }

    const status = Object.entries(servers).map(([name, config]) => ({
      name,
      type: config.type ?? "stdio",
      command: config.command ?? config.url ?? "unknown",
      providerActive: this.provider.isActive(),
    }));

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({ serverCount: status.length, servers: status })
      ),
    ]);
  }
}

class RestartMcpServerTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(private readonly provider: McpProvider) {}

  async prepareInvocation() {
    return {
      invocationMessage: "Restarting MCP servers…",
      confirmationMessages: {
        title: "Restart MCP Servers",
        message: new vscode.MarkdownString(
          "This will trigger VS Code to re-resolve all MCP server definitions, effectively restarting managed servers. Continue?"
        ),
      },
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    this.provider.triggerRestart();

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({
          action: "mcp_restart_triggered",
          note: "onDidChangeMcpServerDefinitions fired. VS Code will re-resolve server definitions.",
        })
      ),
    ]);
  }
}

export function registerMcpTools(
  context: vscode.ExtensionContext,
  provider: McpProvider
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(
      "asafelobotomy_get_mcp_status",
      new GetMcpStatusTool(provider)
    ),
    vscode.lm.registerTool(
      "asafelobotomy_restart_mcp_server",
      new RestartMcpServerTool(provider)
    )
  );
}
