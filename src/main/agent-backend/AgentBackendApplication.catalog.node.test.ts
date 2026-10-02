// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { AgentModelCatalog } from "../../shared/agent-model-catalog";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { make } from "./AgentBackendApplication";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import { AcpBackendSessionManager } from "./acp/AcpBackendSessionManager";
import { inactiveClaudeSessions } from "./claude/ClaudeSessionManager.test-fixtures";
import { OpenCodeSessionManager } from "./opencode/OpenCodeSessionManager";

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
    Effect.provide(inactiveClaudeSessions),
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
    Effect.provideService(AcpBackendSessionManager, {
      get: () => Effect.succeed(null),
      changes: Stream.empty,
    } as never),
    Effect.provideService(OpenCodeSessionManager, {
      nativeHome: () => Effect.die("Discovery must not resolve a session owner"),
      open: () => Effect.die("Discovery must not allocate a conversation"),
      discover: (input) =>
        Effect.gen(function* () {
          discovered.push(input);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return catalog;
        }),
      get: () => Effect.succeed(null),
      close: () => Effect.void,
      observe: () => Effect.void,
      unobserve: () => Effect.void,
      changes: Stream.empty,
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
    `rejects discovery when ${change === "changeSettings" ? "instance settings" : "Project authority"} changes before publication`,
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
