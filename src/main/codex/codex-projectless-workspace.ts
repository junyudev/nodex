import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CodexProjectlessWorkspace } from "../../shared/types";

export type { CodexProjectlessWorkspace } from "../../shared/types";

const CODEX_PROJECTLESS_NUMERIC_ATTEMPTS = 100;
const CODEX_PROJECTLESS_UNIQUE_ATTEMPTS = 5;

export interface CodexProjectlessWorkspaceFileSystem {
  readonly createDirectory: (input: {
    readonly path: string;
    readonly recursive: boolean;
  }) => Promise<void>;
  readonly getMetadata: (path: string) => Promise<{
    readonly isDirectory: boolean;
    readonly isSymlink: boolean;
  }>;
}

export interface CreateCodexProjectlessWorkspaceInput {
  readonly createSplitDirectories: boolean;
  readonly directoryName?: string | null;
  readonly prompt?: string | null;
  readonly homeDirectory?: string;
  readonly date?: Date;
  readonly fileSystem?: CodexProjectlessWorkspaceFileSystem;
  readonly uniqueDirectoryNameSuffix?: () => string;
}

const nodeProjectlessWorkspaceFileSystem: CodexProjectlessWorkspaceFileSystem = {
  async createDirectory(input) {
    await mkdir(input.path, { recursive: input.recursive });
  },
  async getMetadata(directoryPath) {
    const metadata = await lstat(directoryPath);
    return {
      isDirectory: metadata.isDirectory(),
      isSymlink: metadata.isSymbolicLink(),
    };
  },
};

export function resolveCodexProjectlessWorkspaceRoot(homeDirectory: string = homedir()): string {
  return path.join(homeDirectory, "Documents", "Nodex");
}

export function parseCodexProjectlessWorkspace(input: unknown): CodexProjectlessWorkspace {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Projectless workspace must be an object");
  }

  const candidate = input as Record<string, unknown>;
  for (const key of ["cwd", "outputDirectory", "workspaceRoot"] as const) {
    if (typeof candidate[key] !== "string" || candidate[key].trim().length === 0) {
      throw new Error(`Projectless workspace ${key} must be a non-empty string`);
    }
  }

  return {
    cwd: candidate.cwd as string,
    outputDirectory: candidate.outputDirectory as string,
    workspaceRoot: candidate.workspaceRoot as string,
  };
}

export function formatCodexProjectlessLocalDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function slugCodexProjectlessDirectoryName(
  input:
    | string
    | {
        readonly directoryName?: string | null;
        readonly prompt?: string | null;
      }
    | null,
): string {
  const isOptions = typeof input === "object" && input !== null;
  const directoryName = isOptions ? input.directoryName : null;
  const prompt = isOptions ? input.prompt : input;
  const words = (directoryName ?? prompt)?.toLowerCase().match(/[a-z0-9]+/g);

  if (!words || words.length === 0) return "new-chat";
  const selectedWords =
    directoryName === null || directoryName === undefined ? words.slice(0, 6) : words;
  return selectedWords.join("-").slice(0, 80);
}

async function assertRealDirectory(
  fileSystem: CodexProjectlessWorkspaceFileSystem,
  directoryPath: string,
): Promise<void> {
  const metadata = await fileSystem.getMetadata(directoryPath);
  if (metadata.isDirectory && !metadata.isSymlink) return;
  throw new Error("Projectless thread directory must be a real directory");
}

async function isExistingRealDirectory(
  fileSystem: CodexProjectlessWorkspaceFileSystem,
  directoryPath: string,
): Promise<boolean> {
  try {
    await assertRealDirectory(fileSystem, directoryPath);
    return true;
  } catch {
    return false;
  }
}

async function createCodexProjectlessThreadDirectory(input: {
  readonly createSplitDirectories: boolean;
  readonly dateDirectory: string;
  readonly fileSystem: CodexProjectlessWorkspaceFileSystem;
  readonly threadDirectoryName: string;
  readonly workspaceRoot: string;
}): Promise<CodexProjectlessWorkspace | null> {
  const threadDirectory = path.join(input.dateDirectory, input.threadDirectoryName);
  const outputDirectory = input.createSplitDirectories
    ? path.join(threadDirectory, "outputs")
    : threadDirectory;

  try {
    await input.fileSystem.createDirectory({
      path: threadDirectory,
      recursive: false,
    });
  } catch (error) {
    if (!(await isExistingRealDirectory(input.fileSystem, threadDirectory))) throw error;
    return null;
  }

  if (input.createSplitDirectories) {
    try {
      await Promise.all([
        input.fileSystem.createDirectory({
          path: outputDirectory,
          recursive: false,
        }),
        input.fileSystem.createDirectory({
          path: path.join(threadDirectory, "work"),
          recursive: false,
        }),
      ]);
    } catch {
      return {
        cwd: threadDirectory,
        outputDirectory: threadDirectory,
        workspaceRoot: input.workspaceRoot,
      };
    }
  }

  return {
    cwd: threadDirectory,
    outputDirectory,
    workspaceRoot: input.workspaceRoot,
  };
}

export async function createCodexProjectlessWorkspace(
  input: CreateCodexProjectlessWorkspaceInput,
): Promise<CodexProjectlessWorkspace> {
  const fileSystem = input.fileSystem ?? nodeProjectlessWorkspaceFileSystem;
  const workspaceRoot = resolveCodexProjectlessWorkspaceRoot(input.homeDirectory);
  const dateDirectory = path.join(workspaceRoot, formatCodexProjectlessLocalDate(input.date));
  const directoryName = slugCodexProjectlessDirectoryName({
    directoryName: input.directoryName,
    prompt: input.prompt,
  });

  await fileSystem.createDirectory({ path: workspaceRoot, recursive: true });
  await assertRealDirectory(fileSystem, workspaceRoot);
  await fileSystem.createDirectory({ path: dateDirectory, recursive: true });
  await assertRealDirectory(fileSystem, dateDirectory);

  for (let index = 0; index < CODEX_PROJECTLESS_NUMERIC_ATTEMPTS; index += 1) {
    const threadDirectoryName = index === 0 ? directoryName : `${directoryName}-${index + 1}`;
    const workspace = await createCodexProjectlessThreadDirectory({
      createSplitDirectories: input.createSplitDirectories,
      dateDirectory,
      fileSystem,
      threadDirectoryName,
      workspaceRoot,
    });
    if (workspace) return workspace;
  }

  const uniqueDirectoryNameSuffix = input.uniqueDirectoryNameSuffix ?? randomUUID;
  for (let index = 0; index < CODEX_PROJECTLESS_UNIQUE_ATTEMPTS; index += 1) {
    const workspace = await createCodexProjectlessThreadDirectory({
      createSplitDirectories: input.createSplitDirectories,
      dateDirectory,
      fileSystem,
      threadDirectoryName: `${directoryName}-${uniqueDirectoryNameSuffix()}`,
      workspaceRoot,
    });
    if (workspace) return workspace;
  }

  throw new Error("Unable to create a unique projectless thread directory");
}
