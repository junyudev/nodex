// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { AgentModelCatalog } from "../../shared/agent-model-catalog";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { make } from "./AgentBackendApplication";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ClaudeSdk } from "../platform/node/ClaudeSdk";
import { OpenCodeSdk } from "../platform/node/OpenCodeSdk";
import { NativePromptImages } from "./NativePromptImages";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { ClaudeNativeCatalog } from "./claude/ClaudeNativeCatalog";
import { OpenCodeModelCatalog } from "./opencode/OpenCodeModelCatalog";

const binding = { kind: "opencode", instanceConfigId: "work" } as const;
const catalog: AgentModelCatalog = {
  binding,
  models: [],
  configOptions: [],
  modes: null,
  defaultModel: null,
  health: { status: "ready", error: null },
};
const request = { scope: { kind: "project", projectId: "project", binding } } as const;
const fixture = Effect.gen(function* () {
  let revision = 1;
  let project = { id: "project", lifecycle: "active", primaryWorkspaceRoot: "/exact/project" };
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const discovered: unknown[] = [];
  const settings = makeTestApplicationSettings();
  const app = yield* make.pipe(
    Effect.provide(mainConfigLayer()),
    Effect.provideService(ClaudeNativeCatalog, {} as never),
    Effect.provideService(AgentRuntimeApplication, {} as never),
    Effect.provideService(ClaudeSdk, {
      discover: () => Effect.die("Catalogue must not execute a Query"),
    } as never),
    Effect.provideService(OpenCodeSdk, {
      open: () => Effect.die("Catalogue must not acquire a Session"),
    } as never),
    Effect.provideService(NativePromptImages, {} as never),
    Effect.provideService(ApplicationSettings, {
      ...settings,
      snapshot: () =>
        settings
          .snapshot()
          .pipe(Effect.map((snapshot) => ({ ...snapshot, revision: String(revision) }))),
    }),
    Effect.provideService(AgentBackendRegistry, {
      resolve: () =>
        Effect.succeed({ kind: "opencode", binding, displayName: "Work", instance: {} as never }),
      resolveAcpInstance: () => Effect.die("Unexpected ACP resolution"),
    }),
    Effect.provideService(ProjectWorkspace, { getProject: () => Effect.succeed(project) } as never),
    Effect.provideService(OpenCodeModelCatalog, {
      discover: (input) =>
        Effect.gen(function* () {
          discovered.push(input);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return catalog;
        }),
    }),
  );
  return {
    app,
    discovered,
    started: Deferred.await(started),
    release: Deferred.succeed(release, undefined),
    changeSettings: () => {
      revision += 1;
    },
    changeProject: () => {
      project = { ...project, lifecycle: "archived" };
    },
  };
});

it.effect("discovers models in the exact Project workspace without creating a session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const pending = yield* f.app.modelCatalog(request).pipe(Effect.forkChild);
      yield* f.started;
      assert.deepEqual(f.discovered, [
        {
          instanceConfigId: "work",
          workspaceRoot: "/exact/project",
          workspaceEnvironment: null,
          forceReload: undefined,
        },
      ]);
      yield* f.release;
      assert.deepEqual(yield* Fiber.join(pending), catalog);
    }),
  ),
);

for (const change of ["changeSettings", "changeProject"] as const) {
  it.effect(
    `rejects discovery when ${change === "changeSettings" ? "instance settings" : "Project lifecycle"} changes before publication`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const pending = yield* f.app.modelCatalog(request).pipe(Effect.flip, Effect.forkChild);
          yield* f.started;
          f[change]();
          yield* f.release;
          assert.equal((yield* Fiber.join(pending)).operation, "model-catalog.scope");
        }),
      ),
  );
}
