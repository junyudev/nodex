import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import path from "node:path";
import { isContained, existingAncestor, statIfPresent } from "../platform/node/SkillFilesNode";
import type { FileWatchHost } from "../file-watch-host";
import type { SkillFileError } from "../platform/node/SkillFilesNode";

const related = (target: string, changed: string) =>
  changed === target || isContained(target, changed) || isContained(changed, target);

interface WatchTarget {
  readonly path: string;
  readonly recursive: boolean;
}

const bindingFor = ({ path: target, recursive }: WatchTarget) =>
  Effect.tryPromise(async () => {
    const parent = await existingAncestor(path.dirname(target));
    const root = recursive ? await existingAncestor(target) : parent;
    const info = await statIfPresent(root);
    const parentInfo = root === parent ? info : await statIfPresent(parent);
    return {
      root,
      parent,
      identity: JSON.stringify([root, parent, info?.dev, info?.ino, parentInfo?.ino]),
    };
  }).pipe(Effect.orElseSucceed(() => null));

/** Rebind after a root appears or is replaced. Reconcile only after the new watches are ready. */
export function observeSkillRoots(
  readRoots: Effect.Effect<readonly WatchTarget[], SkillFileError>,
  changes: Stream.Stream<unknown>,
  host: FileWatchHost,
  refreshComposers: Effect.Effect<void>,
) {
  return Stream.callback<"ready" | "changed", SkillFileError>((events) =>
    Effect.gen(function* () {
      const wake = yield* Queue.sliding<"native" | "files">(32);
      yield* changes.pipe(
        Stream.runForEach(() => Queue.offer(wake, "native")),
        Effect.forkScoped({ startImmediately: true }),
      );
      let started = false;
      while (true) {
        const roots = yield* started ? readRoots.pipe(Effect.orElseSucceed(() => [])) : readRoots;
        const change = yield* Effect.scoped(
          Effect.gen(function* () {
            const plans = new Map<
              string,
              { directory: string; recursive: boolean; targets: string[] }
            >();
            const add = (directory: string, recursive: boolean, target: string) => {
              const key = JSON.stringify([directory, recursive]);
              const previous = plans.get(key);
              if (previous) previous.targets.push(target);
              else plans.set(key, { directory, recursive, targets: [target] });
            };
            let degraded = false;
            const bindings = yield* Effect.forEach(roots, bindingFor, { concurrency: 8 });
            for (const [index, binding] of bindings.entries()) {
              if (!binding) {
                degraded = true;
                continue;
              }
              const target = roots[index];
              if (target.recursive && binding.root === target.path)
                add(target.path, true, target.path);
              add(binding.parent, false, target.path);
            }
            yield* Effect.forEach(
              plans.values(),
              ({ directory, recursive, targets }) =>
                Effect.gen(function* () {
                  const ready = yield* Deferred.make<boolean>();
                  yield* host
                    .watch({
                      path: directory,
                      recursive,
                      renameEventHandling: "changed-path",
                    })
                    .pipe(
                      Stream.runForEach((event) => {
                        if (event._tag === "Ready") return Deferred.succeed(ready, true);
                        if (
                          !event.changedPaths.length ||
                          event.changedPaths.some((changed) =>
                            targets.some((target) => related(target, changed)),
                          )
                        )
                          return Queue.offer(wake, "files");
                        return Effect.void;
                      }),
                      Effect.catch(() =>
                        Deferred.succeed(ready, false).pipe(
                          Effect.flatMap((failedBeforeReady) =>
                            failedBeforeReady ? Effect.void : Queue.offer(wake, "files"),
                          ),
                        ),
                      ),
                      Effect.ensuring(Deferred.succeed(ready, false)),
                      Effect.forkScoped({ startImmediately: true }),
                    );
                  if (!(yield* Deferred.await(ready))) degraded = true;
                }),
              { concurrency: 8 },
            );
            const after = yield* Effect.forEach(roots, bindingFor, { concurrency: 8 });
            if (after.some((binding, index) => binding?.identity !== bindings[index]?.identity)) {
              yield* Queue.offer(wake, "files");
            }
            yield* Queue.offer(events, started ? "changed" : "ready");
            started = true;
            const next = Queue.take(wake);
            const event = yield* degraded
              ? Effect.raceFirst(next, Effect.sleep("15 seconds").pipe(Effect.as("files" as const)))
              : next;
            yield* Effect.sleep("75 millis");
            const pending = yield* Queue.clear(wake);
            return event === "files" || pending.includes("files");
          }),
        );
        if (change) yield* refreshComposers;
      }
    }),
  );
}
