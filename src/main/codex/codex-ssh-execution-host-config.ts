import path from "node:path";
import type { CodexSshExecutionHostConfig } from "../../shared/types";

// Settings load before the first window, so validating a host must not load its SSH transport.

function safeCommand(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /[\r\n\0]/u.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  if (path.posix.isAbsolute(trimmed)) return trimmed;
  if (!/^[A-Za-z0-9._+-]{1,256}$/u.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

export function absoluteRemotePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    !path.posix.isAbsolute(trimmed) ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n")
  ) {
    throw new Error(`${label} must be an absolute POSIX path`);
  }
  return path.posix.normalize(trimmed);
}

export function normalizeCodexSshExecutionHostConfig(
  input: CodexSshExecutionHostConfig,
): CodexSshExecutionHostConfig {
  const id = input.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) || id === "local") {
    throw new Error("SSH execution host id is invalid or reserved");
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 200)
    throw new Error("SSH execution host display name is required");
  const sshAlias = input.sshAlias.trim();
  if (
    !sshAlias ||
    sshAlias.startsWith("-") ||
    sshAlias.length > 512 ||
    !/^[A-Za-z0-9_.:@\[\]-]+$/u.test(sshAlias)
  ) {
    throw new Error("SSH alias is invalid");
  }
  if (
    input.port !== null &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
  ) {
    throw new Error("SSH port must be between 1 and 65535");
  }
  const repositoryRoots = input.repositoryRoots.map((root) =>
    absoluteRemotePath(root, "Repository root"),
  );
  if (repositoryRoots.length === 0)
    throw new Error("SSH execution host requires at least one repository root");
  if (new Set(repositoryRoots).size !== repositoryRoots.length) {
    throw new Error("SSH execution host repository roots must be unique");
  }
  return {
    id,
    displayName,
    kind: "ssh",
    sshAlias,
    port: input.port,
    managedRoot: absoluteRemotePath(input.managedRoot, "Managed worktree root"),
    repositoryRoots: [...repositoryRoots],
    codexBinary: input.codexBinary === null ? null : safeCommand(input.codexBinary, "Codex binary"),
    codexHome: input.codexHome === null ? null : absoluteRemotePath(input.codexHome, "Codex home"),
    enabled: input.enabled,
  };
}
