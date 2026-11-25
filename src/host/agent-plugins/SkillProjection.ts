import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
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
import { asciiSlug } from "../../shared/ascii-name";
import { readSkillHeader } from "../../shared/skill-document/frontmatter";
import { pluginRevision, type CatalogPlugin } from "./PluginCatalog";
import { copyPackageSubtrees } from "./PackageFilesNode";

const formatVersion = 2;
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

export interface ProjectedPlugin {
  /** The copy of the plugin's package, relative to the projection root. */
  readonly directory: string;
  readonly skills: readonly SessionPluginSkill[];
}

export interface SkillProjection {
  readonly root: string;
  readonly plugins: ReadonlyMap<string, ProjectedPlugin>;
}

const removeDirectory = (path: string) =>
  Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.uninterruptible);

function rewriteSkill(
  pluginId: string,
  skill: ProjectableSkill,
  alias: string,
  root: string,
  directory: string,
) {
  return Effect.tryPromise(async (): Promise<SessionPluginSkill> => {
    const path = join(root, directory, "SKILL.md");
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
      directory,
      description: skill.description,
      ...(header.userInvocable === false ? { userInvocable: false } : {}),
    };
  }).pipe(Effect.uninterruptible);
}

/** A name unused in this projection, qualified by a stable digest of its owner when taken. */
function claimName(
  name: string,
  owner: readonly unknown[],
  reserved: ReadonlySet<string>,
  used: Set<string>,
) {
  let claimed = name;
  for (let counter = 0; used.has(claimed) || (claimed !== name && reserved.has(claimed));)
    claimed = name.slice(0, 48) + "-" + pluginRevision([...owner, counter++]).slice(0, 12);
  used.add(claimed);
  return claimed;
}

const populatePlugins = Effect.fnUntraced(function* (
  root: string,
  plugins: readonly ProjectionPlugin[],
) {
  const reservedSkills = new Set(plugins.flatMap(({ skills }) => skills.map(({ name }) => name)));
  const packageNames = plugins.map(({ id }) => asciiSlug(id.split("@")[0]!) || "plugin");
  const reservedPackages = new Set(packageNames);
  const delivered = new Map<string, ProjectedPlugin>();
  const usedSkills = new Set<string>();
  const usedPackages = new Set<string>();
  for (const [index, { id, root: source, skills }] of plugins.entries()) {
    // Each plugin keeps its package layout, so Skills reach the files beside them by path.
    const directory = posix.join(
      "plugins",
      claimName(packageNames[index]!, [id], reservedPackages, usedPackages),
    );
    const target = join(root, directory);
    const aliases = new Set(usedSkills);
    const entries = skills.map((skill) => ({
      skill,
      alias: claimName(skill.name, [id, skill.directory], reservedSkills, aliases),
    }));
    const projected = yield* copyPackageSubtrees(source, [{ source: ".", target }], {
      omitUnreadable: true,
      // Main removes every projection before it starts, so a crash cannot leave one in use.
      durable: false,
    }).pipe(
      Effect.andThen(
        Effect.forEach(entries, ({ skill, alias }) =>
          rewriteSkill(id, skill, alias, root, posix.join(directory, skill.directory)),
        ),
      ),
      Effect.catch(() =>
        removeDirectory(target).pipe(
          Effect.andThen(Effect.logWarning("Skipped a plugin while projecting Session Skills")),
          Effect.annotateLogs({ pluginId: id }),
          Effect.as(null),
        ),
      ),
    );
    if (!projected) continue;
    delivered.set(id, { directory, skills: projected });
    for (const { alias } of entries) usedSkills.add(alias);
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
      const plugins = yield* populatePlugins(staging, key.plugins);
      if (!plugins.size) return null;
      yield* Effect.acquireRelease(
        Effect.tryPromise(async () => {
          const manifest = join(staging, ".claude-plugin");
          await mkdir(manifest, { mode: 0o700 });
          const skills = [...plugins.values()].flatMap((plugin) =>
            plugin.skills.map(({ directory }) => "./" + directory),
          );
          await writeFile(
            join(manifest, "plugin.json"),
            JSON.stringify({ name: SESSION_SKILLS_PLUGIN_NAME, skills }),
            { mode: 0o600 },
          );
          await rename(staging, root);
        }),
        () => removeDirectory(root).pipe(Effect.ignore),
      ).pipe(Scope.provide(owner));
      return { root, plugins } satisfies SkillProjection;
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
