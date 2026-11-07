export const LOCAL_ENVIRONMENT_SELECTIONS_STORAGE_KEY = "local-env-selections-by-workspace";

export type LocalEnvironmentSelectionsByWorkspace = Record<string, string | null>;

export interface LocalEnvironmentConfigCandidate {
  readonly configPath: string;
  readonly state: "success" | "parseError" | "readError" | "tooLarge";
}

export type LocalEnvironmentCandidateSource =
  | {
      readonly status: "loaded";
      readonly candidates: readonly LocalEnvironmentConfigCandidate[];
    }
  | {
      readonly status: "unresolved";
      readonly reason: "loading" | "load-error" | "candidates-unavailable";
      readonly error: unknown | null;
    };

interface LocalEnvironmentSelectionResolutionBase {
  readonly workspaceKey: string | null;
  readonly storedConfigPath: string | null | undefined;
  readonly defaultConfigPath: string | null;
}

export type LocalEnvironmentSelectionResolution =
  | (LocalEnvironmentSelectionResolutionBase & {
      readonly status: "selected";
      readonly source: "default" | "saved";
      readonly resolvedConfigPath: string;
      readonly repairConfigPath: null;
    })
  | (LocalEnvironmentSelectionResolutionBase & {
      readonly status: "without-environment";
      readonly source: "default" | "saved";
      readonly resolvedConfigPath: null;
      readonly repairConfigPath: null;
    })
  | (LocalEnvironmentSelectionResolutionBase & {
      readonly status: "needs-attention";
      readonly issue: "missing" | "parseError" | "readError" | "tooLarge";
      readonly resolvedConfigPath: null;
      readonly repairConfigPath: string;
    })
  | (LocalEnvironmentSelectionResolutionBase & {
      readonly status: "unresolved";
      readonly reason:
        | "workspace-unavailable"
        | "ambiguous-saved-selection"
        | "loading"
        | "load-error"
        | "candidates-unavailable";
      readonly error: unknown | null;
      readonly resolvedConfigPath: null;
      readonly repairConfigPath: null;
    });

function normalizePath(value: string): string {
  const withoutExtendedPrefix = value
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, "");
  const slashNormalized = withoutExtendedPrefix.replaceAll("\\", "/");
  const normalized = slashNormalized.startsWith("//")
    ? `//${slashNormalized.slice(2).replace(/\/{2,}/g, "/")}`
    : slashNormalized.replace(/\/{2,}/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function windowsComparablePath(value: string): {
  comparablePath: string;
  explicit: boolean;
} | null {
  const normalized = normalizePath(value);
  const wslUncMatch = normalized.match(/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(?:\/(.*))?$/i);
  if (wslUncMatch) {
    const innerPath = `/${wslUncMatch[2] ?? ""}`;
    if (!/^\/mnt\/[a-z](?:\/|$)/i.test(innerPath)) return null;
    return {
      comparablePath: innerPath.toLowerCase(),
      explicit: true,
    };
  }

  const driveMatch = normalized.match(/^\/?([a-z]):(?:\/(.*))?$/i);
  if (driveMatch) {
    const [, drive, tail] = driveMatch;
    return {
      comparablePath: `/mnt/${drive?.toLowerCase()}${tail ? `/${tail.toLowerCase()}` : ""}`,
      explicit: true,
    };
  }

  if (!/^\/mnt\/[a-z](?:\/|$)/i.test(normalized)) return null;
  return {
    comparablePath: normalized.toLowerCase(),
    explicit: false,
  };
}

export function areLocalEnvironmentPathsEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (normalizedLeft === normalizedRight) return true;

  const comparableLeft = windowsComparablePath(normalizedLeft);
  const comparableRight = windowsComparablePath(normalizedRight);
  return Boolean(
    comparableLeft &&
    comparableRight &&
    (comparableLeft.explicit || comparableRight.explicit) &&
    comparableLeft.comparablePath === comparableRight.comparablePath,
  );
}

function fileName(path: string): string {
  const normalized = normalizePath(path);
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function resolveDefaultConfigPath(
  candidates: readonly LocalEnvironmentConfigCandidate[],
): string | null {
  const preferred = candidates.find(
    (candidate) =>
      fileName(candidate.configPath) === "environment.toml" && candidate.state === "success",
  );
  const successful = candidates.find((candidate) => candidate.state === "success");
  return preferred?.configPath ?? successful?.configPath ?? candidates[0]?.configPath ?? null;
}

export function resolveLocalEnvironmentSelection({
  candidateSource,
  hostId = "local",
  selectionsByWorkspace,
  workspaceRoot,
}: {
  candidateSource: LocalEnvironmentCandidateSource;
  hostId?: string;
  selectionsByWorkspace: Readonly<LocalEnvironmentSelectionsByWorkspace>;
  workspaceRoot: string | null | undefined;
}): LocalEnvironmentSelectionResolution {
  const workspaceKey = localEnvironmentWorkspaceKey(workspaceRoot, hostId);
  if (!workspaceKey) {
    return {
      status: "unresolved",
      reason: "workspace-unavailable",
      error: null,
      workspaceKey,
      storedConfigPath: undefined,
      defaultConfigPath: null,
      resolvedConfigPath: null,
      repairConfigPath: null,
    };
  }

  const storedSelection = resolveStoredLocalEnvironmentSelectionResult({
    hostId,
    selectionsByWorkspace,
    workspaceKey,
  });
  const storedConfigPath =
    storedSelection.status === "selected" ? storedSelection.configPath : undefined;
  if (candidateSource.status === "unresolved") {
    return {
      status: "unresolved",
      reason: candidateSource.reason,
      error: candidateSource.error,
      workspaceKey,
      storedConfigPath,
      defaultConfigPath: null,
      resolvedConfigPath: null,
      repairConfigPath: null,
    };
  }
  if (storedSelection.status === "ambiguous") {
    return {
      status: "unresolved",
      reason: "ambiguous-saved-selection",
      error: null,
      workspaceKey,
      storedConfigPath,
      defaultConfigPath: resolveDefaultConfigPath(candidateSource.candidates),
      resolvedConfigPath: null,
      repairConfigPath: null,
    };
  }

  const defaultConfigPath = resolveDefaultConfigPath(candidateSource.candidates);
  if (storedConfigPath === undefined) {
    const defaultCandidate = candidateSource.candidates.find(
      (candidate) => candidate.configPath === defaultConfigPath,
    );
    if (!defaultCandidate) {
      return {
        status: "without-environment",
        source: "default",
        workspaceKey,
        storedConfigPath,
        defaultConfigPath,
        resolvedConfigPath: null,
        repairConfigPath: null,
      };
    }
    if (defaultCandidate.state !== "success") {
      return {
        status: "needs-attention",
        issue: defaultCandidate.state,
        workspaceKey,
        storedConfigPath,
        defaultConfigPath,
        resolvedConfigPath: null,
        repairConfigPath: defaultCandidate.configPath,
      };
    }
    return {
      status: "selected",
      source: "default",
      workspaceKey,
      storedConfigPath,
      defaultConfigPath,
      resolvedConfigPath: defaultCandidate.configPath,
      repairConfigPath: null,
    };
  }

  if (storedConfigPath === null) {
    return {
      status: "without-environment",
      source: "saved",
      workspaceKey,
      storedConfigPath,
      defaultConfigPath,
      resolvedConfigPath: null,
      repairConfigPath: null,
    };
  }

  const matchingCandidate = candidateSource.candidates.find((candidate) =>
    areLocalEnvironmentPathsEquivalent(candidate.configPath, storedConfigPath),
  );
  if (matchingCandidate?.state === "success") {
    return {
      status: "selected",
      source: "saved",
      workspaceKey,
      storedConfigPath,
      defaultConfigPath,
      resolvedConfigPath: matchingCandidate.configPath,
      repairConfigPath: null,
    };
  }
  if (!matchingCandidate) {
    return {
      status: "needs-attention",
      issue: "missing",
      workspaceKey,
      storedConfigPath,
      defaultConfigPath,
      resolvedConfigPath: null,
      repairConfigPath: storedConfigPath,
    };
  }
  return {
    status: "needs-attention",
    issue: matchingCandidate.state,
    workspaceKey,
    storedConfigPath,
    defaultConfigPath,
    resolvedConfigPath: null,
    repairConfigPath: matchingCandidate.configPath,
  };
}

export function localEnvironmentWorkspaceKey(
  workspaceRoot: string | null | undefined,
  hostId = "local",
): string | null {
  if (!workspaceRoot) return null;
  const normalizedWorkspaceRoot = normalizePath(workspaceRoot);
  if (!normalizedWorkspaceRoot || normalizedWorkspaceRoot === "/") return null;
  return `${hostId}:${normalizedWorkspaceRoot}`;
}

export function readLocalEnvironmentSelections(): LocalEnvironmentSelectionsByWorkspace {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LOCAL_ENVIRONMENT_SELECTIONS_STORAGE_KEY) ?? "{}",
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const selections: LocalEnvironmentSelectionsByWorkspace = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || typeof value === "string") selections[key] = value;
    }
    return selections;
  } catch {
    return {};
  }
}

export function writeLocalEnvironmentSelection({
  workspaceRoot,
  configPath,
  hostId = "local",
}: {
  workspaceRoot: string;
  configPath: string | null;
  hostId?: string;
}): void {
  if (typeof window === "undefined") return;
  const workspaceKey = localEnvironmentWorkspaceKey(workspaceRoot, hostId);
  if (!workspaceKey) return;
  const selections = readLocalEnvironmentSelections();
  selections[workspaceKey] = configPath;
  window.localStorage.setItem(LOCAL_ENVIRONMENT_SELECTIONS_STORAGE_KEY, JSON.stringify(selections));
}

export function resolveStoredLocalEnvironmentSelection({
  hostId = "local",
  selectionsByWorkspace,
  workspaceKey,
}: {
  hostId?: string;
  selectionsByWorkspace: Readonly<LocalEnvironmentSelectionsByWorkspace>;
  workspaceKey: string | null;
}): string | null | undefined {
  const result = resolveStoredLocalEnvironmentSelectionResult({
    hostId,
    selectionsByWorkspace,
    workspaceKey,
  });
  return result.status === "selected" ? result.configPath : undefined;
}

type StoredLocalEnvironmentSelectionResult =
  | { readonly status: "absent" }
  | { readonly status: "ambiguous" }
  | { readonly status: "selected"; readonly configPath: string | null };

function resolveStoredLocalEnvironmentSelectionResult({
  hostId = "local",
  selectionsByWorkspace,
  workspaceKey,
}: {
  hostId?: string;
  selectionsByWorkspace: Readonly<LocalEnvironmentSelectionsByWorkspace>;
  workspaceKey: string | null;
}): StoredLocalEnvironmentSelectionResult {
  if (workspaceKey === null) return { status: "absent" };
  if (Object.prototype.hasOwnProperty.call(selectionsByWorkspace, workspaceKey)) {
    return {
      status: "selected",
      configPath: selectionsByWorkspace[workspaceKey] ?? null,
    };
  }

  const hostPrefix = `${hostId}:`;
  const workspacePath = workspaceKey.slice(hostPrefix.length);
  let resolved: string | null | undefined;
  for (const [candidateKey, candidateValue] of Object.entries(selectionsByWorkspace)) {
    if (!candidateKey.startsWith(hostPrefix)) continue;
    if (!areLocalEnvironmentPathsEquivalent(candidateKey.slice(hostPrefix.length), workspacePath))
      continue;

    const normalizedCandidateValue = candidateValue ?? null;
    if (resolved === undefined) {
      resolved = normalizedCandidateValue;
      continue;
    }
    if (resolved === null || normalizedCandidateValue === null) {
      if (resolved !== normalizedCandidateValue) return { status: "ambiguous" };
      continue;
    }
    if (!areLocalEnvironmentPathsEquivalent(resolved, normalizedCandidateValue)) {
      return { status: "ambiguous" };
    }
  }
  return resolved === undefined
    ? { status: "absent" }
    : { status: "selected", configPath: resolved };
}

export function resolveLocalEnvironmentConfigSelection({
  canValidateSelection,
  candidates,
  hostId = "local",
  selectionsByWorkspace,
  workspaceRoot,
}: {
  canValidateSelection: boolean;
  candidates: readonly LocalEnvironmentConfigCandidate[];
  hostId?: string;
  selectionsByWorkspace: Readonly<LocalEnvironmentSelectionsByWorkspace>;
  workspaceRoot: string | null | undefined;
}): string | null {
  return projectLegacyLocalEnvironmentConfigPath(
    resolveLocalEnvironmentSelection({
      candidateSource: canValidateSelection
        ? { status: "loaded", candidates }
        : {
            status: "unresolved",
            reason: "candidates-unavailable",
            error: null,
          },
      hostId,
      selectionsByWorkspace,
      workspaceRoot,
    }),
  );
}

/** Compatibility projection until all UI call sites render attention/error states. */
function projectLegacyLocalEnvironmentConfigPath(
  resolution: LocalEnvironmentSelectionResolution,
): string | null {
  if (resolution.status === "selected") return resolution.resolvedConfigPath;
  if (resolution.status !== "unresolved") return null;
  if (
    resolution.reason !== "loading" &&
    resolution.reason !== "load-error" &&
    resolution.reason !== "candidates-unavailable"
  ) {
    return null;
  }
  return resolution.storedConfigPath ?? null;
}

export async function loadLocalEnvironmentSelection({
  hostId = "local",
  loadCandidates,
  selectionsByWorkspace,
  workspaceRoot,
}: {
  hostId?: string;
  loadCandidates: (workspaceRoot: string) => Promise<readonly LocalEnvironmentConfigCandidate[]>;
  selectionsByWorkspace: Readonly<LocalEnvironmentSelectionsByWorkspace>;
  workspaceRoot: string | null | undefined;
}): Promise<LocalEnvironmentSelectionResolution> {
  if (!workspaceRoot) {
    return resolveLocalEnvironmentSelection({
      candidateSource: {
        status: "unresolved",
        reason: "candidates-unavailable",
        error: null,
      },
      hostId,
      selectionsByWorkspace,
      workspaceRoot,
    });
  }

  try {
    const candidates = await loadCandidates(workspaceRoot);
    return resolveLocalEnvironmentSelection({
      candidateSource: { status: "loaded", candidates },
      hostId,
      selectionsByWorkspace,
      workspaceRoot,
    });
  } catch (error) {
    return resolveLocalEnvironmentSelection({
      candidateSource: { status: "unresolved", reason: "load-error", error },
      hostId,
      selectionsByWorkspace,
      workspaceRoot,
    });
  }
}

export async function loadLocalEnvironmentConfigSelection({
  hostId = "local",
  loadCandidates,
  selectionsByWorkspace,
  workspaceRoot,
}: {
  hostId?: string;
  loadCandidates: (workspaceRoot: string) => Promise<readonly LocalEnvironmentConfigCandidate[]>;
  selectionsByWorkspace: Readonly<LocalEnvironmentSelectionsByWorkspace>;
  workspaceRoot: string | null | undefined;
}): Promise<string | null> {
  return projectLegacyLocalEnvironmentConfigPath(
    await loadLocalEnvironmentSelection({
      hostId,
      loadCandidates,
      selectionsByWorkspace,
      workspaceRoot,
    }),
  );
}
