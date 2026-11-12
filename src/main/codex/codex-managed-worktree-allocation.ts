import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as path from "node:path";

const CHAT_ALLOCATION_LENGTH = 4;
const CHECKPOINTED_ALLOCATION_LENGTH = 12;

const ALLOCATION_ID_PATTERN = /^(?:[0-9a-f]{4}|[0-9a-f]{12})$/iu;
const SUPERSEDED_FLAT_WORKTREE_PATTERN = /^\d{6}-\d{4}-[0-9a-f]{8}$/iu;

function executionPath(value: string): typeof path.posix {
  return path.posix.isAbsolute(value) || !path.win32.isAbsolute(value) ? path.posix : path.win32;
}

export function isManagedWorktreeAllocationId(name: string): boolean {
  return ALLOCATION_ID_PATTERN.test(name);
}

export function isSupersededFlatWorktreeDirectory(name: string): boolean {
  return SUPERSEDED_FLAT_WORKTREE_PATTERN.test(name);
}

function managedWorktreePath(managedRoot: string, repositoryRoot: string, id: string): string {
  return executionPath(managedRoot).join(
    managedRoot,
    id,
    executionPath(repositoryRoot).basename(repositoryRoot),
  );
}

/** Chooses a candidate while the worker can retry an occupied checkout path. */
export function allocateChatWorktreePath(managedRoot: string, repositoryRoot: string): string {
  return managedWorktreePath(
    managedRoot,
    repositoryRoot,
    randomUUID().slice(0, CHAT_ALLOCATION_LENGTH),
  );
}

/** Chooses an allocation that is checkpointed before the worker creates the checkout. */
export function allocateHandoffWorktreePath(managedRoot: string, repositoryRoot: string): string {
  const id = randomBytes(CHECKPOINTED_ALLOCATION_LENGTH / 2).toString("hex");
  return managedWorktreePath(managedRoot, repositoryRoot, id);
}

export function pageWorkspaceIdentity(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

export function pageWorkspaceWorktreePath(
  managedRoot: string,
  repositoryRoot: string,
  workspaceId: string,
): string {
  return managedWorktreePath(
    managedRoot,
    repositoryRoot,
    pageWorkspaceIdentity(workspaceId).slice(0, CHECKPOINTED_ALLOCATION_LENGTH),
  );
}

function relativePathParts(managedRoot: string, location: string): string[] {
  const paths = executionPath(managedRoot);
  const relative = paths.relative(managedRoot, location);
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`)) return [];
  if (paths.isAbsolute(relative)) return [];
  return relative.split(paths.sep);
}

/** The managed checkout that contains a working directory, including one that was removed. */
export function managedWorktreeGitRootContaining(
  managedRoot: string,
  location: string,
): string | null {
  const [first, second] = relativePathParts(managedRoot, location);
  if (!first) return null;
  const { join } = executionPath(managedRoot);
  if (isSupersededFlatWorktreeDirectory(first)) return join(managedRoot, first);
  if (second && isManagedWorktreeAllocationId(first)) return join(managedRoot, first, second);
  return null;
}
