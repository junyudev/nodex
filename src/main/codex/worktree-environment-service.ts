import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { WorktreeEnvironmentOption } from "../../shared/types";

interface WorktreeEnvironmentToml {
  name?: unknown;
  setup?: {
    script?: unknown;
  };
}

export interface WorktreeEnvironmentDefinition {
  path: string;
  name: string;
  setupScript: string | null;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveEnvironmentRoot(workspacePath: string): string {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) {
    throw new Error("Workspace path is required");
  }
  return path.resolve(normalizedWorkspacePath, ".codex", "environments");
}

function isPathWithin(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseEnvironmentToml(raw: string): WorktreeEnvironmentToml | null {
  try {
    const parsed = parseToml(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as WorktreeEnvironmentToml;
  } catch {
    return null;
  }
}

function resolveEnvironmentName(
  parsed: WorktreeEnvironmentToml | null,
  absolutePath: string,
): string {
  const fromToml = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  if (fromToml.length > 0) return fromToml;
  return path.basename(absolutePath, ".toml");
}

function resolveSetupScript(parsed: WorktreeEnvironmentToml | null): string | null {
  const script = parsed?.setup?.script;
  if (typeof script !== "string") return null;
  const normalized = script.trim();
  return normalized.length > 0 ? script : null;
}

export async function listWorktreeEnvironmentOptions(
  workspacePath: string,
): Promise<WorktreeEnvironmentOption[]> {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) return [];
  const resolvedWorkspacePath = path.resolve(normalizedWorkspacePath);

  const environmentRoot = resolveEnvironmentRoot(resolvedWorkspacePath);
  const rootStat = await stat(environmentRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return [];

  const entries = await readdir(environmentRoot, { withFileTypes: true }).catch(() => []);
  const options: WorktreeEnvironmentOption[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== ".toml") continue;

    const absolutePath = path.resolve(environmentRoot, entry.name);
    const raw = await readFile(absolutePath, "utf8").catch(() => null);
    if (!raw) continue;

    const parsed = parseEnvironmentToml(raw);
    if (!parsed) continue;

    const relativePath = path.relative(resolvedWorkspacePath, absolutePath);
    options.push({
      path: toPosixPath(relativePath),
      name: resolveEnvironmentName(parsed, absolutePath),
      hasSetupScript: resolveSetupScript(parsed) !== null,
    });
  }

  return options;
}

export async function readWorktreeEnvironmentDefinition(input: {
  workspacePath: string;
  environmentPath: string;
}): Promise<WorktreeEnvironmentDefinition> {
  const normalizedWorkspacePath = input.workspacePath.trim();
  if (!normalizedWorkspacePath) {
    throw new Error("Workspace path is required");
  }
  const resolvedWorkspacePath = path.resolve(normalizedWorkspacePath);

  const normalizedEnvironmentPath = input.environmentPath.trim();
  if (!normalizedEnvironmentPath) {
    throw new Error("Environment path is required");
  }
  if (path.isAbsolute(normalizedEnvironmentPath)) {
    throw new Error("Environment path must be relative to workspace");
  }
  if (path.extname(normalizedEnvironmentPath).toLowerCase() !== ".toml") {
    throw new Error("Environment path must point to a .toml file");
  }

  const environmentRoot = resolveEnvironmentRoot(resolvedWorkspacePath);
  const resolvedPath = path.resolve(resolvedWorkspacePath, normalizedEnvironmentPath);
  if (!isPathWithin(environmentRoot, resolvedPath)) {
    throw new Error("Environment path must be inside .codex/environments");
  }

  const [resolvedEnvironmentRootPath, resolvedEnvironmentFilePath] = await Promise.all([
    realpath(environmentRoot).catch(() => null),
    realpath(resolvedPath).catch(() => null),
  ]);

  if (!resolvedEnvironmentRootPath) {
    throw new Error("Environment directory not found: .codex/environments");
  }
  if (!resolvedEnvironmentFilePath) {
    throw new Error(`Environment file not found: ${normalizedEnvironmentPath}`);
  }
  if (!isPathWithin(resolvedEnvironmentRootPath, resolvedEnvironmentFilePath)) {
    throw new Error("Environment path must be inside .codex/environments");
  }

  const fileStat = await stat(resolvedEnvironmentFilePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`Environment file not found: ${normalizedEnvironmentPath}`);
  }

  const raw = await readFile(resolvedEnvironmentFilePath, "utf8");
  const parsed = parseEnvironmentToml(raw);
  if (!parsed) {
    throw new Error(`Could not parse environment file: ${normalizedEnvironmentPath}`);
  }

  return {
    path: toPosixPath(path.relative(resolvedWorkspacePath, resolvedPath)),
    name: resolveEnvironmentName(parsed, resolvedPath),
    setupScript: resolveSetupScript(parsed),
  };
}
