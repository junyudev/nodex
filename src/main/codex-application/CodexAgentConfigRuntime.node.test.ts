import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import type { CodexModelOption, CodexPermissionState } from "../../shared/types";
import { CodexPermissions } from "./CodexPermissions";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { ComposerCatalog } from "./ComposerCatalog";
import { make } from "./CodexAgentConfigRuntime";

const MODELS: readonly CodexModelOption[] = [
  {
    id: "model-a",
    model: "model-a",
    displayName: "Model A",
    description: "Default model.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    multiAgentVersion: null,
    serviceTiers: [{ id: "fast", name: "Fast", description: "Faster responses" }],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "model-b",
    model: "model-b",
    displayName: "Model B",
    description: "Focused model.",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }],
    defaultReasoningEffort: "low",
    inputModalities: ["text"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

const BASE: CodexExecutionProfile = {
  modelId: "model-a",
  reasoningEffort: "high",
  serviceTier: null,
};

const permissionState = (mode: CodexPermissionState["mode"]): CodexPermissionState => ({
  mode,
  effectivePreset: mode,
  availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
  approvalPolicy: mode === "full-access" ? "never" : "on-request",
  approvalsReviewer: mode === "guardian-approvals" ? "auto_review" : "user",
  sandboxMode: mode === "full-access" ? "danger-full-access" : "workspace-write",
  sandbox: mode === "full-access" ? { type: "dangerFullAccess" } : null,
  autoReviewAvailable: true,
  configTarget: { source: "project", filePath: null },
});

const harness = (
  input: {
    readonly current?: CodexExecutionProfile | null;
    readonly permissionVerified?: boolean;
    readonly updates?: CodexExecutionProfile[];
  } = {},
) => {
  const updates = input.updates ?? [];
  return make.pipe(
    Effect.provideService(
      ComposerCatalog,
      ComposerCatalog.of({
        listModels: Effect.succeed(MODELS),
      } as unknown as ComposerCatalog["Service"]),
    ),
    Effect.provideService(
      CodexPermissions,
      CodexPermissions.of({
        resolve: ({ requestedMode }: Parameters<CodexPermissions["Service"]["resolve"]>[0]) =>
          Effect.succeed({
            state: permissionState(requestedMode ?? "auto"),
            verifiedBuiltinFullAccess: input.permissionVerified ?? false,
          }),
      } as unknown as CodexPermissions["Service"]),
    ),
    Effect.provideService(
      CodexThreadSettingsRuntime,
      CodexThreadSettingsRuntime.of({
        readExecutionProfile: () => Effect.succeed(input.current ?? BASE),
        update: ({ patch }: Parameters<CodexThreadSettingsRuntime["Service"]["update"]>[0]) => {
          if (patch.executionProfile) updates.push(patch.executionProfile);
          return Effect.succeed({} as never);
        },
      } as unknown as CodexThreadSettingsRuntime["Service"]),
    ),
  );
};

it.effect("resolves the complete new-task tuple with fieldwise last-wins semantics", () =>
  Effect.gen(function* () {
    const runtime = yield* harness();
    const prepared = yield* runtime.prepare({
      target: { kind: "new-thread", fallbackExecutionProfile: BASE },
      configs: [
        { mode: "default", reasoning: "medium", permission: "custom" },
        {
          mode: "plan",
          provider: "openai",
          model: "model-b",
          reasoning: "low",
          permission: "auto",
        },
      ],
      permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
    });

    assert.deepStrictEqual(prepared.executionProfile, {
      modelId: "model-b",
      reasoningEffort: "low",
      serviceTier: null,
    });
    assert.strictEqual(prepared.collaborationMode, "plan");
    assert.strictEqual(prepared.permissionMode, "auto");
  }),
);

it.effect("patches an existing task through one compound settings transaction", () =>
  Effect.gen(function* () {
    const updates: CodexExecutionProfile[] = [];
    const runtime = yield* harness({ updates });
    const prepared = yield* runtime.prepare({
      target: { kind: "existing-thread", threadId: "thread-a" },
      configs: [{ model: "model-b", reasoning: "low" }],
      permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
    });

    assert.deepStrictEqual(prepared.executionProfile, {
      modelId: "model-b",
      reasoningEffort: "low",
      serviceTier: null,
    });
    assert.deepStrictEqual(updates, [prepared.executionProfile]);
  }),
);

it.effect("maps the Composer Fast choice onto the native service tier", () =>
  Effect.gen(function* () {
    const runtime = yield* harness();
    const prepared = yield* runtime.prepare({
      target: { kind: "new-thread", fallbackExecutionProfile: BASE },
      configs: [{ speed: "fast" }],
      permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
    });
    assert.strictEqual(prepared.executionProfile?.serviceTier, "fast");
  }),
);

it.effect("fails closed for unsupported providers, catalog values, and attributes", () =>
  Effect.gen(function* () {
    const runtime = yield* harness();
    const unsupportedProvider = yield* Effect.exit(
      runtime.prepare({
        target: { kind: "new-thread", fallbackExecutionProfile: BASE },
        configs: [{ provider: "anthropic" }],
        permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
      }),
    );
    const unsupportedReasoning = yield* Effect.exit(
      runtime.prepare({
        target: { kind: "new-thread", fallbackExecutionProfile: BASE },
        configs: [{ model: "model-b", reasoning: "ultra" }],
        permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
      }),
    );
    const unknown = yield* Effect.exit(
      runtime.prepare({
        target: { kind: "new-thread", fallbackExecutionProfile: BASE },
        configs: [{ unknownAttributes: ["harness"] }],
        permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
      }),
    );

    assert.isTrue(Exit.isFailure(unsupportedProvider));
    assert.isTrue(Exit.isFailure(unsupportedReasoning));
    assert.isTrue(Exit.isFailure(unknown));
  }),
);

it.effect("does not treat a Full access tag as user consent", () =>
  Effect.gen(function* () {
    const runtime = yield* harness({ permissionVerified: false });
    const denied = yield* Effect.exit(
      runtime.prepare({
        target: { kind: "new-thread", fallbackExecutionProfile: BASE },
        configs: [{ permission: "full-access" }],
        permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
      }),
    );
    assert.isTrue(Exit.isFailure(denied));

    const verifiedRuntime = yield* harness({ permissionVerified: true });
    const prepared = yield* verifiedRuntime.prepare({
      target: { kind: "new-thread", fallbackExecutionProfile: BASE },
      configs: [{ permission: "full-access" }],
      permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
    });
    assert.strictEqual(prepared.permissionMode, "full-access");
  }),
);

it.effect("treats an empty Agent config as a real but fully inherited atom", () =>
  Effect.gen(function* () {
    const runtime = yield* harness();
    const prepared = yield* runtime.prepare({
      target: { kind: "new-thread", fallbackExecutionProfile: BASE },
      configs: [{}],
      permissionContext: { projectId: "project-a", workspaceRoots: ["/repo"] },
    });
    assert.deepStrictEqual(prepared, { hasConfig: true });
  }),
);
