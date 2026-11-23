import type { HookSource } from "@nodex/codex-app-server-protocol/v2/HookSource";

/** Settings › Plugins › Hooks. */
export const CODEX_HOOKS_SETTINGS_PATH = "/settings/plugins-settings/hooks";
export const CODEX_HOOKS_UNKNOWN_PLUGIN_ID = "__unknown__";

/** Whether a Settings path shows the Hooks tab. */
export function isCodexHooksSettingsPath(path: string): boolean {
  const pathname = path.split(/[?#]/u, 1)[0] ?? "";
  return pathname === CODEX_HOOKS_SETTINGS_PATH;
}

export type CodexHooksSettingsSource =
  | "plugin"
  | "user"
  | "admin"
  | "project"
  | "sessionFlags"
  | "unknown";

export type CodexHooksSettingsSelection =
  | { source: "plugin"; pluginId?: string | null }
  | { source: "user" | "admin" | "sessionFlags" | "unknown" }
  | { source: "project"; projectRoot: string };

export interface CodexHooksSettingsTarget {
  hostId: string;
  selection: CodexHooksSettingsSelection | null;
}

const CODEX_HOOKS_SETTINGS_SOURCES = new Set<CodexHooksSettingsSource>([
  "plugin",
  "user",
  "admin",
  "project",
  "sessionFlags",
  "unknown",
]);

export function normalizeCodexHooksSettingsSource(source: HookSource): CodexHooksSettingsSource {
  switch (source) {
    case "plugin":
      return "plugin";
    case "user":
      return "user";
    case "system":
    case "mdm":
    case "cloudRequirements":
    case "cloudManagedConfig":
    case "legacyManagedConfigFile":
    case "legacyManagedConfigMdm":
      return "admin";
    case "project":
      return "project";
    case "sessionFlags":
      return "sessionFlags";
    case "unknown":
      return "unknown";
  }
}

export function resolveCommonCodexHooksSettingsSource(
  sources: readonly HookSource[],
): CodexHooksSettingsSource | null {
  if (sources.length === 0) return null;

  const normalizedSources = new Set(sources.map(normalizeCodexHooksSettingsSource));
  if (normalizedSources.size !== 1) return null;

  return normalizedSources.values().next().value ?? null;
}

export function resolveHookFeedbackSettingsTarget(input: {
  hostId: string;
  cwd: string | null | undefined;
  sources: readonly HookSource[] | undefined;
}): CodexHooksSettingsTarget {
  const source = resolveCommonCodexHooksSettingsSource(input.sources ?? []);
  if (source === "project") {
    return input.cwd == null
      ? { hostId: input.hostId, selection: null }
      : {
          hostId: input.hostId,
          selection: { source: "project", projectRoot: input.cwd },
        };
  }

  return {
    hostId: input.hostId,
    selection: source == null ? null : { source },
  };
}

function appendCodexHooksSettingsSelection(
  query: URLSearchParams,
  selection: CodexHooksSettingsSelection | null,
): void {
  if (!selection) return;

  query.set("source", selection.source);
  if (selection.source === "project") {
    query.set("projectRoot", selection.projectRoot);
    return;
  }

  if (selection.source !== "plugin" || selection.pluginId === undefined) return;
  query.set("pluginId", selection.pluginId ?? CODEX_HOOKS_UNKNOWN_PLUGIN_ID);
}

export function buildCodexHooksSettingsPath(target: CodexHooksSettingsTarget): string {
  const query = new URLSearchParams();
  query.set("hostId", target.hostId);
  appendCodexHooksSettingsSelection(query, target.selection);
  const suffix = query.toString();
  return suffix ? `${CODEX_HOOKS_SETTINGS_PATH}?${suffix}` : CODEX_HOOKS_SETTINGS_PATH;
}

function readSettingsQuery(path: string): URLSearchParams {
  const queryIndex = path.indexOf("?");
  if (queryIndex < 0) return new URLSearchParams();

  const hashIndex = path.indexOf("#", queryIndex);
  return new URLSearchParams(path.slice(queryIndex + 1, hashIndex < 0 ? undefined : hashIndex));
}

function isCodexHooksSettingsSource(value: string | null): value is CodexHooksSettingsSource {
  return value != null && CODEX_HOOKS_SETTINGS_SOURCES.has(value as CodexHooksSettingsSource);
}

export function parseCodexHooksSettingsHostId(path: string): string | null {
  return readSettingsQuery(path).get("hostId");
}

export function parseCodexHooksSettingsSelection(
  path: string,
  projectRoots: readonly string[],
): CodexHooksSettingsSelection | null {
  const query = readSettingsQuery(path);
  const source = query.get("source");
  const projectRoot = query.get("projectRoot");
  const knownProjectRoots = new Set(projectRoots);

  if (source == null && projectRoot != null) {
    return knownProjectRoots.has(projectRoot) ? { source: "project", projectRoot } : null;
  }

  if (!isCodexHooksSettingsSource(source)) return null;
  if (source === "project") {
    return projectRoot != null && knownProjectRoots.has(projectRoot)
      ? { source: "project", projectRoot }
      : null;
  }

  if (source === "plugin") {
    const pluginId = query.get("pluginId");
    if (pluginId == null) return { source: "plugin" };
    return {
      source: "plugin",
      pluginId: pluginId === CODEX_HOOKS_UNKNOWN_PLUGIN_ID ? null : pluginId,
    };
  }

  return { source };
}

export function replaceCodexHooksSettingsSelection(
  path: string,
  target: CodexHooksSettingsTarget,
): string {
  const query = readSettingsQuery(path);
  query.delete("hostId");
  query.delete("pluginId");
  query.delete("projectRoot");
  query.delete("source");
  if (!target.selection) {
    const suffix = query.toString();
    return suffix ? `${CODEX_HOOKS_SETTINGS_PATH}?${suffix}` : CODEX_HOOKS_SETTINGS_PATH;
  }

  query.set("hostId", target.hostId);
  appendCodexHooksSettingsSelection(query, target.selection);
  const suffix = query.toString();
  return suffix ? `${CODEX_HOOKS_SETTINGS_PATH}?${suffix}` : CODEX_HOOKS_SETTINGS_PATH;
}
