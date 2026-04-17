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

/** Validates a marketplace extension ID: publisher.extensionName */
const EXTENSION_ID_RE = /^[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+$/;

class InstallExtensionTool
  implements vscode.LanguageModelTool<{ extensionId: string }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{ extensionId: string }>
  ) {
    return { invocationMessage: `Installing extension ${options.input.extensionId}…` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ extensionId: string }>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { extensionId } = options.input;

    if (!EXTENSION_ID_RE.test(extensionId)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            error: "Invalid extension ID. Expected format: 'publisher.extensionName' (e.g. 'ms-python.python').",
          })
        ),
      ]);
    }

    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        extensionId
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({ installed: extensionId, note: "Install triggered. Check the Extensions view for progress." })
        ),
      ]);
    } catch (err) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({ error: String(err), extensionId })
        ),
      ]);
    }
  }
}

class UninstallExtensionTool
  implements vscode.LanguageModelTool<{ extensionId: string }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{ extensionId: string }>
  ) {
    return { invocationMessage: `Uninstalling extension ${options.input.extensionId}…` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ extensionId: string }>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { extensionId } = options.input;

    if (!EXTENSION_ID_RE.test(extensionId)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            error: "Invalid extension ID. Expected format: 'publisher.extensionName' (e.g. 'ms-python.python').",
          })
        ),
      ]);
    }

    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.uninstallExtension",
        extensionId
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({ uninstalled: extensionId, note: "Uninstall triggered. A window reload may be required." })
        ),
      ]);
    } catch (err) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({ error: String(err), extensionId })
        ),
      ]);
    }
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
    ),
    vscode.lm.registerTool(
      "asafelobotomy_install_extension",
      new InstallExtensionTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_uninstall_extension",
      new UninstallExtensionTool()
    )
  );
}
