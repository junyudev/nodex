import { isAbsolute, join, resolve } from "node:path";
import type { CodexHomeSettings } from "../../shared/types";

/** Resolve one native home for configuration, authentication, history and runtime identity. */
export function resolveCodexHome(input: {
  readonly configuredHome?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): CodexHomeSettings {
  const homePath = input.configuredHome?.trim() ?? "";
  const inherited = input.environment.CODEX_HOME?.trim() ?? "";
  const source = homePath ? "settings" : inherited ? "environment" : "default";
  const selected = homePath || inherited || join(input.homeDirectory, ".codex");
  const expanded =
    selected === "~"
      ? input.homeDirectory
      : selected.startsWith("~/") || selected.startsWith("~\\")
        ? join(input.homeDirectory, selected.slice(2))
        : selected;
  if (!isAbsolute(expanded))
    throw new Error("Codex home must be an absolute path or start with ~/.");
  return { homePath, resolvedHomePath: resolve(expanded), source };
}
