import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { describe, expect, test } from "vite-plus/test";
import type { CodexScheduledAutomation, CodexTranscriptEntry } from "../../shared/types";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { CodexHeartbeatTurnCompletion } from "../codex-application/CodexHeartbeatTurnCompletion";
import { CodexHistoryPageAdapter } from "../codex-application/CodexHistoryPageAdapter";
import { CodexPermissions } from "../codex-application/CodexPermissions";
import { CodexRendererConversationRegistry } from "../codex-application/CodexRendererConversationRegistry";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { ThreadCreationRuntime } from "../codex-application/ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "../codex-application/ThreadCreationRuntime.test-support";
import { CodexThreadSettingsRuntime } from "../codex-application/CodexThreadSettingsRuntime";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { ComposerCatalog } from "../codex-application/ComposerCatalog";
import { CodexConversations } from "../codex-application/CodexConversations";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRetentionRuntime } from "../codex-application/ManagedWorktreeRetentionRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AutomationApplication } from "./AutomationApplication";
import {
  AutomationExecution,
  live,
  resolveAutomationArchiveMessagesFromTranscript,
} from "./AutomationExecution";

const entry = (
  itemId: string,
  kind: "userMessage" | "assistantMessage",
  input: Partial<CodexTranscriptEntry>,
): CodexTranscriptEntry =>
  ({
    threadId: "thread-automation",
    turnId: "turn-automation",
    itemId,
    type: kind,
    kind,
    source: "live",
    createdAt: 1,
    ...input,
  }) as CodexTranscriptEntry;

const capability = {
  hostId: "local",
  generation: 1,
  userAgent: "codex-app-server/0.145.0-alpha.15",
  version: "0.145.0-alpha.15",
  flags: {
    forkLastTurnId: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: false,
    multiAgentV2Protocol: false,
    sideConversation: false,
    subagentAncestorFilter: false,
    threadRevert: false,
  },
} satisfies CodexAppServerCapabilitySnapshot;

const capabilities = CodexAppServerCapabilities.of({
  forHost: () => Effect.succeed(capability),
  forThread: () => Effect.succeed(capability),
  isCurrent: () => Effect.succeed(true),
});

const buildExecutionContext = (
  scope: Scope.Scope,
  input: {
    readonly automation?: AutomationApplication["Service"];
    readonly capabilities?: CodexAppServerCapabilities["Service"];
    readonly composer?: ComposerCatalog["Service"];
    readonly conversations?: CodexConversations["Service"];
    readonly desktopTools?: DesktopToolRuntime["Service"];
    readonly directory?: CodexThreadDirectory["Service"];
    readonly gateway?: CodexGateway["Service"];
    readonly historyPages?: CodexHistoryPageAdapter["Service"];
    readonly rendererConversations?: CodexRendererConversationRegistry["Service"];
    readonly workspace?: ProjectWorkspace["Service"];
  } = {},
) =>
  Layer.buildWithScope(
    live({ runtimeStateHome: "/tmp/nodex-test", runtimeVersion: "test" }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            AutomationApplication,
            input.automation ?? ({} as AutomationApplication["Service"]),
          ),
          Layer.succeed(CodexApplicationEventHub, {} as CodexApplicationEventHub["Service"]),
          Layer.succeed(CodexAppServerCapabilities, input.capabilities ?? capabilities),
          Layer.succeed(
            CodexGateway,
            input.gateway ?? ({ localHostId: "local" } as CodexGateway["Service"]),
          ),
          Layer.succeed(CodexGitProbe, {} as CodexGitProbe["Service"]),
          Layer.succeed(
            CodexHeartbeatTurnCompletion,
            {} as CodexHeartbeatTurnCompletion["Service"],
          ),
          Layer.succeed(
            CodexHistoryPageAdapter,
            input.historyPages ?? ({} as CodexHistoryPageAdapter["Service"]),
          ),
          Layer.succeed(CodexPermissions, {} as CodexPermissions["Service"]),
          Layer.succeed(
            CodexRendererConversationRegistry,
            input.rendererConversations ?? ({} as CodexRendererConversationRegistry["Service"]),
          ),
          Layer.succeed(
            CodexThreadDirectory,
            input.directory ?? ({} as CodexThreadDirectory["Service"]),
          ),
          Layer.succeed(ThreadCreationRuntime, transparentThreadCreationRuntime),
          Layer.succeed(CodexThreadSettingsRuntime, {} as CodexThreadSettingsRuntime["Service"]),
          Layer.succeed(CodexThreadTitlePersistence, {} as CodexThreadTitlePersistence["Service"]),
          Layer.succeed(CodexTurnAuthority, {} as CodexTurnAuthority["Service"]),
          Layer.succeed(CodexTurnCommands, {} as CodexTurnCommands["Service"]),
          Layer.succeed(ComposerCatalog, input.composer ?? ({} as ComposerCatalog["Service"])),
          Layer.succeed(
            CodexConversations,
            input.conversations ?? ({} as CodexConversations["Service"]),
          ),
          Layer.succeed(
            DesktopToolRuntime,
            input.desktopTools ?? ({} as DesktopToolRuntime["Service"]),
          ),
          Layer.succeed(ExecutionHostRuntime, {} as ExecutionHostRuntime["Service"]),
          mainConfigLayer(),
          Layer.succeed(
            ManagedWorktreeRetentionRuntime,
            {} as ManagedWorktreeRetentionRuntime["Service"],
          ),
          Layer.succeed(ManagedWorktreeRuntime, {} as ManagedWorktreeRuntime["Service"]),
          Layer.succeed(
            ProjectWorkspace,
            input.workspace ??
              ({
                getThread: (threadId: string) =>
                  Effect.succeed({
                    threadId,
                    backendBinding: { kind: "codex" },
                  } as never),
              } as unknown as ProjectWorkspace["Service"]),
          ),
        ),
      ),
    ),
    scope,
  );

describe("Automation archive projection", () => {
  test("captures the latest semantic exchange and removes app-only directives", () => {
    const messages = resolveAutomationArchiveMessagesFromTranscript([
      entry("user-old", "userMessage", { markdownText: "old request" }),
      entry("assistant-old", "assistantMessage", { markdownText: "old response" }),
      entry("user-latest", "userMessage", {
        markdownText: "fallback text",
        rawItem: {
          content: [
            { type: "text", text: "latest request" },
            { type: "skill", name: "research", path: "/skills/research" },
          ],
        },
      }),
      entry("assistant-latest", "assistantMessage", {
        markdownText: "latest response\n::automation-result{status=complete}",
      }),
    ]);

    expect(messages).toEqual({
      archivedUserMessage: "latest request\nskill: research (/skills/research)",
      archivedAssistantMessage: "latest response",
    });
  });
});

it.effect("run-now enters the scoped execution capability after runtime readiness", () =>
  Effect.gen(function* () {
    let gatewayReady = 0;
    const scope = yield* Scope.make();
    const definition = {
      id: "automation-run-now",
      definitionRevision: 1,
      kind: "cron",
      status: "ACTIVE",
      targetThreadId: null,
      name: "Run now",
      prompt: "Run.",
      rrule: "FREQ=DAILY",
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      backendBinding: { kind: "codex" },
      cwds: [],
      executionEnvironment: "local",
      localEnvironmentConfigPath: null,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const context = yield* buildExecutionContext(scope, {
      automation: {
        definitions: { get: () => Effect.succeed(definition) },
      } as unknown as AutomationApplication["Service"],
      gateway: {
        localHostId: "local",
        awaitReady: () =>
          Effect.sync(() => {
            gatewayReady += 1;
          }),
      } as unknown as CodexGateway["Service"],
    });

    yield* Context.get(context, AutomationExecution).runNow({ id: definition.id });
    assert.strictEqual(gatewayReady, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

const heartbeatDefinition = {
  id: "automation-heartbeat",
  definitionRevision: 1,
  kind: "heartbeat",
  status: "ACTIVE",
  targetThreadId: "thread-heartbeat",
  name: "Heartbeat",
  prompt: "Continue.",
  rrule: "FREQ=MINUTELY",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  backendBinding: { kind: "codex" },
  cwds: [],
  executionEnvironment: "local",
  localEnvironmentConfigPath: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 1,
  updatedAt: 1,
} as const satisfies CodexScheduledAutomation;

const heartbeatContext = {
  now: 1_000_000,
  reason: "scheduled",
  leaseId: "lease-heartbeat",
  heartbeat: {
    automationsEnabled: true,
    rendererState: {
      rendererClientId: "renderer-owner",
      isEligible: true,
      reason: null,
      updatedAtMs: 1_000_000,
    },
    collaborationMode: {
      mode: "default",
      settings: {
        model: "",
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
    permissions: { approvalPolicy: "never" },
  },
} as const;

it.effect("rejects unsupported Automation backends during preparation and execution", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let modelReads = 0;
    let gatewayReady = 0;
    const context = yield* buildExecutionContext(scope, {
      composer: {
        listModels: Effect.sync(() => {
          modelReads += 1;
          return [];
        }),
      } as unknown as ComposerCatalog["Service"],
      gateway: {
        localHostId: "local",
        awaitReady: () =>
          Effect.sync(() => {
            gatewayReady += 1;
          }),
      } as unknown as CodexGateway["Service"],
    });
    const execution = Context.get(context, AutomationExecution);
    const backendBinding = {
      kind: "acp",
      agentDefinitionId: "claude-agent-acp",
      instanceConfigId: "claude:default",
    } as const;

    const preparationError = yield* Effect.flip(
      execution.prepareDefinition({
        kind: "cron",
        name: "Unsupported",
        prompt: "Do not run.",
        backendBinding,
      }),
    );
    assert.strictEqual(preparationError.operation, "prepare-definition");
    assert.match(String(preparationError.cause), /only the Codex Agent Backend/);
    assert.strictEqual(modelReads, 0);

    const executionError = yield* Effect.flip(
      execution.executeClaimed({ ...heartbeatDefinition, backendBinding }, heartbeatContext),
    );
    assert.strictEqual(executionError.operation, "execute");
    assert.match(String(executionError.cause), /only the Codex Agent Backend/);
    assert.strictEqual(gatewayReady, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects an ACP-owned heartbeat target before any Codex runtime access", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let gatewayReady = 0;
    let directoryReads = 0;
    let modelReads = 0;
    const context = yield* buildExecutionContext(scope, {
      composer: {
        listModels: Effect.sync(() => {
          modelReads += 1;
          return [];
        }),
      } as unknown as ComposerCatalog["Service"],
      directory: {
        resolve: () =>
          Effect.sync(() => {
            directoryReads += 1;
            return heartbeatDirectoryEntry;
          }),
      } as unknown as CodexThreadDirectory["Service"],
      gateway: {
        localHostId: "local",
        awaitReady: () =>
          Effect.sync(() => {
            gatewayReady += 1;
          }),
      } as unknown as CodexGateway["Service"],
      workspace: {
        getThread: (threadId: string) =>
          Effect.succeed({
            threadId,
            backendBinding: {
              kind: "acp",
              agentDefinitionId: "claude-agent-acp",
              instanceConfigId: "claude:default",
            },
          } as never),
      } as unknown as ProjectWorkspace["Service"],
    });
    const execution = Context.get(context, AutomationExecution);

    const preparationError = yield* Effect.flip(
      execution.prepareDefinition({
        kind: "heartbeat",
        targetThreadId: heartbeatDefinition.targetThreadId,
        name: "Foreign target",
        prompt: "Do not run.",
      }),
    );
    assert.strictEqual(preparationError.operation, "prepare-definition");
    assert.match(String(preparationError.cause), /not owned by the Codex Agent Backend/);

    const executionError = yield* Effect.flip(
      execution.executeClaimed(heartbeatDefinition, heartbeatContext),
    );
    assert.strictEqual(executionError.operation, "execute");
    assert.match(String(executionError.cause), /not owned by the Codex Agent Backend/);
    assert.strictEqual(modelReads, 0);
    assert.strictEqual(gatewayReady, 0);
    assert.strictEqual(directoryReads, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

const heartbeatDirectoryEntry = {
  durable: {
    threadId: "thread-heartbeat",
    executionHostId: "local",
    projectId: null,
    cwd: "/tmp/heartbeat",
    statusType: "notLoaded",
    statusActiveFlags: [],
    updatedAt: 1,
    executionProfile: null,
  },
} as never;

it.effect("does not observe heartbeat metadata returned by a replaced host generation", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let current = true;
    let observed = 0;
    const methods: string[] = [];
    const scheduling: unknown[] = [];
    const context = yield* buildExecutionContext(scope, {
      capabilities: CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: () => Effect.sync(() => current),
      }),
      directory: {
        resolve: () => Effect.succeed(heartbeatDirectoryEntry),
        observeMetadata: () =>
          Effect.sync(() => {
            observed += 1;
            return heartbeatDirectoryEntry;
          }),
      } as unknown as CodexThreadDirectory["Service"],
      gateway: {
        localHostId: "local",
        awaitReady: () => Effect.void,
        requestOnHost: (_hostId: string, method: string, _params: unknown, options?: unknown) =>
          Effect.sync(() => {
            methods.push(method);
            scheduling.push(options);
            current = false;
            return { thread: { id: "thread-heartbeat", path: "/tmp/rollout.jsonl" } };
          }) as never,
      } as unknown as CodexGateway["Service"],
    });

    const exit = yield* Effect.exit(
      Context.get(context, AutomationExecution).executeClaimed(
        heartbeatDefinition,
        heartbeatContext,
      ),
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(methods, ["thread/read"]);
    assert.deepStrictEqual(scheduling, [{ expectedHostId: "local", expectedGeneration: 1 }]);
    assert.strictEqual(observed, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not accept heartbeat resume metadata from a replaced host generation", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let current = true;
    let acceptedResumes = 0;
    const methods: string[] = [];
    const scheduling: unknown[] = [];
    const context = yield* buildExecutionContext(scope, {
      capabilities: CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: () => Effect.sync(() => current),
      }),
      desktopTools: {
        threadConfig: Effect.succeed(null),
      } as unknown as DesktopToolRuntime["Service"],
      directory: {
        resolve: () => Effect.succeed(heartbeatDirectoryEntry),
        observeMetadata: () => Effect.succeed(heartbeatDirectoryEntry),
        acceptResumeResult: () =>
          Effect.sync(() => {
            acceptedResumes += 1;
            return heartbeatDirectoryEntry;
          }),
      } as unknown as CodexThreadDirectory["Service"],
      gateway: {
        localHostId: "local",
        awaitReady: () => Effect.void,
        requestOnHost: (_hostId: string, method: string, _params: unknown, options?: unknown) =>
          Effect.sync(() => {
            methods.push(method);
            scheduling.push(options);
            if (method === "thread/resume") current = false;
            return method === "thread/read"
              ? { thread: { id: "thread-heartbeat", path: "/tmp/rollout.jsonl" } }
              : { thread: { id: "thread-heartbeat" } };
          }) as never,
      } as unknown as CodexGateway["Service"],
      rendererConversations: {
        getOwnerClientId: () => "renderer-owner",
      } as unknown as CodexRendererConversationRegistry["Service"],
    });

    const exit = yield* Effect.exit(
      Context.get(context, AutomationExecution).executeClaimed(
        heartbeatDefinition,
        heartbeatContext,
      ),
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(methods, ["thread/read", "thread/resume"]);
    assert.deepStrictEqual(scheduling, [
      { expectedHostId: "local", expectedGeneration: 1 },
      { expectedHostId: "local", expectedGeneration: 1 },
    ]);
    assert.strictEqual(acceptedResumes, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fills a missing local Automation archive side through bounded history", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const itemLimits: number[] = [];
    const context = yield* buildExecutionContext(scope, {
      conversations: {
        read: () =>
          ({
            snapshot: {
              turns: [
                {
                  items: [
                    entry("assistant-local", "assistantMessage", {
                      markdownText: "latest local response",
                    }),
                  ],
                },
              ],
            },
          }) as unknown as ReturnType<CodexConversations["Service"]["read"]>,
      } as unknown as CodexConversations["Service"],
      historyPages: CodexHistoryPageAdapter.of({
        loadTurnPage: () =>
          Effect.succeed({
            turns: [
              {
                id: "turn-latest",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
            itemsPaginationByTurnId: {},
            itemSegmentsByTurnId: {},
            loadedItemCount: 0,
          }),
        loadTurnItemsPage: (input) =>
          Effect.sync(() => {
            itemLimits.push(input.limit ?? 0);
            return {
              items: [
                {
                  type: "userMessage",
                  id: "user-latest",
                  clientId: null,
                  content: [{ type: "text", text: "latest request", text_elements: [] }],
                },
                {
                  questions: null,
                  type: "agentMessage",
                  id: "assistant-latest",
                  text: "older history response",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
              approximateBytes: 4_096,
            };
          }),
      }),
    });

    const messages = yield* Context.get(context, AutomationExecution).resolveArchiveMessages(
      "thread-automation",
    );
    assert.deepStrictEqual(messages, {
      archivedUserMessage: "latest request",
      archivedAssistantMessage: "latest local response",
    });
    assert.deepStrictEqual(itemLimits, [100]);
    yield* Scope.close(scope, Exit.void);
  }),
);
