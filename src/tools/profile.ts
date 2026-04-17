import * as vscode from "vscode";
import { spawn, spawnSync } from "child_process";

const SAFE_PROFILE_NAME_RE = /^[\w\s\-.]+$/;

interface EnsureRepoProfileResult {
  profileName: string;
  switched: boolean;
  cli?: string;
  target?: string;
  note?: string;
  error?: string;
}

function resolveCodeCli(): string | null {
  const preferred = vscode.env.appName.toLowerCase().includes("insider")
    ? ["code-insiders", "code"]
    : ["code", "code-insiders"];

  for (const candidate of preferred) {
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

export async function ensureRepoProfile(
  profileName: string
): Promise<EnsureRepoProfileResult> {
  if (!SAFE_PROFILE_NAME_RE.test(profileName)) {
    return {
      profileName,
      switched: false,
      error:
        "Invalid profile name. Only letters, numbers, spaces, hyphens, underscores, and dots are allowed.",
    };
  }

  const target =
    vscode.workspace.workspaceFile?.fsPath ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!target) {
    return {
      profileName,
      switched: false,
      error: "No workspace folder or workspace file open.",
    };
  }

  const config = vscode.workspace.getConfiguration("asafelobotomy");
  await config.update(
    "profileName",
    profileName,
    vscode.ConfigurationTarget.Workspace
  );

  const known = config.get<string[]>("knownProfiles", []);
  if (!known.includes(profileName)) {
    await config.update(
      "knownProfiles",
      [...known, profileName],
      vscode.ConfigurationTarget.Global
    );
  }

  const cli = resolveCodeCli();
  if (!cli) {
    return {
      profileName,
      switched: false,
      error:
        "Could not find a VS Code CLI. Install either 'code' or 'code-insiders' in PATH.",
    };
  }

  try {
    const child = spawn(cli, [target, "--profile", profileName], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    return {
      profileName,
      switched: false,
      cli,
      target,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    profileName,
    switched: true,
    cli,
    target,
    note: "VS Code will open the current workspace in the requested profile.",
  };
}

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
    const result = await ensureRepoProfile(options.input.profileName);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify(
          result.error
            ? { error: result.error, profileName: result.profileName }
            : {
                action: "profile_switch",
                profileName: result.profileName,
                cli: result.cli,
                target: result.target,
                note: result.note,
              }
        )
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
