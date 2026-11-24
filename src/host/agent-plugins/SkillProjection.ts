import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  SESSION_SKILLS_PLUGIN_NAME,
  type SessionPluginSkill,
} from "../../shared/agent-plugins/session-plugins";
import type { AgentPluginSkill } from "../../shared/agent-plugins/types";
import { readSkillHeader } from "../../shared/skill-document/frontmatter";
import { pluginRevision, type CatalogPlugin } from "./PluginCatalog";
import { copyPackageSubtrees } from "./PackageFilesNode";

const formatVersion = 1;
export const SKILL_PROJECTION_IDLE_TTL = "30 seconds";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type ProjectableSkill = Pick<AgentPluginSkill, "name" | "directory" | "description">;
type ProjectionPlugin = {
  readonly id: string;
  readonly root: string;
  readonly digest: string;
  readonly skills: readonly ProjectableSkill[];
};

class ProjectionKey implements Equal.Equal {
  readonly digest: string;

  constructor(readonly plugins: readonly ProjectionPlugin[]) {
    this.digest = pluginRevision([
      formatVersion,
      plugins.map(({ id, root, digest, skills }) => [
        id,
        root,
        digest,
        skills.map(({ name, directory }) => [name, directory]),
      ]),
    ]);
  }

  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof ProjectionKey && this.digest === other.digest;
  }

  [Hash.symbol](): number {
    return Hash.string(this.digest);
  }
}

export interface SkillProjection {
  readonly root: string;
  readonly skillsByPlugin: ReadonlyMap<string, readonly SessionPluginSkill[]>;
}

const removeDirectory = (path: string) =>
  Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.uninterruptible);

function rewriteSkill(pluginId: string, skill: ProjectableSkill, alias: string, target: string) {
  return Effect.tryPromise(async (): Promise<SessionPluginSkill> => {
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
      pluginId,
      alias,
      description: skill.description,
      ...(header.userInvocable === false ? { userInvocable: false } : {}),
    };
  }).pipe(Effect.uninterruptible);
}

const populateSkills = Effect.fnUntraced(function* (
  root: string,
  plugins: readonly ProjectionPlugin[],
) {
  const reserved = new Set(plugins.flatMap(({ skills }) => skills.map(({ name }) => name)));
  const delivered = new Map<string, readonly SessionPluginSkill[]>();
  const used = new Set<string>();
  for (const { id, root: source, skills } of plugins) {
    const aliases = new Set<string>();
    const subtrees = skills.map((skill) => {
      let alias = skill.name;
      if (used.has(alias) || aliases.has(alias)) {
        let counter = 0;
        do {
          const suffix = pluginRevision([id, skill.directory, counter++]).slice(0, 12);
          alias = skill.name.slice(0, 48) + "-" + suffix;
        } while (reserved.has(alias) || used.has(alias) || aliases.has(alias));
      }
      aliases.add(alias);
      return { source: skill.directory, target: join(root, "skills", alias), alias, skill };
    });
    const projected = yield* copyPackageSubtrees(source, subtrees).pipe(
      Effect.andThen(
        Effect.forEach(subtrees, ({ skill, alias, target }) =>
          rewriteSkill(id, skill, alias, target),
        ),
      ),
      Effect.catch(() =>
        Effect.forEach(subtrees, ({ target }) => removeDirectory(target), { discard: true }).pipe(
          Effect.andThen(Effect.logWarning("Skipped a plugin while projecting Session Skills")),
          Effect.annotateLogs({ pluginId: id }),
          Effect.as(null),
        ),
      ),
    );
    if (!projected) continue;
    delivered.set(id, projected);
    for (const alias of aliases) used.add(alias);
  }
  return delivered;
});

const materialize = Effect.fn("SkillProjection.materialize")(function* (
  parent: string,
  key: ProjectionKey,
) {
  const owner = yield* Effect.scope;
  const root = join(parent, key.digest);
  // A previous removal can fail. The caller owns this path until its finalizers finish.
  yield* removeDirectory(root);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(parent, ".tmp-"))),
        (path) => removeDirectory(path).pipe(Effect.ignore),
      );
      const skillsByPlugin = yield* populateSkills(staging, key.plugins);
      if (!skillsByPlugin.size) return null;
      yield* Effect.acquireRelease(
        Effect.tryPromise(async () => {
          const manifest = join(staging, ".claude-plugin");
          await mkdir(manifest, { mode: 0o700 });
          await writeFile(
            join(manifest, "plugin.json"),
            JSON.stringify({ name: SESSION_SKILLS_PLUGIN_NAME }),
            { mode: 0o600 },
          );
          await rename(staging, root);
        }),
        () => removeDirectory(root).pipe(Effect.ignore),
      ).pipe(Scope.provide(owner));
      return { root, skillsByPlugin } satisfies SkillProjection;
    }),
  );
});

/** A Profile's store belongs to Main. Each acquisition is retained by the caller's Scope. */
export const makeSkillProjectionStore = Effect.fn("SkillProjectionStore.make")(function* (
  home: string,
) {
  const parent = join(home, "plugin-sessions");
  // Nothing in this directory is live before Main creates the store.
  const ready = yield* Effect.tryPromise(async () => {
    await rm(parent, { recursive: true, force: true });
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }).pipe(Effect.exit);

  const lanes = yield* RcMap.make({ lookup: (_digest: string) => Semaphore.make(1) });
  const projections = yield* RcMap.make({
    idleTimeToLive: SKILL_PROJECTION_IDLE_TTL,
    lookup: Effect.fnUntraced(function* (key: ProjectionKey) {
      yield* ready;
      const lane = yield* RcMap.get(lanes, key.digest);
      // An expired RcMap entry is unindexed before its asynchronous cleanup finishes.
      yield* Effect.acquireRelease(lane.take(1), () => lane.release(1), { interruptible: true });
      // Finish interrupting any staging writes before releasing the path's permit.
      const worker = yield* materialize(parent, key).pipe(Effect.forkScoped);
      return yield* Fiber.join(worker);
    }),
  });
  const acquire = Effect.fnUntraced(function* (plugins: readonly CatalogPlugin[]) {
    const selected = plugins.flatMap(({ id, root, package: pkg }): ProjectionPlugin[] => {
      if (!root || !pkg) return [];
      const skills = pkg.skills
        .filter(({ valid }) => valid)
        .toSorted((a, b) => compare(a.directory, b.directory) || compare(a.name, b.name));
      return skills.length ? [{ id, root, digest: pkg.digest, skills }] : [];
    });
    if (!selected.length) return null;
    selected.sort((a, b) => compare(a.id, b.id));
    return yield* RcMap.get(projections, new ProjectionKey(selected));
  });
  return { acquire };
});

export type SkillProjectionStore = Effect.Success<ReturnType<typeof makeSkillProjectionStore>>;
