import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WorkspaceDependencies } from "../../shared/workspace-dependency-runtime";
import {
  readWorkspaceDependencyBundle,
  type WorkspaceDependencyBundleInput,
} from "../platform/node/WorkspaceDependencyBundle";

export class WorkspaceDependencyRuntime extends Context.Service<
  WorkspaceDependencyRuntime,
  {
    readonly read: Effect.Effect<WorkspaceDependencies>;
  }
>()("nodex/main/host-runtime/WorkspaceDependencyRuntime") {}

/** The immutable packaged closure is verified lazily once per Desktop process. */
export const live = (input: WorkspaceDependencyBundleInput) =>
  Layer.effect(
    WorkspaceDependencyRuntime,
    Effect.gen(function* () {
      const read = yield* Effect.cached(Effect.promise(() => readWorkspaceDependencyBundle(input)));
      return WorkspaceDependencyRuntime.of({ read });
    }),
  );
