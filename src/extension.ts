import * as vscode from "vscode";
import { registerProfileTools } from "./tools/profile";
import { registerExtensionTools } from "./tools/extensions";
import { registerMcpTools } from "./tools/mcp";
import { McpProvider } from "./mcp/provider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(
    "aSafeLobotomy's Copilot Extension"
  );
  output.appendLine("Activating aSafeLobotomy's Copilot Extension v0.1.0");

  // Phase 1 — Profile & Extension LM Tools (stable API)
  registerProfileTools(context);
  registerExtensionTools(context);

  // Phase 2 — MCP lifecycle (proposed API)
  const mcpProvider = new McpProvider(context, output);
  registerMcpTools(context, mcpProvider);
  mcpProvider.register();

  output.appendLine("All tools registered.");
}

export function deactivate(): void {
  // Cleanup handled by disposables in ExtensionContext.subscriptions
}
