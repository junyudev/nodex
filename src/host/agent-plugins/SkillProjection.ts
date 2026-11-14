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

export const projectSkills = Effect.fn("SkillProjection.materialize")(function* (
  home: string,
  revision: string,
  plugins: readonly CatalogPlugin[],
) {
  const candidates = plugins.flatMap(({ id, root, package: pkg }) =>
    root && pkg
      ? pkg.skills.filter(({ valid }) => valid).map((skill) => ({ id, root, skill }))
      : [],
  );
  if (!candidates.length) return { skillsRoot: null, skills: [] };
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
  const reserved = new Set(candidates.map(({ skill }) => skill.name));
  const used = new Set<string>();
  const skills = yield* Effect.forEach(
    candidates,
    Effect.fnUntraced(function* ({ id, root: source, skill }) {
      let alias = skill.name;
      if (used.has(alias)) {
        let counter = 0;
        do {
          const suffix = pluginRevision([id, skill.directory, counter++]).slice(0, 12);
          alias = skill.name.slice(0, 48) + "-" + suffix;
        } while (reserved.has(alias) || used.has(alias));
      }
      used.add(alias);
      const target = join(root, "skills", alias);
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
  return { skillsRoot: root, skills };
});
