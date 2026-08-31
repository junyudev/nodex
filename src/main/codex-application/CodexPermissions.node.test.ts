import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { CodexPermissionMode } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  CodexPermissions,
  CodexPermissionsError,
  live as codexPermissionsLive,
} from "./CodexPermissions";

const makeHarness = (
  options: {
    readonly autoReviewAvailable?: boolean;
    readonly explicitPermissionChoice?: boolean;
    readonly failFirstConfigRead?: boolean;
    readonly rejectConfigWrite?: boolean;
  } = {},
) => {
  const config: Record<string, unknown> = {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    approvals_reviewer: "user",
    ...(options.autoReviewAvailable === false ? { "features.guardian_approval": false } : {}),
  };
  const origins = options.explicitPermissionChoice
    ? {
        approval_policy: {
          name: { type: "user", file: "/profile/agent/config.toml", profile: null },
          version: "test",
        },
        sandbox_mode: {
          name: { type: "user", file: "/profile/agent/config.toml", profile: null },
          version: "test",
        },
      }
    : {};
  const selections = new Map<string | null, CodexPermissionMode>();
  const requests: string[] = [];
  let configReadCount = 0;
  const requestLocal = ((method: string, params: unknown) => {
    requests.push(method);
    if (method === "config/read") {
      configReadCount += 1;
      if (options.failFirstConfigRead === true && configReadCount === 1) {
        return Effect.fail(
          new CodexPermissionsError({
            operation: "test-config-read",
            cause: new Error("transient read failure"),
          }),
        );
      }
      return Effect.succeed({ config, origins });
    }
    if (method === "configRequirements/read") return Effect.succeed({ requirements: null });
    if (method === "config/batchWrite") {
      if (options.rejectConfigWrite === true) {
        return Effect.fail(
          new CodexPermissionsError({ operation: "test-write", cause: new Error("write failed") }),
        );
      }
      const edits = (params as { readonly edits: readonly { keyPath: string; value: unknown }[] })
        .edits;
      for (const edit of edits) config[edit.keyPath] = edit.value;
      return Effect.succeed({});
    }
    if (method === "config/value/write") {
      const input = params as { readonly keyPath: string; readonly value: unknown };
      config[input.keyPath] = input.value;
      return Effect.succeed({});
    }
    return Effect.die(new Error(`Unexpected request: ${method}`));
  }) as CodexGateway["Service"]["requestLocal"];
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  const gateway = CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal,
    requestOnHost: (_hostId, method, params) => requestLocal(method, params),
    requestForThread: (_threadId, method, params) => requestLocal(method, params),
    notifyLocal: unsupported,
    connection: () => unsupported(),
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.sync(() => requests.push("awaitReady")),
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
  const workspaceRead = ((read: { readonly kind: string; readonly project_id?: string }) => {
    if (read.kind === "project") {
      return Effect.succeed({
        value: {
          kind: "project",
          project: {
            sources: [{ root: "/workspace/project" }],
          },
        },
      });
    }
    const projectId =
      read.kind === "projectless_permission_mode" ? null : (read.project_id ?? null);
    return Effect.succeed({
      value: {
        kind: read.kind,
        mode: selections.get(projectId) ?? null,
      },
    });
  }) as unknown as CoreModules["Service"]["workspace"]["read"];
  const workspaceApply = ((input: {
    readonly intent:
      | { readonly kind: "set_projectless_permission_mode"; readonly mode: CodexPermissionMode }
      | {
          readonly kind: "set_project_permission_mode";
          readonly project_id: string;
          readonly mode: CodexPermissionMode;
        };
  }) => {
    const intent = input.intent;
    selections.set(
      intent.kind === "set_projectless_permission_mode" ? null : intent.project_id,
      intent.mode,
    );
    return Effect.succeed({});
  }) as unknown as CoreModules["Service"]["workspace"]["apply"];
  const core = CoreModules.of({
    localMutation: { resolve: unsupported },
    library: {
      read: unsupported,
      apply: unsupported,
      filterProjectionImpactForProject: unsupported,
    },
    database: { read: unsupported, apply: unsupported },
    workspace: { read: workspaceRead, apply: workspaceApply },
    automation: { read: unsupported, apply: unsupported },
    administration: { read: unsupported, apply: unsupported },
    document: {
      read: unsupported,
      apply: unsupported,
      sync: unsupported,
      canvasSync: unsupported,
      applyUpdate: unsupported,
      publishAwareness: unsupported,
    },
  });
  return { config, core, gateway, requests, selections };
};

it.effect("owns permission config, persisted selection, cache, and verification", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      codexPermissionsLive({ runtimeStateHome: "/profile/agent" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, harness.gateway),
            Layer.succeed(CoreModules, harness.core),
          ),
        ),
      ),
      scope,
    );
    const permissions = Context.get(context, CodexPermissions);

    const initial = yield* permissions.snapshot("project:one");
    assert.strictEqual(initial.mode, "guardian-approvals");
    assert.strictEqual(initial.approvalsReviewer, "auto_review");
    assert.strictEqual(harness.requests[0], "awaitReady");
    assert.deepEqual(
      initial.sandbox?.type === "workspaceWrite" ? initial.sandbox.writableRoots : [],
      ["/workspace/project"],
    );

    const updated = yield* permissions.setMode("project:one", "full-access");
    assert.strictEqual(updated.mode, "full-access");
    assert.strictEqual(harness.selections.get("project:one"), "full-access");
    const decision = yield* permissions.resolve({
      projectId: "project:one",
      requestedMode: "full-access",
      workspaceRoots: ["/workspace/project"],
    });
    assert.isTrue(decision.verifiedBuiltinFullAccess);
    assert.strictEqual(decision.state.approvalPolicy, "never");
    assert.strictEqual(decision.state.sandbox?.type, "dangerFullAccess");

    const custom = yield* permissions.setConfigValue("project:one", "sandbox_mode", "read-only");
    assert.strictEqual(custom.mode, "custom");
    assert.strictEqual(harness.selections.get("project:one"), "custom");
    assert.isTrue(harness.requests.includes("config/value/write"));

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not persist a mode when the app-server config write fails", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ rejectConfigWrite: true });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      codexPermissionsLive({ runtimeStateHome: "/profile/agent" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, harness.gateway),
            Layer.succeed(CoreModules, harness.core),
          ),
        ),
      ),
      scope,
    );
    const permissions = Context.get(context, CodexPermissions);
    const state = yield* permissions.setMode("project:one", "full-access");

    assert.strictEqual(state.mode, "guardian-approvals");
    assert.isFalse(harness.selections.has("project:one"));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("uses the safe fallback when the fresh Profile default is unavailable", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ autoReviewAvailable: false });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      codexPermissionsLive({ runtimeStateHome: "/profile/agent" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, harness.gateway),
            Layer.succeed(CoreModules, harness.core),
          ),
        ),
      ),
      scope,
    );

    const state = yield* Context.get(context, CodexPermissions).snapshot("project:one");
    assert.strictEqual(state.mode, "auto");
    assert.isFalse(state.availableModes.includes("guardian-approvals"));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps a persisted built-in selection authoritative over the fresh Profile default", () =>
  Effect.gen(function* () {
    for (const mode of ["auto", "full-access"] as const) {
      const harness = makeHarness();
      harness.selections.set("project:one", mode);
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        codexPermissionsLive({ runtimeStateHome: "/profile/agent" }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(CodexGateway, harness.gateway),
              Layer.succeed(CoreModules, harness.core),
            ),
          ),
        ),
        scope,
      );

      const state = yield* Context.get(context, CodexPermissions).snapshot("project:one");
      assert.strictEqual(state.mode, mode);
      assert.strictEqual(state.effectivePreset, mode);
      if (mode === "auto") assert.strictEqual(state.approvalsReviewer, "user");
      if (mode === "full-access") assert.strictEqual(state.sandbox?.type, "dangerFullAccess");
      yield* Scope.close(scope, Exit.void);
    }
  }),
);

it.effect("preserves an explicit config choice when no Nodex selection exists", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ explicitPermissionChoice: true });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      codexPermissionsLive({ runtimeStateHome: "/profile/agent" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, harness.gateway),
            Layer.succeed(CoreModules, harness.core),
          ),
        ),
      ),
      scope,
    );

    const state = yield* Context.get(context, CodexPermissions).snapshot("project:one");
    assert.strictEqual(state.mode, "custom");
    assert.strictEqual(state.approvalsReviewer, "user");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not cache a transient fallback as permission authority", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ failFirstConfigRead: true });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      codexPermissionsLive({ runtimeStateHome: "/profile/agent" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, harness.gateway),
            Layer.succeed(CoreModules, harness.core),
          ),
        ),
      ),
      scope,
    );
    const permissions = Context.get(context, CodexPermissions);

    assert.strictEqual((yield* permissions.snapshot("project:one")).mode, "auto");
    assert.strictEqual((yield* permissions.snapshot("project:one")).mode, "guardian-approvals");
    yield* Scope.close(scope, Exit.void);
  }),
);
