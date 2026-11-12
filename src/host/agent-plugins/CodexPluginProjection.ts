import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Effect from "effect/Effect";
import type {
  EffectivePluginContributions,
  PluginProject,
} from "../../shared/agent-plugins/installation-registry";
import { canonicalPackageRoot, copyPackageToStage } from "./PackageFilesNode";

const key = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function planCodexPluginProjection(
  home: string,
  project: PluginProject,
  contributions: readonly EffectivePluginContributions[],
) {
  const entries = contributions.toSorted((a, b) =>
    a.installationId.localeCompare(b.installationId),
  );
  const revision = key(
    entries.map(({ installationId, generation }) => [installationId, generation]),
  );
  const directory = join(home, "agent-plugins", "codex", key([project.spaceId, project.projectId]));
  return {
    revision,
    root: join(directory, revision),
    skills: entries.flatMap(({ installationId, packageDirectory, skills }) =>
      skills.map(({ name, directory }, index) => ({
        source: join(home, directory),
        packageRoot: join(home, packageDirectory),
        destination: join("skills", `${installationId}-${index}`, name),
      })),
    ),
  };
}

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new Error("Could not update Codex Plugin skills.") });

export const makeCodexPluginProjection = Effect.fnUntraced(function* (home: string) {
  const directory = join(home, "agent-plugins", "codex");
  // A Host restart leaves no live Codex delivery. Never restore an unverified saved root.
  yield* io(() => rm(directory, { recursive: true, force: true }));
  yield* Effect.addFinalizer(() =>
    io(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  );
  const roots = new Map<string, string>();
  const remove = (root: string) => io(() => rm(root, { recursive: true, force: true }));

  const withdraw = Effect.fnUntraced(function* (project: PluginProject) {
    const id = key([project.spaceId, project.projectId]);
    const root = roots.get(id);
    if (!root) return;
    yield* remove(root);
    roots.delete(id);
  });

  const reconcile = Effect.fnUntraced(function* (
    project: PluginProject,
    contributions: readonly EffectivePluginContributions[],
  ) {
    const plan = planCodexPluginProjection(home, project, contributions);
    const id = key([project.spaceId, project.projectId]);
    const previous = roots.get(id);
    if (previous === plan.root) return plan;
    if (previous) yield* withdraw(project);
    if (plan.skills.length === 0) return plan;

    const stage = plan.root + "." + randomUUID();
    yield* Effect.acquireUseRelease(
      io(() => mkdir(join(stage, "skills"), { recursive: true, mode: 0o700 })),
      () =>
        Effect.gen(function* () {
          for (const skill of plan.skills) {
            const destination = join(stage, skill.destination);
            yield* io(() => mkdir(destination, { recursive: true, mode: 0o700 }));
            const source = yield* canonicalPackageRoot(skill.source);
            const packageRoot = yield* canonicalPackageRoot(skill.packageRoot);
            const fromPackage = relative(packageRoot, source);
            if (
              isAbsolute(fromPackage) ||
              fromPackage === ".." ||
              fromPackage.startsWith(".." + sep)
            )
              return yield* Effect.fail(
                new Error("Codex Plugin skill escaped its approved package."),
              );
            yield* copyPackageToStage(source, destination);
          }
          // A prior Host process may have staged this same immutable generation.
          yield* remove(plan.root);
          yield* io(() => rename(stage, plan.root));
          roots.set(id, plan.root);
        }),
      () => remove(stage).pipe(Effect.ignore),
    );
    return plan;
  });

  return { reconcile, withdraw };
});
