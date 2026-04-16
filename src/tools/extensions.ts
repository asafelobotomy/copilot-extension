import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

class GetInstalledExtensionsTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  async prepareInvocation() {
    return { invocationMessage: "Enumerating installed extensions…" };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const extensions = vscode.extensions.all
      .filter((ext) => !ext.id.startsWith("vscode."))
      .map((ext) => ({
        id: ext.id,
        version: ext.packageJSON?.version ?? "unknown",
        active: ext.isActive,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({ count: extensions.length, extensions })
      ),
    ]);
  }
}

class SyncExtensionsWithRecommendationsTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  async prepareInvocation() {
    return { invocationMessage: "Comparing extensions with recommendations…" };
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

    const extJsonPath = path.join(
      workspaceFolders[0].uri.fsPath,
      ".vscode",
      "extensions.json"
    );

    let recommendations: string[] = [];
    try {
      const raw = fs.readFileSync(extJsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      recommendations = (parsed.recommendations ?? []).map((r: string) =>
        r.toLowerCase()
      );
    } catch {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            error: "Could not read .vscode/extensions.json",
            path: extJsonPath,
          })
        ),
      ]);
    }

    const installed = new Set(
      vscode.extensions.all
        .filter((ext) => !ext.id.startsWith("vscode."))
        .map((ext) => ext.id.toLowerCase())
    );

    const missing = recommendations.filter((r) => !installed.has(r));
    const extra = [...installed].filter((i) => !recommendations.includes(i));
    const matched = recommendations.filter((r) => installed.has(r));

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({ missing, extra, matched })
      ),
    ]);
  }
}

export function registerExtensionTools(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(
      "asafelobotomy_get_installed_extensions",
      new GetInstalledExtensionsTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_sync_extensions_with_recommendations",
      new SyncExtensionsWithRecommendationsTool()
    )
  );
}
