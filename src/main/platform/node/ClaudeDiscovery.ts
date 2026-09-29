// @effect-diagnostics asyncFunction:off
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { claudeNativeHome } from "./ClaudeExecutable";
import * as Effect from "effect/Effect";
import type { ClaudeDiscoveredSkill } from "../../../shared/claude-models";
import type { ClaudeAgentInstanceConfig } from "../../../shared/claude-agent-settings";

/** Cache identity includes secret changes but never publishes their values. */
export const claudeDiscoveryFingerprint = (
  instance: ClaudeAgentInstanceConfig,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        instance,
        environment: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
        cwd: resolve(cwd),
      }),
    )
    .digest("hex");
const bool = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value !== "string") return undefined;
  if (["true", "yes", "on", "y"].includes(value.toLowerCase())) return true;
  if (["false", "no", "off", "n"].includes(value.toLowerCase())) return false;
  return undefined;
};
export const parseClaudeSkillFrontmatter = (
  contents: string,
): { readonly description: string; readonly userInvocable: boolean } | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents);
  if (!match) return { description: "", userInvocable: true };
  try {
    const parsed = load(match[1]!, { json: false });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const fields = parsed as Record<string, unknown>;
    return {
      description:
        typeof fields.description === "string" ? fields.description.trim().slice(0, 8192) : "",
      userInvocable: bool(fields["user-invocable"]) !== false,
    };
  } catch {
    return null;
  }
};
/** Native init commands decide invocation availability; filesystem scans contribute paths and labels. */
export const discoverClaudeSkills = (
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  commands: readonly { readonly name: string }[],
  overrides: Readonly<Record<string, "on" | "name-only" | "user-invocable-only" | "off">> = {},
) =>
  Effect.promise(async () => {
    const home = claudeNativeHome(environment);
    const root = environment.CLAUDE_CONFIG_DIR ?? (home ? join(home, ".claude") : undefined);
    const skills = new Map<string, ClaudeDiscoveredSkill>();
    const advertised = new Set(commands.map(({ name }) => name.replace(/^\//u, "")));
    for (const directory of [
      ...(root ? [join(root, "skills")] : []),
      join(cwd, ".claude", "skills"),
    ]) {
      const entries = await readdir(directory).catch(() => []);
      for (const entry of entries.toSorted((a, b) => a.localeCompare(b))) {
        if (skills.has(entry)) continue;
        const path = join(directory, entry, "SKILL.md");
        const size = await stat(path).catch(() => null);
        if (!size?.isFile() || size.size > 256 * 1024) continue;
        const contents = await readFile(path, "utf8").catch(() => null);
        if (contents === null) continue;
        const meta = parseClaudeSkillFrontmatter(contents);
        if (!meta) continue;
        skills.set(entry, {
          name: entry,
          path,
          description: overrides[entry] === "name-only" ? "" : meta.description,
          enabled: overrides[entry] !== "off",
          userInvocable: meta.userInvocable && overrides[entry] !== "off" && advertised.has(entry),
        });
      }
    }
    return [...skills.values()];
  });
/** Readiness is initialization plus version compatibility, never a paid authentication probe. */
export const probeClaudeVersion = (
  executable: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Effect.Effect<string | null> => {
  if (!executable) return Effect.succeed(null);
  return Effect.callback<string | null>((resume) => {
    const js = /\.[cm]?js$/u.test(executable);
    const child = execFile(
      js ? process.execPath : executable,
      js ? [executable, "--version"] : ["--version"],
      {
        cwd,
        env: { ...environment, ...(js ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
        timeout: 5000,
        maxBuffer: 8192,
        windowsHide: true,
      },
      (error, stdout) => resume(Effect.succeed(error ? null : stdout.trim().slice(0, 256))),
    );
    return Effect.sync(() => {
      child.kill();
    });
  });
};
