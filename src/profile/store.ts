import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parse } from "jsonc-parser";
import {
  DEFAULT_PROFILE_ID,
  ProfileDetails,
  ProfileExtensionSummary,
  ProfilePaths,
  ProfileStorePaths,
  ProfileSummary,
  UserDataProfileIndex,
  WorkspaceProfileAssociation,
} from "./types";

let configuredProfileStorePaths: ProfileStorePaths | null = null;

function exists(filePath: string | null): boolean {
  return Boolean(filePath && fs.existsSync(filePath));
}

function getCurrentWorkspaceUri(): string | null {
  if (vscode.workspace.workspaceFile) {
    return vscode.workspace.workspaceFile.toString();
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null;
}

function getAppDataRoot(): string | null {
  switch (os.platform()) {
    case "linux":
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        vscode.env.appName
      );
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        vscode.env.appName
      );
    case "win32":
      return process.env.APPDATA
        ? path.join(process.env.APPDATA, vscode.env.appName)
        : null;
    default:
      return null;
  }
}

export function configureProfileStore(globalStorageUri: vscode.Uri): void {
  const extensionStorageRoot = globalStorageUri.fsPath;
  if (!extensionStorageRoot) {
    return;
  }

  const globalStorageRoot = path.dirname(extensionStorageRoot);
  const userRoot = path.dirname(globalStorageRoot);
  configuredProfileStorePaths = {
    appDataRoot: path.dirname(userRoot),
    userRoot,
    profilesRoot: path.join(userRoot, "profiles"),
    globalStorageRoot,
    storageJsonPath: path.join(globalStorageRoot, "storage.json"),
  };
}

function getProfilePaths(userRoot: string, profileId: string): ProfilePaths {
  const isDefault = profileId === DEFAULT_PROFILE_ID;
  const rootPath = isDefault ? userRoot : path.join(userRoot, "profiles", profileId);

  return {
    rootPath,
    settingsPath: path.join(rootPath, "settings.json"),
    extensionsPath: path.join(rootPath, "extensions.json"),
    snippetsPath: path.join(rootPath, "snippets"),
    chatLanguageModelsPath: path.join(rootPath, "chatLanguageModels.json"),
    globalStoragePath: path.join(rootPath, "globalStorage"),
  };
}

function createProfileSummary(
  userRoot: string,
  profileId: string,
  profileName: string
): ProfileSummary {
  const paths = getProfilePaths(userRoot, profileId);

  return {
    id: profileId,
    name: profileName,
    isDefault: profileId === DEFAULT_PROFILE_ID,
    exists: exists(paths.rootPath),
    paths,
    sections: {
      settings: exists(paths.settingsPath),
      extensions: exists(paths.extensionsPath),
      snippets: exists(paths.snippetsPath),
      chatLanguageModels: exists(paths.chatLanguageModelsPath),
      globalStorage: exists(paths.globalStoragePath),
    },
  };
}

async function readPlainJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsoncObject(
  filePath: string | null
): Promise<Record<string, unknown> | null> {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function simplifyExtensions(
  rawExtensions: Array<Record<string, unknown>>
): ProfileExtensionSummary[] {
  return rawExtensions
    .map((extension) => {
      const identifier = extension.identifier as
        | Record<string, unknown>
        | undefined;
      const metadata = extension.metadata as Record<string, unknown> | undefined;
      const id = typeof identifier?.id === "string" ? identifier.id : null;
      const version =
        typeof extension.version === "string" ? extension.version : "unknown";

      if (!id) {
        return null;
      }

      return {
        id,
        version,
        preRelease: metadata?.preRelease === true,
        pinned: metadata?.pinned === true,
        source: typeof metadata?.source === "string" ? metadata.source : null,
      };
    })
    .filter((extension): extension is ProfileExtensionSummary => extension !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function listFilesRecursive(rootPath: string | null): Promise<string[]> {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return [];
  }

  const results: string[] = [];

  async function walk(currentPath: string, prefix: string): Promise<void> {
    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const nextPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walk(nextPath, relativePath);
        continue;
      }

      results.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return results.sort((left, right) => left.localeCompare(right));
}

export function resolveProfileStorePaths(): ProfileStorePaths | null {
  if (configuredProfileStorePaths) {
    return configuredProfileStorePaths;
  }

  const appDataRoot = getAppDataRoot();
  if (!appDataRoot) {
    return null;
  }

  const userRoot = path.join(appDataRoot, "User");
  return {
    appDataRoot,
    userRoot,
    profilesRoot: path.join(userRoot, "profiles"),
    globalStorageRoot: path.join(userRoot, "globalStorage"),
    storageJsonPath: path.join(userRoot, "globalStorage", "storage.json"),
  };
}

export async function readUserDataProfileIndex(): Promise<UserDataProfileIndex | null> {
  const paths = resolveProfileStorePaths();
  if (!paths) {
    return null;
  }

  return readPlainJson<UserDataProfileIndex>(paths.storageJsonPath);
}

export async function listUserDataProfiles(): Promise<ProfileSummary[]> {
  const paths = resolveProfileStorePaths();
  if (!paths) {
    return [];
  }

  const index = await readUserDataProfileIndex();
  const profiles = [
    createProfileSummary(paths.userRoot, DEFAULT_PROFILE_ID, "Default"),
    ...(index?.userDataProfiles ?? [])
      .map((profile) =>
        createProfileSummary(paths.userRoot, profile.location, profile.name)
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
  ];

  return profiles;
}

export async function getProfileById(
  profileId: string
): Promise<ProfileSummary | null> {
  const profiles = await listUserDataProfiles();
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

export async function getProfileByName(
  profileName: string
): Promise<ProfileSummary | null> {
  const profiles = await listUserDataProfiles();
  return (
    profiles.find(
      (profile) => profile.name.toLowerCase() === profileName.toLowerCase()
    ) ?? null
  );
}

export async function getWorkspaceProfileAssociation(): Promise<WorkspaceProfileAssociation> {
  const workspaceUri = getCurrentWorkspaceUri();
  const paths = resolveProfileStorePaths();
  const index = await readUserDataProfileIndex();
  const profileId = workspaceUri
    ? index?.profileAssociations?.workspaces?.[workspaceUri] ?? null
    : null;
  const profile = profileId && paths
    ? await getProfileById(profileId)
    : null;

  return {
    workspaceUri,
    profileId,
    profileName: profile?.name ?? null,
    isDefault: profile?.isDefault ?? false,
    associated: Boolean(profileId),
    source: profileId ? "storage.json" : "none",
    profile,
  };
}

export async function getProfileDetails(
  profile: ProfileSummary
): Promise<ProfileDetails> {
  const rawExtensions = profile.paths.extensionsPath
    ? await readPlainJson<Array<Record<string, unknown>>>(
        profile.paths.extensionsPath
      )
    : null;
  const chatLanguageModels = profile.paths.chatLanguageModelsPath
    ? await readPlainJson<unknown>(profile.paths.chatLanguageModelsPath)
    : null;

  return {
    profile,
    settings: await readJsoncObject(profile.paths.settingsPath),
    extensions: Array.isArray(rawExtensions)
      ? simplifyExtensions(rawExtensions)
      : null,
    snippets: await listFilesRecursive(profile.paths.snippetsPath),
    chatLanguageModels,
    globalStorageEntries: await listFilesRecursive(profile.paths.globalStoragePath),
  };
}