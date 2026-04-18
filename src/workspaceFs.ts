import * as vscode from "vscode";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | null {
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

export function getPrimaryWorkspaceUri(): vscode.Uri | null {
  return getPrimaryWorkspaceFolder()?.uri ?? null;
}

export function joinFromUri(
  baseUri: vscode.Uri | null,
  ...paths: string[]
): vscode.Uri | null {
  return baseUri ? vscode.Uri.joinPath(baseUri, ...paths) : null;
}

export function joinWorkspaceUri(...paths: string[]): vscode.Uri | null {
  return joinFromUri(getPrimaryWorkspaceUri(), ...paths);
}

export function displayUriPath(uri: vscode.Uri | null): string | null {
  if (!uri) {
    return null;
  }

  return uri.scheme === "file" ? uri.fsPath : uri.path;
}

export function dirnameUri(uri: vscode.Uri): vscode.Uri {
  const trimmedPath = uri.path.replace(/\/+$/u, "");
  const separatorIndex = trimmedPath.lastIndexOf("/");
  const parentPath = separatorIndex <= 0 ? "/" : trimmedPath.slice(0, separatorIndex);
  return uri.with({ path: parentPath });
}

export async function pathExists(uri: vscode.Uri | null): Promise<boolean> {
  if (!uri) {
    return false;
  }

  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(uri: vscode.Uri | null): Promise<string | null> {
  if (!uri) {
    return null;
  }

  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

export async function readJsonFile<T>(uri: vscode.Uri | null): Promise<T | null> {
  const raw = await readTextFile(uri);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeTextFile(
  uri: vscode.Uri,
  content: string
): Promise<void> {
  await vscode.workspace.fs.createDirectory(dirnameUri(uri));
  await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
}

export async function appendTextFile(
  uri: vscode.Uri,
  content: string
): Promise<void> {
  const existing = await readTextFile(uri);
  await writeTextFile(uri, `${existing ?? ""}${content}`);
}

export async function listFilesRecursive(rootUri: vscode.Uri | null): Promise<string[]> {
  if (!rootUri || !(await pathExists(rootUri))) {
    return [];
  }

  const results: string[] = [];

  async function walk(currentUri: vscode.Uri, prefix: string): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(currentUri);
    entries.sort(([left], [right]) => left.localeCompare(right));

    for (const [name, type] of entries) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const nextUri = vscode.Uri.joinPath(currentUri, name);

      if ((type & vscode.FileType.Directory) !== 0) {
        await walk(nextUri, relativePath);
        continue;
      }

      results.push(relativePath);
    }
  }

  await walk(rootUri, "");
  return results;
}