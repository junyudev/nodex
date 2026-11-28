/* @effect-diagnostics asyncFunction:off -- Node filesystem adapter. */
import { constants } from "node:fs";
import { access, chmod, lstat } from "node:fs/promises";
import path from "node:path";
import type { AppComponentPayload } from "../../app-components/AppComponentCatalog";
import { inventoryRegularFiles, sha256File } from "./pinned-tar-archive";

type ClaudeCodePayload = Extract<AppComponentPayload, { kind: "claude-code" }>;

export async function verifyClaudeCodeExecutable(
  root: string,
  payload: ClaudeCodePayload,
  signal: AbortSignal,
): Promise<string> {
  const executable = path.join(root, payload.executable.path);
  const stats = await lstat(executable);
  if (
    !(await lstat(root)).isDirectory() ||
    !(await lstat(path.dirname(executable))).isDirectory() ||
    !stats.isFile() ||
    stats.nlink !== 1 ||
    stats.size !== payload.executable.size ||
    (await sha256File(executable, signal)) !== payload.executable.sha256
  ) {
    throw new Error("Claude Code executable does not match its release lock.");
  }
  return executable;
}

export async function stageClaudeCode(
  root: string,
  payload: ClaudeCodePayload,
  signal: AbortSignal,
): Promise<number> {
  const expected = [
    payload.executable.path,
    "package/LICENSE.md",
    "package/README.md",
    "package/package.json",
  ];
  const files = await inventoryRegularFiles(root, signal, expected);
  if (files.size !== expected.length || expected.some((file) => !files.has(file))) {
    throw new Error("Claude Code archive contains unexpected files.");
  }
  const executable = await verifyClaudeCodeExecutable(root, payload, signal);
  if (!payload.executable.path.endsWith(".exe")) await chmod(executable, 0o755);
  return Array.from(files.values()).reduce((total, file) => total + file.size, 0);
}

export async function admitClaudeCode(
  root: string,
  payload: ClaudeCodePayload,
  signal: AbortSignal,
) {
  const executable = await verifyClaudeCodeExecutable(root, payload, signal);
  if (!payload.executable.path.endsWith(".exe")) await access(executable, constants.X_OK);
}
