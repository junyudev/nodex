import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  SESSION_SKILLS_PLUGIN_NAME,
  type SessionPluginSkill,
} from "../../shared/agent-plugins/session-plugins";
import { readSkillHeader } from "../../shared/skill-document/frontmatter";
import { pluginRevision, type CatalogPlugin } from "./PluginCatalog";
import { copyPackageSubtrees } from "./PackageFilesNode";

export const makeSkillProjection = Effect.fn("SkillProjection.materialize")(function* (
  home: string,
  revision: string,
  plugins: readonly CatalogPlugin[],
) {
  const reserved = new Set(
    plugins.flatMap(({ root, package: pkg }) =>
      root && pkg ? pkg.skills.filter(({ valid }) => valid).map(({ name }) => name) : [],
    ),
  );
  if (!reserved.size) return null;
  const parent = join(home, "plugin-sessions");
  yield* Effect.tryPromise(() => mkdir(parent, { recursive: true, mode: 0o700 }));
  const root = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(parent, revision.slice(0, 12) + "-"))),
    (directory) =>
      Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  );
  yield* Effect.tryPromise(async () => {
    const manifest = join(root, ".claude-plugin");
    await mkdir(manifest, { mode: 0o700 });
    await writeFile(
      join(manifest, "plugin.json"),
      JSON.stringify({ name: SESSION_SKILLS_PLUGIN_NAME }),
      { mode: 0o600 },
    );
  });
  const used = new Set<string>();
  const project = Effect.fnUntraced(function* ({ id, root: source, package: pkg }: CatalogPlugin) {
    if (!source || !pkg) return [];
    return yield* Effect.forEach(
      pkg.skills.filter(({ valid }) => valid),
      Effect.fnUntraced(function* (skill) {
        let alias = skill.name;
        if (used.has(alias)) {
          let counter = 0;
          do {
            const suffix = pluginRevision([id, skill.directory, counter++]).slice(0, 12);
            alias = skill.name.slice(0, 48) + "-" + suffix;
          } while (reserved.has(alias) || used.has(alias));
        }
        const target = join(root, "skills", alias);
        yield* Effect.acquireRelease(
          Effect.sync(() => used.add(alias)),
          () =>
            Effect.tryPromise(() => rm(target, { recursive: true, force: true })).pipe(
              Effect.ignore,
              Effect.ensuring(
                Effect.sync(() => {
                  used.delete(alias);
                }),
              ),
            ),
        );
        yield* copyPackageSubtrees(source, [{ source: skill.directory, target }]);
        return yield* Effect.tryPromise(async (): Promise<SessionPluginSkill> => {
          const path = join(target, "SKILL.md");
          const markdown = await readFile(path, "utf8");
          const header = readSkillHeader(markdown);
          if (
            header.reason ||
            header.fields.name.value !== skill.name ||
            header.fields.description.value !== skill.description
          )
            throw new Error("The plugin skill changed during projection.");
          await writeFile(
            path,
            [
              "---",
              "name: " + alias,
              "description: " + JSON.stringify(skill.description),
              ...(header.disableModelInvocation ? ["disable-model-invocation: true"] : []),
              ...(header.userInvocable === false ? ["user-invocable: false"] : []),
              "---",
              "",
            ].join("\n") + markdown.slice(header.bodyStart),
          );
          return {
            pluginId: id,
            alias,
            description: skill.description,
            ...(header.userInvocable === false ? { userInvocable: false } : {}),
          };
        });
      }),
    );
  });
  return { root, project };
});
