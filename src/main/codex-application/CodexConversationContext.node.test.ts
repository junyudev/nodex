import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { make as makeConversationContext } from "./CodexConversationContext";
import type { ConversationEntityState } from "./internal/ConversationEntityState";
import {
  ConversationEntityMap,
  live as conversationEntityMapLive,
} from "./internal/ConversationEntityMap";

const canonicalDocument = (
  id: string,
  overrides: Partial<CodexCanonicalConversationState> = {},
): CodexCanonicalConversationState => ({
  id,
  hostId: "local",
  sessionId: `session-${id}`,
  ephemeral: true,
  forkedFromId: null,
  parentThreadId: null,
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  title: null,
  latestModel: "gpt-context",
  latestReasoningEffort: null,
  latestCollaborationMode: {
    mode: "default",
    settings: { model: "gpt-context", reasoning_effort: null, developer_instructions: null },
  },
  threadRuntimeStatus: { type: "idle" },
  rolloutPath: "",
  cwd: "/repo/canonical",
  gitInfo: null,
  resumeState: "resumed",
  hasUnreadTurn: false,
  hydrationContext: null,
  turns: [],
  requests: [],
  ...overrides,
});

interface DurableContextFixture {
  readonly project_id: string | null;
  readonly parent_thread_id: string | null;
  readonly cwd: string | null;
}

const makeContextHarness = (
  durable: Readonly<Record<string, DurableContextFixture>> = {},
  beforeRead: (threadId: string) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(conversationEntityMapLive);
    const conversations = Context.get(services, ConversationEntityMap);
    const workspace: CoreModuleClients["workspace"] = {
      read: (query) => {
        if (query.kind !== "thread") return Effect.fail(notFound(query.kind));
        return beforeRead(query.thread_id).pipe(
          Effect.andThen(
            durable[query.thread_id]
              ? Effect.succeed({
                  value: {
                    kind: "thread",
                    thread: { thread_id: query.thread_id, ...durable[query.thread_id] },
                  },
                } as never)
              : Effect.fail(notFound(query.kind)),
          ),
        );
      },
      apply: () => Effect.die("unused"),
    };
    const context = yield* makeConversationContext.pipe(
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(CoreModules, CoreModules.of({ workspace } as CoreModuleClients)),
    );
    return { context, conversations };
  });

const notFound = (kind: string) =>
  new CoreRuntimeError({
    message: `Missing ${kind}`,
    operation: `workspace:${kind}`,
    reason: "operation",
    retryable: false,
    cause: new CoreModuleResponseError({
      code: "not_found",
      message: `Missing ${kind}`,
      retryable: false,
      recovery: { kind: "none" },
    }),
  });

it.effect(
  "inherits ephemeral Side Chat lineage and execution context from the live aggregate",
  () =>
    Effect.gen(function* () {
      const childSnapshot = {
        threadId: "side-chat",
        ephemeral: true,
        projectId: "project-a",
        cwd: "/repo/side-chat",
        source: { parentThreadId: "parent-thread" },
      } as unknown as CodexConversationSnapshot;
      const childCanonical = {
        hydrationContext: {
          cwd: "/repo/side-chat",
        },
        currentPermissions: { runtimeWorkspaceRoots: ["/repo/side-chat"] },
      } as unknown as CodexCanonicalConversationState;
      const aggregate = (
        snapshot: CodexConversationSnapshot,
        canonical: CodexCanonicalConversationState,
      ) =>
        ({
          readSnapshot: () => snapshot,
          readCanonicalState: () => canonical,
        }) as unknown as ConversationEntityState;
      const conversations = ConversationEntityMap.of({
        registerThreadMetadata: () => {},
        readThreadMetadata: () => null,
        current: (threadId: string) =>
          threadId === "side-chat"
            ? aggregate(childSnapshot, childCanonical)
            : threadId === "parent-thread"
              ? aggregate(
                  {
                    threadId,
                    ephemeral: false,
                    projectId: "project-a",
                    source: { parentThreadId: null },
                  } as unknown as CodexConversationSnapshot,
                  {} as CodexCanonicalConversationState,
                )
              : null,
      } as unknown as ConversationEntityMap["Service"]);
      const workspace: CoreModuleClients["workspace"] = {
        read: (read) => {
          if (read.kind === "thread" && read.thread_id === "parent-thread") {
            return Effect.succeed({
              value: {
                kind: "thread",
                thread: {
                  thread_id: "parent-thread",
                  project_id: "project-a",
                  parent_thread_id: null,
                  cwd: "/repo/parent",
                },
              },
            } as never);
          }
          return Effect.fail(notFound(read.kind));
        },
        apply: () => Effect.die("unused"),
      };
      const context = yield* makeConversationContext.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CoreModules,
          CoreModules.of({ workspace } as unknown as CoreModuleClients),
        ),
      );

      assert.deepEqual(yield* context.read("side-chat"), {
        threadId: "side-chat",
        parentThreadId: "parent-thread",
        rootThreadId: "parent-thread",
        projectId: "project-a",
        cwd: "/repo/side-chat",
        writableRoots: ["/repo/side-chat"],
      });
    }),
);

it.effect("resolves canonical-only side-chat lineage without materializing a presentation", () =>
  Effect.gen(function* () {
    const { context, conversations } = yield* makeContextHarness({
      root: { project_id: "root-project", parent_thread_id: null, cwd: "/repo/root" },
    });
    const side = conversations.entity("side");
    side.installFollowerCanonicalState(
      canonicalDocument("side", { sideConversation: true, forkedFromId: "middle" }),
    );
    conversations.entity("middle").installFollowerCanonicalState(
      canonicalDocument("middle", {
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "root",
              depth: 1,
              agent_path: null,
              agent_nickname: null,
              agent_role: null,
            },
          },
        },
      }),
    );

    assert.deepEqual(yield* context.read("side"), {
      threadId: "side",
      parentThreadId: "middle",
      rootThreadId: "root",
      projectId: "root-project",
      cwd: "/repo/canonical",
      writableRoots: ["/repo/canonical"],
    });
    assert.isNull(side.readSnapshot());
    assert.isNull(conversations.current("middle")?.readSnapshot());
  }),
);

it.effect.each(["canonical", "presentation", "durable"] as const)(
  "preserves an explicit projectless assignment from %s instead of inheriting an ancestor",
  (source) =>
    Effect.gen(function* () {
      const { context, conversations } = yield* makeContextHarness({
        root: { project_id: "root-project", parent_thread_id: null, cwd: "/repo/root" },
        ...(source === "durable"
          ? { child: { project_id: null, parent_thread_id: "root", cwd: "/repo/durable" } }
          : {}),
      });
      const child = conversations.entity("child");
      if (source === "presentation") {
        child.installSnapshot({
          threadId: "child",
          ephemeral: true,
          projectId: null,
          cwd: "/repo/child",
          source: { parentThreadId: "root" },
        } as CodexConversationSnapshot);
      } else {
        child.installFollowerCanonicalState(
          canonicalDocument("child", {
            ephemeral: source !== "durable",
            parentThreadId: "root",
            ...(source === "canonical" ? { workspaceKind: "projectless" } : {}),
          }),
        );
      }

      const result = yield* context.read("child");
      assert.strictEqual(result.parentThreadId, "root");
      assert.strictEqual(result.rootThreadId, "root");
      assert.isNull(result.projectId);
      assert.strictEqual(
        result.cwd,
        source === "durable"
          ? "/repo/durable"
          : source === "presentation"
            ? "/repo/child"
            : "/repo/canonical",
      );
    }),
);

it.effect.each([true, false])(
  "distinguishes a side-chat parent from native subagent ancestry (side: %s)",
  (sideConversation) =>
    Effect.gen(function* () {
      const { context, conversations } = yield* makeContextHarness({
        origin: { project_id: "origin-project", parent_thread_id: null, cwd: "/repo/origin" },
        ancestor: { project_id: "ancestor-project", parent_thread_id: null, cwd: "/repo/ancestor" },
      });
      conversations.entity("child").installFollowerCanonicalState(
        canonicalDocument("child", {
          sideConversation,
          forkedFromId: "origin",
          parentThreadId: "ancestor",
        }),
      );
      const result = yield* context.read("child");
      assert.strictEqual(result.parentThreadId, sideConversation ? "origin" : "ancestor");
      assert.strictEqual(result.rootThreadId, sideConversation ? "origin" : "ancestor");
      assert.strictEqual(
        result.projectId,
        sideConversation ? "origin-project" : "ancestor-project",
      );
      assert.strictEqual(
        conversations.current("child")?.readCanonicalState()?.parentThreadId,
        "ancestor",
      );
    }),
);

it.effect("keeps an explicit durable root separate from stale live lineage", () =>
  Effect.gen(function* () {
    const { context, conversations } = yield* makeContextHarness({
      child: { project_id: null, parent_thread_id: null, cwd: "/repo/durable" },
      stale: { project_id: "stale-project", parent_thread_id: null, cwd: "/repo/stale" },
    });
    conversations
      .entity("child")
      .installFollowerCanonicalState(
        canonicalDocument("child", { ephemeral: false, parentThreadId: "stale" }),
      );
    const result = yield* context.read("child");
    assert.isNull(result.parentThreadId);
    assert.strictEqual(result.rootThreadId, "child");
    assert.isNull(result.projectId);
    assert.strictEqual(result.cwd, "/repo/durable");
  }),
);

it.effect("rejects lineage read from a generation retired during an ancestor lookup", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { context, conversations } = yield* makeContextHarness(
      { root: { project_id: "root-project", parent_thread_id: null, cwd: "/repo/root" } },
      (threadId) =>
        threadId === "root"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
    );
    conversations
      .entity("child")
      .installFollowerCanonicalState(canonicalDocument("child", { parentThreadId: "root" }));
    const pending = yield* context.read("child").pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* conversations.retire("child");
    conversations
      .entity("child")
      .installFollowerCanonicalState(canonicalDocument("child", { cwd: "/repo/successor" }));
    yield* Deferred.succeed(release, undefined);

    const failure = yield* Fiber.join(pending).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "CodexConversationContextError");
    assert.include(String(failure.cause), "generation");
    assert.strictEqual(
      conversations.current("child")?.readCanonicalState()?.cwd,
      "/repo/successor",
    );
  }),
);
