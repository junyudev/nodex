import { isAbsolute, join, resolve } from "node:path";
import type { CodexHomeSettings } from "../../shared/types";

/** Resolve shared native state independently from an optional account's credentials. */
export function resolveCodexHome(input: {
  readonly configuredHome?: string;
  readonly configuredAccountHome?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): CodexHomeSettings {
  const homePath = input.configuredHome?.trim() ?? "";
  const inherited = input.environment.CODEX_HOME?.trim() ?? "";
  const source = homePath ? "settings" : inherited ? "environment" : "default";
  const selected = homePath || inherited || join(input.homeDirectory, ".codex");
  const expand = (selectedPath: string) =>
    selectedPath === "~"
      ? input.homeDirectory
      : selectedPath.startsWith("~/") || selectedPath.startsWith("~\\")
        ? join(input.homeDirectory, selectedPath.slice(2))
        : selectedPath;
  const absolute = (value: string, label: string) => {
    const expanded = expand(value);
    if (!isAbsolute(expanded))
      throw new Error(`${label} must be an absolute path or start with ~/.`);
    return resolve(expanded);
  };
  const accountHomePath = input.configuredAccountHome?.trim() ?? "";
  return {
    homePath,
    resolvedHomePath: absolute(selected, "Codex home"),
    source,
    accountHomePath,
    resolvedAccountHomePath: accountHomePath
      ? absolute(accountHomePath, "Codex account directory")
      : null,
  };
}
