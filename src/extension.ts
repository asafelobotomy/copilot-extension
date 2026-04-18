import * as vscode from "vscode";
import { registerProfileTools } from "./tools/profile";
import { registerExtensionTools } from "./tools/extensions";
import { registerMcpTools } from "./tools/mcp";
import { registerWorkspaceTools } from "./tools/workspace";
import { registerHeartbeatTools } from "./tools/heartbeat";
import { McpProvider } from "./mcp/provider";
import { registerControlCenter } from "./controlCenter";
import { registerMcpTreeView } from "./mcpTreeView";
import { configureProfileStore } from "./profile/store";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(
    "aSafeLobotomy's Copilot Extension"
  );
  context.subscriptions.push(output);
  const extensionVersion = context.extension.packageJSON.version ?? "unknown";
  output.appendLine(
    `Activating aSafeLobotomy's Copilot Extension v${extensionVersion}`
  );
  configureProfileStore(context.globalStorageUri);

  // Phase 1 — Profile & Extension LM Tools (stable API)
  registerProfileTools(context);
  registerExtensionTools(context);

  // Phase 1b — Workspace & Heartbeat LM Tools (stable API)
  registerWorkspaceTools(context);
  registerHeartbeatTools(context);

  // Phase 2 — MCP lifecycle (proposed API)
  const mcpProvider = new McpProvider(context, output);
  registerMcpTools(context, mcpProvider);
  mcpProvider.register();
  registerControlCenter(context, output, mcpProvider);
  registerMcpTreeView(context, output, mcpProvider);

  output.appendLine("All tools and UI registered.");
}

export function deactivate(): void {
  // Cleanup handled by disposables in ExtensionContext.subscriptions
}
