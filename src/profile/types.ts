export const DEFAULT_PROFILE_ID = "__default__profile__";

export type ProfileDataSource = "storage.json" | "none";

export interface ProfileStorePaths {
  appDataRoot: string;
  userRoot: string;
  profilesRoot: string;
  globalStorageRoot: string;
  storageJsonPath: string;
}

export interface UserDataProfileRecord {
  location: string;
  name: string;
}

export interface UserDataProfileIndex {
  userDataProfiles?: UserDataProfileRecord[];
  profileAssociations?: {
    workspaces?: Record<string, string>;
    emptyWindows?: Record<string, string>;
  };
}

export interface ProfilePaths {
  rootPath: string | null;
  settingsPath: string | null;
  extensionsPath: string | null;
  snippetsPath: string | null;
  chatLanguageModelsPath: string | null;
  globalStoragePath: string | null;
}

export interface ProfileSummary {
  id: string;
  name: string;
  isDefault: boolean;
  exists: boolean;
  paths: ProfilePaths;
  sections: {
    settings: boolean;
    extensions: boolean;
    snippets: boolean;
    chatLanguageModels: boolean;
    globalStorage: boolean;
  };
}

export interface WorkspaceProfileAssociation {
  workspaceUri: string | null;
  profileId: string | null;
  profileName: string | null;
  isDefault: boolean;
  associated: boolean;
  source: ProfileDataSource;
  profile: ProfileSummary | null;
}

export interface ProfileExtensionSummary {
  id: string;
  version: string;
  preRelease: boolean;
  pinned: boolean;
  source: string | null;
}

export interface ProfileDetails {
  profile: ProfileSummary;
  settings: Record<string, unknown> | null;
  extensions: ProfileExtensionSummary[] | null;
  snippets: string[];
  chatLanguageModels: unknown | null;
  globalStorageEntries: string[];
}