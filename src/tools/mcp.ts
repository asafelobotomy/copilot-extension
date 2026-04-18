import * as vscode from "vscode";
import { McpProvider } from "../mcp/provider";
import {
  displayUriPath,
  joinWorkspaceUri,
  readJsonFile,
  writeTextFile,
} from "../workspaceFs";

interface McpServerConfig {
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  sandboxEnabled?: boolean;
  sandbox?: unknown;
  disabled?: boolean;
}

interface McpJsonFile {
  sandbox?: unknown;
  servers?: Record<string, McpServerConfig>;
}

async function readMcpJson(): Promise<{
  uri: vscode.Uri | null;
  path: string;
  data: McpJsonFile | null;
  error?: string;
}> {
  const mcpJsonUri = joinWorkspaceUri(".vscode", "mcp.json");
  if (!mcpJsonUri) {
    return {
      uri: null,
      path: "",
      data: null,
      error: "No workspace folder open.",
    };
  }
  const mcpJsonPath = displayUriPath(mcpJsonUri) ?? "";

  try {
    const data = await readJsonFile<McpJsonFile>(mcpJsonUri);
    return data
      ? { uri: mcpJsonUri, path: mcpJsonPath, data }
      : {
          uri: mcpJsonUri,
          path: mcpJsonPath,
          data: null,
          error: "Could not read .vscode/mcp.json",
        };
  } catch {
    return {
      uri: mcpJsonUri,
      path: mcpJsonPath,
      data: null,
      error: "Could not read .vscode/mcp.json",
    };
  }
}

async function writeMcpJson(mcpJsonUri: vscode.Uri, data: McpJsonFile): Promise<void> {
  await writeTextFile(mcpJsonUri, JSON.stringify(data, null, "\t") + "\n");
}

function jsonResult(obj: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(obj)),
  ]);
}

// ── GetMcpStatusTool ────────────────────────────────────────────────
class GetMcpStatusTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(private readonly provider: McpProvider) {}

  async prepareInvocation() {
    return { invocationMessage: "Checking MCP server status…" };
  }

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const { data, error } = await readMcpJson();
    if (!data) {
      return jsonResult({ error });
    }

    const servers = data.servers ?? {};
    const status = Object.entries(servers).map(([name, config]) => ({
      name,
      type: config.type ?? "stdio",
      command: config.type === "http" ? config.url : config.command,
      args: config.args ?? [],
      env: config.env ? Object.keys(config.env) : [],
      disabled: config.disabled === true,
      sandboxEnabled: config.sandboxEnabled === true,
      providerActive: this.provider.isActive(),
    }));

    const enabled = status.filter((s) => !s.disabled).length;
    const disabled = status.filter((s) => s.disabled).length;

    return jsonResult({
      serverCount: status.length,
      enabled,
      disabled,
      servers: status,
    });
  }
}

// ── GetMcpServerConfigTool ──────────────────────────────────────────
class GetMcpServerConfigTool
  implements vscode.LanguageModelTool<{ serverName: string }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
      serverName: string;
    }>
  ) {
    return {
      invocationMessage: `Reading config for MCP server "${options.input.serverName}"…`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      serverName: string;
    }>
  ): Promise<vscode.LanguageModelToolResult> {
    const { data, error } = await readMcpJson();
    if (!data) {
      return jsonResult({ error });
    }

    const servers = data.servers ?? {};
    const config = servers[options.input.serverName];
    if (!config) {
      return jsonResult({
        error: `Server "${options.input.serverName}" not found.`,
        available: Object.keys(servers),
      });
    }

    return jsonResult({
      name: options.input.serverName,
      ...config,
    });
  }
}

// ── ToggleMcpServerTool ─────────────────────────────────────────────
class ToggleMcpServerTool
  implements
    vscode.LanguageModelTool<{ serverName: string; enabled: boolean }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
      serverName: string;
      enabled: boolean;
    }>
  ) {
    const action = options.input.enabled ? "Enable" : "Disable";
    return {
      invocationMessage: `${action} MCP server "${options.input.serverName}"…`,
      confirmationMessages: {
        title: `${action} MCP Server`,
        message: new vscode.MarkdownString(
          `${action} the **${options.input.serverName}** MCP server in \`.vscode/mcp.json\`?`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      serverName: string;
      enabled: boolean;
    }>
  ): Promise<vscode.LanguageModelToolResult> {
    const { uri: mcpUri, data, error } = await readMcpJson();
    if (!mcpUri || !data) {
      return jsonResult({ error });
    }

    const servers = data.servers ?? {};
    const config = servers[options.input.serverName];
    if (!config) {
      return jsonResult({
        error: `Server "${options.input.serverName}" not found.`,
        available: Object.keys(servers),
      });
    }

    if (options.input.enabled) {
      delete config.disabled;
    } else {
      config.disabled = true;
    }

    await writeMcpJson(mcpUri, data);

    return jsonResult({
      action: options.input.enabled ? "enabled" : "disabled",
      server: options.input.serverName,
    });
  }
}

// ── RestartMcpServerTool ────────────────────────────────────────────
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

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    this.provider.triggerRestart();

    return jsonResult({
      action: "mcp_restart_triggered",
      note: "onDidChangeMcpServerDefinitions fired. VS Code will re-resolve server definitions.",
    });
  }
}

// ── AddMcpServerTool ────────────────────────────────────────────────
class AddMcpServerTool
  implements
    vscode.LanguageModelTool<{
      serverName: string;
      type: string;
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
      serverName: string;
      type: string;
    }>
  ) {
    return {
      invocationMessage: `Adding MCP server "${options.input.serverName}"…`,
      confirmationMessages: {
        title: "Add MCP Server",
        message: new vscode.MarkdownString(
          `Add a new **${options.input.type}** MCP server named **${options.input.serverName}** to \`.vscode/mcp.json\`?`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      serverName: string;
      type: string;
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    }>
  ): Promise<vscode.LanguageModelToolResult> {
    const { uri: mcpUri, data, error } = await readMcpJson();
    if (!mcpUri || !data) {
      return jsonResult({ error });
    }

    if (!data.servers) {
      data.servers = {};
    }

    if (data.servers[options.input.serverName]) {
      return jsonResult({
        error: `Server "${options.input.serverName}" already exists. Remove it first or use a different name.`,
      });
    }

    const entry: McpServerConfig = {
      type: options.input.type,
    };
    if (options.input.type === "http" && options.input.url) {
      entry.url = options.input.url;
    } else {
      if (options.input.command) entry.command = options.input.command;
      if (options.input.args?.length) entry.args = options.input.args;
    }
    if (options.input.env && Object.keys(options.input.env).length) {
      entry.env = options.input.env;
    }

    data.servers[options.input.serverName] = entry;
    await writeMcpJson(mcpUri, data);

    return jsonResult({
      action: "server_added",
      server: options.input.serverName,
      config: entry,
    });
  }
}

// ── RemoveMcpServerTool ─────────────────────────────────────────────
class RemoveMcpServerTool
  implements vscode.LanguageModelTool<{ serverName: string }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
      serverName: string;
    }>
  ) {
    return {
      invocationMessage: `Removing MCP server "${options.input.serverName}"…`,
      confirmationMessages: {
        title: "Remove MCP Server",
        message: new vscode.MarkdownString(
          `Remove **${options.input.serverName}** from \`.vscode/mcp.json\`? This cannot be undone.`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      serverName: string;
    }>
  ): Promise<vscode.LanguageModelToolResult> {
    const { uri: mcpUri, data, error } = await readMcpJson();
    if (!mcpUri || !data) {
      return jsonResult({ error });
    }

    const servers = data.servers ?? {};
    if (!servers[options.input.serverName]) {
      return jsonResult({
        error: `Server "${options.input.serverName}" not found.`,
        available: Object.keys(servers),
      });
    }

    delete servers[options.input.serverName];
    await writeMcpJson(mcpUri, data);

    return jsonResult({
      action: "server_removed",
      server: options.input.serverName,
    });
  }
}

// ── Registration ────────────────────────────────────────────────────
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
      "asafelobotomy_get_mcp_server_config",
      new GetMcpServerConfigTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_toggle_mcp_server",
      new ToggleMcpServerTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_restart_mcp_server",
      new RestartMcpServerTool(provider)
    ),
    vscode.lm.registerTool(
      "asafelobotomy_add_mcp_server",
      new AddMcpServerTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_remove_mcp_server",
      new RemoveMcpServerTool()
    )
  );
}
