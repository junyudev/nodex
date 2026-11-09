import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import {
  DatabaseNotifierRuntime,
  headless,
  type ProjectsChangeEvent,
} from "../../main/host-runtime/DatabaseNotifierRuntime";
import { WindowRuntime } from "../../main/window-runtime/WindowRuntime";

it.effect("publishes Project changes to phone subscribers without an open desktop window", () =>
  Effect.gen(function* () {
    const notifier = yield* DatabaseNotifierRuntime;
    const received: ProjectsChangeEvent[] = [];
    yield* notifier.projectInvalidations.pipe(
      Stream.runForEach((event) => Effect.sync(() => received.push(event))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* notifier.notifyProjectsChanged("update", "project");
    yield* notifier.notifyProjectsChanged("reorder");
    yield* Effect.yieldNow;
    expect(received).toEqual([
      { changeType: "update", projectId: "project" },
      { changeType: "reorder", projectId: undefined },
    ]);
  }).pipe(
    Effect.provide(headless),
    Effect.provideService(WindowRuntime, {
      all: () => [],
    } as unknown as WindowRuntime["Service"]),
  ),
);
