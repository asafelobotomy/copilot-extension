import * as vscode from "vscode";
import { spawn, spawnSync } from "child_process";
import {
  configureProfileStore,
  getProfileById,
  getProfileByName,
  getProfileDetails,
  getWorkspaceProfileAssociation as getStoredWorkspaceProfileAssociation,
  listUserDataProfiles,
  resolveProfileStorePaths,
} from "../profile/store";
import { ProfileSummary } from "../profile/types";

const SAFE_PROFILE_NAME_RE = /^[\w\s\-.]+$/;

interface EnsureRepoProfileResult {
  profileName: string;
  switched: boolean;
  cli?: string;
  target?: string;
  profileId?: string | null;
  profileExists?: boolean;
  note?: string;
  error?: string;
}

interface ProfileDetailsToolInput {
  profileId?: string;
  profileName?: string;
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value)),
  ]);
}

async function resolveRequestedProfile(
  input: ProfileDetailsToolInput
): Promise<ProfileSummary | null> {
  if (input.profileId) {
    return getProfileById(input.profileId);
  }

  if (input.profileName) {
    return getProfileByName(input.profileName);
  }

  const association = await getStoredWorkspaceProfileAssociation();
  return association.profile;
}

function resolveCliTarget(): { target: string; args: string[] } | null {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile) {
    return workspaceFile.scheme === "file"
      ? {
          target: workspaceFile.fsPath,
          args: [workspaceFile.fsPath],
        }
      : {
          target: workspaceFile.toString(),
          args: ["--file-uri", workspaceFile.toString()],
        };
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceFolder) {
    return null;
  }

  return workspaceFolder.scheme === "file"
    ? {
        target: workspaceFolder.fsPath,
        args: [workspaceFolder.fsPath],
      }
    : {
        target: workspaceFolder.toString(),
        args: ["--folder-uri", workspaceFolder.toString()],
      };
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

  const cliTarget = resolveCliTarget();
  if (!cliTarget) {
    return {
      profileName,
      switched: false,
      error: "No workspace folder or workspace file open.",
    };
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

  const existingProfile = await getProfileByName(profileName);

  try {
    const child = spawn(cli, [...cliTarget.args, "--profile", profileName], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    return {
      profileName,
      switched: false,
      cli,
      target: cliTarget.target,
      profileId: existingProfile?.id ?? null,
      profileExists: Boolean(existingProfile),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    profileName,
    switched: true,
    cli,
    target: cliTarget.target,
    profileId: existingProfile?.id ?? null,
    profileExists: Boolean(existingProfile),
    note: existingProfile
      ? "VS Code will reopen the current workspace in the requested profile."
      : "VS Code will create the requested profile on open and reopen the current workspace in it.",
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
    const association = await getStoredWorkspaceProfileAssociation();
    const paths = resolveProfileStorePaths();

    return jsonResult({
      workspaceName: vscode.workspace.name ?? null,
      workspaceUri: association.workspaceUri,
      associated: association.associated,
      source: association.source,
      profile: association.profile
        ? {
            id: association.profile.id,
            name: association.profile.name,
            isDefault: association.profile.isDefault,
            exists: association.profile.exists,
          }
        : association.profileId
          ? {
              id: association.profileId,
            name: association.profileName,
              isDefault: association.isDefault,
              exists: false,
            }
          : null,
      store: {
        available: Boolean(paths),
        userRoot: paths?.userRoot ?? null,
      },
      note:
        "No stable VS Code extension API exposes the current user profile. This result reflects the profile associated with the current workspace.",
    });
  }
}

class ListProfilesTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  async prepareInvocation() {
    return { invocationMessage: "Listing VS Code profiles…" };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const profiles = await listUserDataProfiles();

    return jsonResult({
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        isDefault: profile.isDefault,
        exists: profile.exists,
        sections: profile.sections,
      })),
      count: profiles.length,
    });
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
    const association = await getStoredWorkspaceProfileAssociation();

    return jsonResult({
      workspace: vscode.workspace.name ?? null,
      workspaceUri: association.workspaceUri,
      profileId: association.profileId,
      profileName: association.profileName,
      isDefault: association.isDefault,
      bound: association.associated,
      source: association.source,
      profile: association.profile,
    });
  }
}

class GetProfileDetailsTool
  implements vscode.LanguageModelTool<ProfileDetailsToolInput>
{
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ProfileDetailsToolInput>,
    _token: vscode.CancellationToken
  ) {
    return {
      invocationMessage: options.input.profileName || options.input.profileId
        ? "Inspecting VS Code profile details…"
        : "Inspecting the current workspace profile details…",
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ProfileDetailsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const profile = await resolveRequestedProfile(options.input);

    if (!profile) {
      return jsonResult({
        error:
          "No real VS Code profile matched the request. Provide profileId or profileName, or associate the current workspace with a profile first.",
        requested: options.input,
      });
    }

    const details = await getProfileDetails(profile);

    return jsonResult({
      profile: details.profile,
      settings: details.settings,
      extensions: details.extensions,
      snippets: details.snippets,
      chatLanguageModels: details.chatLanguageModels,
      globalStorageEntries: details.globalStorageEntries,
    });
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

    return jsonResult(
      result.error
        ? {
            error: result.error,
            profileName: result.profileName,
            profileId: result.profileId ?? null,
            profileExists: result.profileExists ?? false,
          }
        : {
            action: "profile_switch",
            profileName: result.profileName,
            profileId: result.profileId ?? null,
            profileExists: result.profileExists ?? false,
            cli: result.cli,
            target: result.target,
            note: result.note,
          }
    );
  }
}

export function registerProfileTools(
  context: vscode.ExtensionContext
): void {
  configureProfileStore(context.globalStorageUri);

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
      "asafelobotomy_get_profile_details",
      new GetProfileDetailsTool()
    ),
    vscode.lm.registerTool(
      "asafelobotomy_ensure_repo_profile",
      new EnsureRepoProfileTool()
    )
  );
}
