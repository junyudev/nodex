import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  effectivePluginContributions,
  PLUGIN_REGISTRY_DIRECTORY,
  type PluginProject,
  type PluginRegistry,
} from "../../shared/agent-plugins/installation-registry";
import { readSkillHeader } from "../../shared/skill-document/frontmatter";
import { copyPackageSubtrees } from "./PackageFilesNode";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// The registry ID is a stable hash of the installation's manifest name and source identity.
const claudePluginSlug = (installationId: string) => `nodex-${installationId.slice(0, 24)}`;

export function planClaudePluginProjection(registry: PluginRegistry, project: PluginProject) {
  const installations = effectivePluginContributions(registry, project)
    .filter(({ skills, mcpServers }) => skills.length > 0 || mcpServers.length > 0)
    .toSorted((left, right) => left.installationId.localeCompare(right.installationId));
  const plugins = installations.map((installation) => {
    const name = claudePluginSlug(installation.installationId);
    const skills = new Map<string, (typeof installation.skills)[number]>();
    for (const skill of installation.skills) {
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name) && !skills.has(skill.name))
        skills.set(skill.name, skill);
    }
    return {
      installationId: installation.installationId,
      generation: installation.generation,
      packageDirectory: installation.packageDirectory,
      mcpServers: installation.mcpServers,
      name,
      skills: [...skills.values()],
    };
  });
  return {
    projectDirectory: digest(JSON.stringify([project.spaceId, project.projectId])),
    key: digest(
      JSON.stringify([
        project.spaceId,
        project.projectId,
        plugins.map(({ installationId, generation }) => [installationId, generation]),
      ]),
    ),
    plugins,
  };
}

export type ClaudePluginProjection = ReturnType<typeof planClaudePluginProjection>;

function projectedSkill(markdown: string, name: string) {
  const header = readSkillHeader(markdown);
  if (header.reason || header.fields.name.value !== name || !header.fields.description.value)
    throw new Error("The approved skill header is unavailable.");
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(header.fields.description.value)}`,
    ...(header.disableModelInvocation ? ["disable-model-invocation: true"] : []),
    ...(header.userInvocable === false ? ["user-invocable: false"] : []),
    "---",
    "",
  ];
  return {
    markdown: lines.join("\n") + markdown.slice(header.bodyStart),
    userInvocable: header.userInvocable !== false,
  };
}

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new Error("Could not build the Claude skill projection."),
  });

export const materializeClaudePluginProjection = Effect.fn("ClaudePluginProjection.materialize")(
  function* (home: string, plan: ClaudePluginProjection) {
    const plugins = plan.plugins.filter(({ skills }) => skills.length > 0);
    if (plugins.length === 0) return { roots: [], skills: [] };
    const projectDirectory = join(home, PLUGIN_REGISTRY_DIRECTORY, "claude", plan.projectDirectory);
    yield* io(() => mkdir(projectDirectory, { recursive: true, mode: 0o700 }));
    // Each query gets immutable paths, so refreshing a Project cannot modify another live query.
    const directory = yield* Effect.acquireRelease(
      io(() => mkdtemp(join(projectDirectory, plan.key.slice(0, 12) + "-"))),
      (path) => io(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
    );
    const projected = yield* Effect.forEach(
      plugins,
      Effect.fnUntraced(function* (plugin) {
        const root = join(directory, plugin.name);
        yield* io(async () => {
          const manifest = join(root, ".claude-plugin");
          await mkdir(manifest, { recursive: true, mode: 0o700 });
          await writeFile(join(manifest, "plugin.json"), JSON.stringify({ name: plugin.name }), {
            mode: 0o600,
          });
        });
        yield* copyPackageSubtrees(
          join(home, plugin.packageDirectory),
          plugin.skills.map((skill) => ({
            source: skill.directory.slice(plugin.packageDirectory.length + 1) || ".",
            target: join(root, "skills", skill.name),
          })),
        ).pipe(Effect.mapError(() => new Error("Could not copy the approved Claude skills.")));
        const skills = yield* Effect.forEach(
          plugin.skills,
          Effect.fnUntraced(function* (skill) {
            const projected = yield* io(async () => {
              const entry = join(root, "skills", skill.name, "SKILL.md");
              const output = projectedSkill(await readFile(entry, "utf8"), skill.name);
              await writeFile(entry, output.markdown);
              return output;
            });
            return {
              name: `${plugin.name}:${skill.name}`,
              path: join(home, skill.directory, "SKILL.md"),
              userInvocable: projected.userInvocable,
            };
          }),
        );
        return { root, skills };
      }),
    );
    return {
      roots: projected.map(({ root }) => root),
      skills: projected.flatMap(({ skills }) => skills),
    };
  },
);
