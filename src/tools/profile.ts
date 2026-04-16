import * as vscode from "vscode";

class GetActiveProfileTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ) {
    return { invocationMessage: "Reading active profile…" };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const config = vscode.workspace.getConfiguration("asafelobotomy");
    const profileName = config.get<string>("profileName", "");
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({
          profileName: profileName || null,
          configured: profileName !== "",
          workspaceName: vscode.workspace.name ?? null,
        })
      ),
    ]);
  }
}

class ListProfilesTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  async prepareInvocation() {
    return { invocationMessage: "Listing known profiles…" };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const config = vscode.workspace.getConfiguration("asafelobotomy");
    const profiles = config.get<string[]>("knownProfiles", []);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify({ profiles })),
    ]);
  }
}

class GetWorkspaceProfileAssociationTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  async prepareInvocation() {
    return { invocationMessage: "Checking workspace profile association…" };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const config = vscode.workspace.getConfiguration("asafelobotomy");
    const profileName = config.get<string>("profileName", "");
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({
          workspace: vscode.workspace.name ?? null,
          profile: profileName || null,
          bound: profileName !== "",
        })
      ),
    ]);
  }
}

class EnsureRepoProfileTool
  implements vscode.LanguageModelTool<{ profileName: string }>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
      profileName: string;
    }>,
    _token: vscode.CancellationToken
  ) {
    return {
      invocationMessage: `Switching to profile "${options.input.profileName}"…`,
      confirmationMessages: {
        title: "Switch VS Code Profile",
        message: new vscode.MarkdownString(
          `Open this workspace in profile **${options.input.profileName}**? This will reload the VS Code window.`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      profileName: string;
    }>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { profileName } = options.input;

    // Store the profile name in workspace settings
    const config = vscode.workspace.getConfiguration("asafelobotomy");
    await config.update("profileName", profileName, vscode.ConfigurationTarget.Workspace);

    // Track in known profiles (user-level)
    const known = config.get<string[]>("knownProfiles", []);
    if (!known.includes(profileName)) {
      await config.update(
        "knownProfiles",
        [...known, profileName],
        vscode.ConfigurationTarget.Global
      );
    }

    // Open workspace in the named profile via CLI
    const terminal = vscode.window.createTerminal({
      name: "Profile Switch",
      hideFromUser: true,
    });
    terminal.sendText(`code . --profile "${profileName}"`);
    terminal.dispose();

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({
          action: "profile_switch",
          profileName,
          note: "VS Code window will reload in the new profile.",
        })
      ),
    ]);
  }
}

export function registerProfileTools(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(
      "asafelobotomy_get_active_profile",
      new GetActiveProfileTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_list_profiles",
      new ListProfilesTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_get_workspace_profile_association",
      new GetWorkspaceProfileAssociationTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_ensure_repo_profile",
      new EnsureRepoProfileTool()
    )
  );
}
