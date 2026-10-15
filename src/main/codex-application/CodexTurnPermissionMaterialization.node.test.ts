import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { produce } from "immer";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import {
  CodexGateway,
  CodexThreadHostResolver,
  type CodexGatewayRequestOptions,
} from "../codex-runtime/CodexGateway";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type {
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  TurnStartParams,
} from "@nodex/codex-app-server-protocol/v2";
import { CodexAgentConfigRuntime } from "./CodexAgentConfigRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexConversationContext } from "./CodexConversationContext";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexInputAssets } from "./CodexInputAssets";

import { CodexPreferences } from "./CodexPreferences";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { make, type CodexTurnStartPreparationInput } from "./CodexTurnPreparation";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalLiveTurnParams,
} from "../../shared/types";

vi.mock("../platform/node/NodexCliBootstrap", () => ({
  buildNodexCliBootstrap: () => Effect.succeed({ kind: "application", value: "fixture" }),
}));

const threadId = "permission-materialization";
const workspace = {
  type: "workspaceWrite" as const,
  writableRoots: ["/workspace/project"],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};
const current = {
  activePermissionProfile: { id: "team-profile", extends: ":workspace" },
  approvalPolicy: "untrusted" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: workspace,
  runtimeWorkspaceRoots: ["/workspace/project"],
};
const state = produce(conversationFixture(threadId, [turnFixture("assigned")]), (draft) => {
  draft.currentPermissions = current;
});

const disabledFastMode: ConfigRequirementsReadResponse = {
  supportsIndependentSpeedModes: false,
  requirements: {
    modelProvider: null,
    modelProviders: null,
    allowedLoginMethods: null,
    cliAuthCredentialsStore: null,
    chatgptBaseUrl: null,
    additionalDeveloperInstructions: null,
    allowedApprovalPolicies: null,
    allowedApprovalsReviewers: null,
    allowedSandboxModes: null,
    allowedWindowsSandboxImplementations: null,
    allowedPermissionProfiles: null,
    defaultPermissions: null,
    allowedWebSearchModes: null,
    allowManagedHooksOnly: null,
    allowBrowserAndComputerUse: null,
    allowAppshots: null,
    allowRemoteControl: null,
    computerUse: null,
    browserUse: null,
    inAppBrowser: null,
    featureRequirements: { fast_mode: false },
    hooks: null,
    enforceResidency: null,
    network: null,
    application: null,
    autoReview: null,
    models: null,
    sqliteHome: null,
    logDir: null,
    modelCatalogJson: null,
    checkForUpdateOnStartup: null,
    allowLoginShell: null,
    feedback: null,
  },
};

interface PreparationFixture {
  readonly canonical?: CodexCanonicalConversationState;
  readonly defaultPersonality?: TurnStartParams["personality"];
  readonly config?: Partial<ConfigReadResponse["config"]>;
  readonly configFailure?: CodexRuntimeError;

  readonly writableRoots?: readonly string[];
  readonly requirements?: Effect.Effect<ConfigRequirementsReadResponse, CodexRuntimeError>;
  readonly requests?: Array<{
    threadId: string;
    method: string;
    params: unknown;
    options?: CodexGatewayRequestOptions;
  }>;
}

const prepare = (
  input: Pick<CodexTurnStartPreparationInput, "originalRequest" | "originalContext" | "overrides">,
  fixture: PreparationFixture = {},
) =>
  make.pipe(
    Effect.provideService(MainConfig, {} as MainConfig["Service"]),
    Effect.provideService(CoreAuthority, {} as CoreAuthority["Service"]),
    Effect.provideService(CodexAgentConfigRuntime, {
      prepare: () => Effect.succeed({}),
    } as unknown as CodexAgentConfigRuntime["Service"]),
    Effect.provideService(CodexAttachments, {} as CodexAttachments["Service"]),
    Effect.provideService(CodexConversationContext, {
      read: () =>
        Effect.succeed({
          threadId,
          rootThreadId: threadId,
          parentThreadId: null,
          projectId: "project",
          cwd: "/workspace/project",
          writableRoots: fixture.writableRoots ?? ["/workspace/project"],
        }),
    }),
    Effect.provideService(CodexConversationProjection, {
      read: () => Effect.succeed({ canonical: fixture.canonical ?? state, snapshot: null }),
    } as unknown as CodexConversationProjection["Service"]),

    Effect.provideService(CodexPreferences, {
      current: () => fixture.defaultPersonality ?? null,
    } as unknown as CodexPreferences["Service"]),
    Effect.provideService(CodexThreadSettingsRuntime, {
      awaitCurrent: () => Effect.void,
    } as unknown as CodexThreadSettingsRuntime["Service"]),
    Effect.provideService(TemporaryAssets, {} as TemporaryAssets["Service"]),
    Effect.provideService(CodexInputAssets, {
      retainPrepared: (_threadId, _id, prepared) => Effect.succeed(prepared),
      retainCaptured: () => Effect.die("Unused captured input"),
    }),
    Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
    Effect.provideService(CodexGateway, {
      requestForThread: (
        id: string,
        method: string,
        params: unknown,
        options?: CodexGatewayRequestOptions,
      ) => {
        fixture.requests?.push({ threadId: id, method, params, options });
        if (method === "config/read") {
          return fixture.configFailure
            ? Effect.fail(fixture.configFailure)
            : Effect.succeed({ config: fixture.config ?? {}, origins: {}, layers: null });
        }
        return fixture.requirements ?? Effect.succeed({ requirements: null });
      },
    } as unknown as CodexGateway["Service"]),
    Effect.flatMap((service) =>
      service.start({
        threadId,
        prompt: "continue",
        rendererOwnsState: true,
        ...input,
        overrides: { clientUserMessageId: "message", ...input.overrides },
      }),
    ),
  );

const liveParams = (
  overrides: Partial<CodexCanonicalLiveTurnParams> = {},
): CodexCanonicalLiveTurnParams => ({
  ...state.turns[0]!.params,
  attachments: [],
  sandboxPolicy: workspace,
  permissions: "team-profile",
  runtimeWorkspaceRoots: ["/workspace/project"],

  ...overrides,
});

it.effect(
  "retains explicit null personality and summary through native and resident settings",
  () =>
    Effect.gen(function* () {
      const canonical = produce(state, (draft) => {
        draft.hydrationContext!.latestThreadSettings = { personality: "friendly" };
      });
      const plan = yield* prepare(
        { originalRequest: { threadId, input: [], personality: null, summary: null } },
        { canonical, defaultPersonality: "pragmatic" },
      );
      assert.strictEqual(plan.request.personality, null);
      assert.strictEqual(plan.canonicalParams?.personality, null);
      assert.strictEqual(plan.request.summary, null);
      assert.strictEqual(plan.canonicalParams?.summary, null);
    }),
);

it.effect("uses the selected turn personality in the accepted settings", () =>
  Effect.gen(function* () {
    const plan = yield* prepare(
      { originalRequest: { threadId, input: [], personality: "pragmatic" } },
      { defaultPersonality: "friendly" },
    );
    assert.strictEqual(plan.request.personality, "pragmatic");
    assert.strictEqual(plan.canonicalParams?.personality, "pragmatic");
  }),
);

it.effect("inherits personality from the latest assigned turn when next settings omit it", () =>
  Effect.gen(function* () {
    const canonical = produce(state, (draft) => {
      draft.hydrationContext!.latestThreadSettings = null;
      draft.turns[0]!.params.personality = "pragmatic";
      delete draft.turns[0]!.permissionParamsSource;
    });
    const plan = yield* prepare(
      { originalRequest: { threadId, input: [] } },
      { canonical, defaultPersonality: "friendly" },
    );
    assert.strictEqual(plan.request.personality, "pragmatic");
    assert.strictEqual(plan.canonicalParams?.personality, "pragmatic");
  }),
);

it.effect("disables personality inheritance along with other thread settings", () =>
  Effect.gen(function* () {
    const canonical = produce(state, (draft) => {
      draft.hydrationContext!.latestThreadSettings = { personality: "pragmatic" };
    });
    const plan = yield* prepare(
      {
        originalRequest: { threadId, input: [] },
        originalContext: { inheritThreadSettings: false },
      },
      { canonical, defaultPersonality: "friendly" },
    );
    assert.strictEqual(plan.request.personality, "friendly");
    assert.strictEqual(plan.canonicalParams?.personality, "friendly");
  }),
);

it.effect("preserves null personality in next settings instead of consulting defaults", () =>
  Effect.gen(function* () {
    const canonical = produce(state, (draft) => {
      draft.hydrationContext!.latestThreadSettings = { personality: null };
    });
    const plan = yield* prepare(
      { originalRequest: { threadId, input: [] } },
      { canonical, defaultPersonality: "friendly" },
    );
    assert.strictEqual(plan.request.personality, null);
    assert.strictEqual(plan.canonicalParams?.personality, null);
  }),
);

for (const [config, expected] of [
  [{ personality: "pragmatic", model_personality: "none" }, "pragmatic"],
  [{ personality: "invalid", model_personality: "none" }, "none"],
  [{ personality: null, model_personality: "invalid" }, "friendly"],
] as const) {
  it.effect(`resolves workspace personality configuration ${JSON.stringify(config)}`, () =>
    Effect.gen(function* () {
      const requests: NonNullable<PreparationFixture["requests"]> = [];
      const plan = yield* prepare(
        {
          originalRequest: { threadId, input: [], cwd: "/workspace/selected" },
          originalContext: { inheritThreadSettings: false },
        },
        { config, defaultPersonality: "friendly", requests },
      );
      assert.strictEqual(plan.request.personality, expected);
      assert.strictEqual(plan.canonicalParams?.personality, expected);
      assert.deepEqual(requests, [
        {
          threadId,
          method: "config/read",
          params: { cwd: "/workspace/project", includeLayers: false },
          options: { priority: "critical" },
        },
      ]);
    }),
  );
}

it.effect("uses the application personality when workspace configuration omits one", () =>
  Effect.gen(function* () {
    const plan = yield* prepare(
      {
        originalRequest: { threadId, input: [] },
        originalContext: { inheritThreadSettings: false },
      },
      {
        config: {},
        defaultPersonality: "pragmatic",
      },
    );
    assert.strictEqual(plan.request.personality, "pragmatic");
    assert.strictEqual(plan.canonicalParams?.personality, "pragmatic");
  }),
);

it.effect(
  "falls back to the application personality when workspace configuration is unavailable",
  () =>
    Effect.gen(function* () {
      const plan = yield* prepare(
        {
          originalRequest: { threadId, input: [] },
          originalContext: { inheritThreadSettings: false },
        },
        {
          defaultPersonality: "friendly",
          configFailure: codexRuntimeError({
            operation: "configuration",
            reason: "request",
            retryable: false,
          }),
        },
      );
      assert.strictEqual(plan.request.personality, "friendly");
    }),
);

it.effect("does not read workspace defaults for an explicit personality reset", () =>
  Effect.gen(function* () {
    const requests: NonNullable<PreparationFixture["requests"]> = [];
    const plan = yield* prepare(
      { originalRequest: { threadId, input: [], personality: null } },
      { config: { personality: "friendly" }, requests },
    );
    assert.strictEqual(plan.request.personality, null);
    assert.deepEqual(requests, []);
  }),
);

for (const caller of ["main", "peer"] as const) {
  it.effect(`retains complete conversation execution settings for a ${caller} start`, () =>
    Effect.gen(function* () {
      const collaborationMode: NonNullable<TurnStartParams["collaborationMode"]> = {
        mode: "plan",
        settings: {
          model: "planning-model",
          reasoning_effort: "high",
          developer_instructions: "Retain the selected planning instructions",
        },
      };
      const canonical = produce(state, (draft) => {
        draft.latestModel = "retained-model";
        draft.latestReasoningEffort = "high";
        draft.latestCollaborationMode = collaborationMode;
        draft.latestThreadSettings = null;
        draft.hydrationContext!.latestThreadSettings = null;
      });
      const plan = yield* prepare(
        caller === "peer" ? { originalRequest: { threadId, input: [] } } : {},
        { canonical },
      );
      assert.strictEqual(plan.request.model, "retained-model");
      assert.strictEqual(plan.request.effort, "high");
      assert.deepEqual(plan.request.collaborationMode, collaborationMode);
      assert.deepEqual(plan.canonicalParams?.collaborationMode, collaborationMode);
      assert.strictEqual(plan.request.multiAgentMode, "explicitRequestOnly");
    }),
  );
}

it.effect(
  "keeps an explicit null effort in next settings and preserves collaboration instructions",
  () =>
    Effect.gen(function* () {
      const canonical = produce(state, (draft) => {
        draft.latestReasoningEffort = "high";
        draft.hydrationContext!.latestThreadSettings = { effort: null };
        draft.latestCollaborationMode.settings.developer_instructions = "Retained instructions";
      });
      const plan = yield* prepare(
        { originalRequest: { threadId, input: [], model: "new-model" } },
        { canonical },
      );
      assert.strictEqual(plan.request.model, "new-model");
      assert.strictEqual(plan.request.effort, null);
      assert.strictEqual(plan.canonicalParams?.effort, null);
      assert.deepEqual(plan.request.collaborationMode, canonical.latestCollaborationMode);
    }),
);

it.effect("preserves a Main caller's explicit summary reset", () =>
  Effect.gen(function* () {
    const plan = yield* prepare({ overrides: { summary: null } });
    assert.strictEqual(plan.request.summary, null);
    assert.strictEqual(plan.canonicalParams?.summary, null);
  }),
);

for (const metadata of [undefined, null, {}, { source: "composer", workspace_kind: "stale" }]) {
  it.effect(
    `retains caller metadata ${JSON.stringify(metadata)} independently of execution metadata`,
    () =>
      Effect.gen(function* () {
        const plan = yield* prepare({
          originalRequest: { threadId, input: [], responsesapiClientMetadata: metadata },
        });
        assert.deepEqual(plan.request.responsesapiClientMetadata, {
          ...metadata,
          workspace_kind: "project",
        });
        assert.deepEqual(plan.canonicalParams?.responsesapiClientMetadata, metadata);
        assert.strictEqual(
          Object.hasOwn(plan.canonicalParams!, "responsesapiClientMetadata"),
          metadata !== undefined,
        );
      }),
  );
}

const inheritedDefaults: CodexCanonicalConversationState = {
  ...state,
  turns: [
    { ...state.turns[0]!, params: liveParams() },
    {
      ...state.turns[0]!,
      turnId: null,
      params: liveParams({}),
    },
  ],
};

it.effect("uses the committed cwd and retains requested roots from the same path family", () =>
  Effect.gen(function* () {
    const plan = yield* prepare({
      originalRequest: {
        threadId,
        input: [],
        cwd: "/workspace/captured",
        permissions: "other-profile",
        runtimeWorkspaceRoots: ["/workspace/captured", "C:\\unrelated"],
      },
    });
    assert.strictEqual(plan.request.cwd, "/workspace/project");
    assert.strictEqual(plan.canonicalParams?.cwd, "/workspace/project");
    assert.deepEqual(plan.request.runtimeWorkspaceRoots, [
      "/workspace/captured",
      "/workspace/project",
    ]);
    assert.deepEqual(plan.permissions?.activePermissionProfile, {
      id: ":danger-full-access",
      extends: null,
    });
  }),
);

it.effect.each([null, "priority", "default", "standard"] as const)(
  "preserves captured native service tier %s through preparation",
  (serviceTier) =>
    Effect.gen(function* () {
      const requests: NonNullable<PreparationFixture["requests"]> = [];
      const plan = yield* prepare(
        { originalRequest: { threadId, input: [], serviceTier } },
        { requests },
      );
      assert.strictEqual(plan.request.serviceTier, serviceTier);
      assert.strictEqual(plan.canonicalParams?.serviceTier, serviceTier);
      assert.deepEqual(
        requests.filter((request) => request.method === "configRequirements/read"),
        serviceTier === null
          ? []
          : [
              {
                threadId,
                method: "configRequirements/read",
                params: undefined,
                options: { priority: "critical", timeoutMs: 30_000 },
              },
            ],
      );
    }),
);

it.effect.each([null, "priority"] as const)(
  "inherits the latest assigned service tier %s",
  (serviceTier) =>
    Effect.gen(function* () {
      const canonical: CodexCanonicalConversationState = {
        ...inheritedDefaults,
        turns: [
          { ...inheritedDefaults.turns[0]!, params: liveParams({ serviceTier }) },
          {
            ...inheritedDefaults.turns[1]!,
            params: liveParams({ serviceTier: "optimistic-tier" }),
          },
        ],
      };
      const plan = yield* prepare({ originalRequest: { threadId, input: [] } }, { canonical });
      assert.strictEqual(plan.request.serviceTier, serviceTier);
      const disabled = yield* prepare(
        {
          originalRequest: { threadId, input: [] },
          originalContext: { inheritThreadSettings: false },
        },
        { canonical },
      );
      assert.strictEqual(disabled.request.serviceTier, null);
    }),
);

it.effect.each(["managed-disabled", "requirements-failed"] as const)(
  "uses a default tier when %s",
  (reason) =>
    Effect.gen(function* () {
      const requirements: PreparationFixture["requirements"] =
        reason === "requirements-failed"
          ? Effect.fail(
              codexRuntimeError({ operation: "requirements", reason: "request", retryable: false }),
            )
          : Effect.succeed(disabledFastMode);
      const plan = yield* prepare(
        { originalRequest: { threadId, input: [], serviceTier: "priority" } },
        { requirements },
      );
      assert.strictEqual(plan.request.serviceTier, null);
      assert.strictEqual(plan.canonicalParams?.serviceTier, null);
    }),
);
