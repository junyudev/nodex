import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { McpProviderDesktopToolSkill } from "@nodex/provider-core/server/mcpSession";
import { parse } from "yaml";

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const readMetadata = async (file: string, decode: (source: string) => unknown) => {
  try {
    return decode(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};

export async function readDesktopToolSkills(pluginRoots: readonly string[]) {
  const byPlugin = await Promise.all(
    pluginRoots.filter(isAbsolute).map(async (root) => {
      try {
        const plugin: { name?: unknown } = JSON.parse(
          await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"),
        );
        if (!nonempty(plugin.name)) return [];
        const manifest = (await readMetadata(
          join(root, ".codex-plugin/plugin.json"),
          JSON.parse,
        )) as
          | {
              interface?: {
                displayName?: unknown;
                composerIcon?: unknown;
                logo?: unknown;
                brandColor?: unknown;
              };
            }
          | undefined;
        const identity = manifest?.interface;
        const icon = identity?.composerIcon ?? identity?.logo;
        const iconPath = nonempty(icon) ? resolve(root, icon) : undefined;
        const skills = join(root, "skills");
        const entries = await readdir(skills, { withFileTypes: true });
        const found = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              try {
                const path = join(skills, entry.name, "SKILL.md");
                const source = await readFile(path, "utf8");
                const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1];
                if (frontmatter === undefined) return undefined;
                const skill: { name?: unknown; description?: unknown } | null = parse(frontmatter);
                if (!nonempty(skill?.name) || !nonempty(skill.description)) return undefined;
                const metadata = (await readMetadata(
                  join(skills, entry.name, "agents/openai.yaml"),
                  parse,
                )) as { interface?: { display_name?: unknown } } | undefined;
                const displayName = metadata?.interface?.display_name ?? identity?.displayName;
                // The skill's own description says what it does for any Agent; the plugin's
                // blurb names one assistant.
                return {
                  ...(nonempty(displayName) ? { displayName } : {}),
                  ...(iconPath ? { iconPath } : {}),
                  ...(nonempty(identity?.brandColor) ? { brandColor: identity.brandColor } : {}),
                  name: `${plugin.name}:${skill.name}`,
                  description: skill.description,
                  path,
                } satisfies McpProviderDesktopToolSkill;
              } catch {
                return undefined;
              }
            }),
        );
        return found.filter((skill) => skill !== undefined);
      } catch {
        return [];
      }
    }),
  );
  return byPlugin.flat().sort((left, right) => left.name.localeCompare(right.name));
}
