import { assert, it } from "@effect/vitest";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  CodexApprovalRequest,
  CodexMcpServerElicitationRequest,
  CodexUserInputRequest,
} from "../../shared/types";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalTurnParams,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { reduceCodexConversationServerRequest } from "../../shared/codex-conversation-state/codex-server-request-lifecycle";
import {
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  buildAgentActivityV2CorpusThread,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import {
  agentActivityV2CommandApprovalRequest,
  agentActivityV2McpElicitationRequest,
  agentActivityV2UserInputRequest,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-request-family-corpus";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import {
  CodexPendingServerRequestRuntime,
  make as makeInbox,
} from "./CodexPendingServerRequestRuntime";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "./CodexRendererPresentationRegistry";
import { CodexThreadReadState } from "./CodexThreadReadState";
import {
  CodexUserInputAutoResolution,
  make as makeAutoResolution,
  USER_INPUT_AUTO_RESOLUTION_COUNTDOWN,
} from "./CodexUserInputAutoResolution";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";
import { make as makeResponses } from "./CodexServerRequestResponses";

interface Completion {
  readonly occurrenceToken: number;
  readonly response: unknown;
  readonly threadId: string;
  readonly trace?: {
    readonly traceparent?: string | null;
    readonly tracestate?: string | null;
  };
}

const turnParams = (threadId: string): CodexCanonicalTurnParams => ({
  threadId,
  input: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  model: "fixture-model",
  cwd: "/workspace/project",
  attachments: [],
  effort: "high",
  summary: "none",
  personality: null,
  outputSchema: null,
  collaborationMode: null,
});

const canonicalApproval = (threadId: string, requestId: string) => {
  const thread = {
    ...buildAgentActivityV2CorpusThread([]),
    id: threadId,
    turns: buildAgentActivityV2CorpusThread([]).turns.map((turn) => ({
      ...turn,
      id: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    })),
  };
  const initial = createCodexCanonicalConversationState(thread, {
    hostId: "local",
    ...{
      turnParamsById: { [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams(threadId) },
    },
  });
  const request = {
    ...agentActivityV2CommandApprovalRequest,
    id: requestId,
    params: {
      ...agentActivityV2CommandApprovalRequest.params,
      threadId,
      turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    },
  };
  return {
    state: reduceCodexConversationServerRequest(initial, request, { now: () => 1 }).state,
  };
};

const approvalView = (threadId: string, requestId: string): CodexApprovalRequest => ({
  type: "approval",
  requestId,
  kind: "command",
  projectId: "project-1",
  threadId,
  turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  itemId: `item-${requestId}`,
  createdAt: 1,
});

const canonicalUserInput = (threadId: string, requestId: string) => {
  const thread = {
    ...buildAgentActivityV2CorpusThread([]),
    id: threadId,
    turns: buildAgentActivityV2CorpusThread([]).turns.map((turn) => ({
      ...turn,
      id: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    })),
  };
  const initial = createCodexCanonicalConversationState(thread, {
    hostId: "local",
    ...{
      turnParamsById: { [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams(threadId) },
    },
  });
  return reduceCodexConversationServerRequest(
    initial,
    {
      ...agentActivityV2UserInputRequest,
      id: requestId,
      params: {
        ...agentActivityV2UserInputRequest.params,
        threadId,
        turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
      },
    },
    { now: () => 1 },
  ).state;
};

const userInputView = (threadId: string, requestId: string): CodexUserInputRequest => ({
  type: "userInput",
  requestId,
  projectId: "project-1",
  threadId,
  turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  itemId: `item-${requestId}`,
  questions: [],
  isBlocking: false,
  createdAt: 1,
});

const canonicalMcpElicitation = (threadId: string, requestId: string) => {
  const thread = {
    ...buildAgentActivityV2CorpusThread([]),
    id: threadId,
    turns: buildAgentActivityV2CorpusThread([]).turns.map((turn) => ({
      ...turn,
      id: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    })),
  };
  const initial = createCodexCanonicalConversationState(thread, {
    hostId: "local",
    turnParamsById: { [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams(threadId) },
  });
  return reduceCodexConversationServerRequest(
    initial,
    {
      ...agentActivityV2McpElicitationRequest,
      id: requestId,
      params: {
        ...agentActivityV2McpElicitationRequest.params,
        threadId,
        turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
      },
    },
    { now: () => 1 },
  ).state;
};

const mcpElicitationView = (
  threadId: string,
  requestId: string,
): CodexMcpServerElicitationRequest => ({
  type: "mcpServerElicitation",
  requestId,
  projectId: "project-1",
  threadId,
  turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  itemId: `mcp-server-elicitation-${requestId}`,
  kind: "generic",
  mode: "openai/form",
  serverName: "fixture_server",
  message: "Provide one sanitized fixture value.",
  requestedSchema: agentActivityV2McpElicitationRequest.params.requestedSchema,
  meta: agentActivityV2McpElicitationRequest.params._meta,
  createdAt: 1,
});

const makeGateway = (
  requestRawForThread: CodexGateway["Service"]["requestRawForThread"],
  connection: CodexGateway["Service"]["connection"],
): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    events: Stream.empty,
    requestLocal: unsupported,
    requestOnHost: unsupported,
    requestForThread: unsupported,
    requestRawForThread,
    notifyLocal: unsupported,
    connection,
    connectionChanges: () => Stream.empty,
    awaitReady: unsupported,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

const autoResolution = CodexUserInputAutoResolution.of({
  changes: Stream.empty,
  timeouts: Stream.empty,
  snapshot: Effect.succeed([]),
  observeRequest: () => Effect.void,
  observeResponse: () => Effect.void,
  observeServerResolution: () => Effect.void,
  reevaluatePresentation: () => Effect.void,
  recordActivity: () => Effect.void,
  snooze: () => Effect.succeed(false),
  clearConversation: () => Effect.void,
  reconcilePendingRequests: () => Effect.void,
  handleDisconnect: () => Effect.void,
});

const makeHarness = (
  requestRawForThread: CodexGateway["Service"]["requestRawForThread"] = () =>
    Effect.succeed(undefined),
  autoResolutionRuntime: CodexUserInputAutoResolution["Service"] = autoResolution,
  connection: CodexGateway["Service"]["connection"] = (hostId) =>
    Effect.succeed({ kind: "ready", hostId, generation: 1 }),
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const conversationContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
    const conversations = Context.get(conversationContext, ConversationEntityMap);
    const completions: Completion[] = [];
    const inbox = yield* makeInbox({
      abandon: (threadId, _requestId, occurrenceToken) =>
        Effect.sync(() => {
          completions.push({
            threadId,
            occurrenceToken,
            response: CodexAppServerNoResponse,
          });
          return true;
        }),
      respond: (threadId, _requestId, occurrenceToken, response, trace) =>
        Effect.sync(() => {
          completions.push({
            threadId,
            occurrenceToken,
            response,
            ...(trace == null ? {} : { trace }),
          });
          return true;
        }),
      reject: () => Effect.succeed(true),
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const emitted: CodexApplicationEvent[] = [];
    const responses = yield* makeResponses.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => emitted.push(event),
        }),
      ),
      Effect.provideService(CodexGateway, makeGateway(requestRawForThread, connection)),
      Effect.provideService(CodexPendingServerRequestRuntime, inbox),
      Effect.provideService(
        CodexThreadReadState,
        CodexThreadReadState.of({
          captureContext: () => Effect.succeed(null),
          getExecutionHostKeys: Effect.succeed({}),
          openSession: () => Effect.succeed({ status: "unavailable" }),
          set: () => Effect.succeed(false),
          persistProjected: () => Effect.void,
        }),
      ),
      Effect.provideService(CodexUserInputAutoResolution, autoResolutionRuntime),
      Effect.provideService(ConversationEntityMap, conversations),
    );
    return {
      completions,
      conversations,
      emitted,
      inbox,
      responses,
    };
  });

it.effect("commits one semantic response and releases duplicate physical occurrences", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = "thread-owner";
      const requestId = "approval-shared";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalApproval(threadId, requestId).state);
      aggregate.setStreamRole("owner");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView(threadId, requestId),
      });
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "approval",
        occurrenceToken: 2,
        request: approvalView(threadId, requestId),
      });

      assert.isTrue(
        yield* harness.responses.approval({
          threadId,
          requestId,
          response: { kind: "command", decision: "decline" },
        }),
      );
      yield* Effect.yieldNow;

      assert.deepEqual(
        harness.completions.map(({ occurrenceToken, response }) => ({
          occurrenceToken,
          response,
        })),
        [
          { occurrenceToken: 1, response: { decision: "decline" } },
          { occurrenceToken: 2, response: CodexAppServerNoResponse },
        ],
      );
      assert.strictEqual(aggregate.readServerRequests().length, 0);
      assert.deepEqual(harness.emitted, [
        {
          kind: "codex",
          value: { type: "approvalResolved", requestId, decision: "decline" },
        },
      ]);
    }),
  ),
);

it.effect("executes timed-out user input through the canonical response capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const autoResolutionRuntime = yield* makeAutoResolution.pipe(
        Effect.provideService(CodexRendererPresentationRegistry, yield* makePresentationRegistry),
      );
      const harness = yield* makeHarness(undefined, autoResolutionRuntime);
      const threadId = "thread-auto-resolution";
      const requestId = "user-input-timeout";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalUserInput(threadId, requestId));
      aggregate.setStreamRole("owner");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "user-input",
        occurrenceToken: 1,
        request: userInputView(threadId, requestId),
      });

      yield* autoResolutionRuntime.observeRequest(threadId, requestId, {
        hostId: "local",
        generation: 1,
      });
      yield* TestClock.adjust(USER_INPUT_AUTO_RESOLUTION_COUNTDOWN);
      yield* Effect.yieldNow;

      assert.strictEqual(aggregate.readServerRequests().length, 0);
      assert.deepEqual(harness.completions, [
        { threadId, occurrenceToken: 1, response: { answers: {} } },
      ]);
    }),
  ),
);

it.effect("executes timed-out MCP elicitation as an exact decline on the tracked generation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const autoResolutionRuntime = yield* makeAutoResolution.pipe(
        Effect.provideService(CodexRendererPresentationRegistry, yield* makePresentationRegistry),
      );
      const harness = yield* makeHarness(undefined, autoResolutionRuntime);
      const threadId = "thread-mcp-auto-resolution";
      const requestId = "mcp-timeout";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalMcpElicitation(threadId, requestId));
      aggregate.setStreamRole("owner");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "mcp-elicitation",
        occurrenceToken: 3,
        request: mcpElicitationView(threadId, requestId),
      });

      yield* autoResolutionRuntime.observeRequest(
        threadId,
        requestId,
        { hostId: "local", generation: 1 },
        { responseKind: "declineMcpElicitation", autoResolutionMs: 5_000 },
      );
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;

      assert.strictEqual(aggregate.readServerRequests().length, 0);
      assert.deepEqual(harness.completions, [
        {
          threadId,
          occurrenceToken: 3,
          response: { action: "decline", content: null, _meta: null },
        },
      ]);
    }),
  ),
);

it.effect("settles the exact native occurrence without materializing Main conversation state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = "thread-renderer-owner";
      const requestId = "native-input";
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "user-input",
        occurrenceToken: 2,
        request: userInputView(threadId, requestId),
      });
      const response = {
        hostId: "local",
        generation: 1,
        occurrenceId: "native-occurrence-2",
        occurrenceToken: 2,
        threadId,
        requestId,
        method: "item/tool/requestUserInput" as const,
        response: { answers: { answer: { answers: ["Continue"] } } },
        trace: {
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          tracestate: "vendor=value",
        },
      };
      assert.isFalse(yield* harness.responses.native({ ...response, occurrenceToken: 1 }));
      assert.isDefined(
        harness.inbox.find("user-input", requestId, (entry) => entry.threadId === threadId),
      );
      assert.deepEqual(harness.completions, []);
      assert.isTrue(yield* harness.responses.native(response));
      assert.isFalse(yield* harness.responses.native(response));
      yield* Effect.yieldNow;
      assert.deepEqual(harness.completions, [
        { threadId, occurrenceToken: 2, response: response.response, trace: response.trace },
      ]);
      assert.isUndefined(
        harness.inbox.find("user-input", requestId, (entry) => entry.threadId === threadId),
      );
      assert.isNull(harness.conversations.current(threadId));
      assert.deepEqual(harness.emitted, [
        { kind: "codex", value: { type: "userInputResolved", requestId } },
      ]);
    }),
  ),
);

it.effect("a native response only settles duplicates from its own host generation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = "moved-thread";
      const requestId = "reused-request";
      for (const source of [
        { hostId: "local", generation: 1, occurrenceToken: 1 },
        { hostId: "remote", generation: 1, occurrenceToken: 2 },
        { hostId: "local", generation: 2, occurrenceToken: 3 },
        { hostId: "local", generation: 1, occurrenceToken: 4 },
      ])
        harness.inbox.register({
          ...source,
          kind: "user-input",
          request: userInputView(threadId, requestId),
        });
      const response = {
        hostId: "local",
        generation: 1,
        occurrenceId: "old-request",
        occurrenceToken: 1,
        threadId,
        requestId,
        method: "item/tool/requestUserInput" as const,
        response: { answers: {} },
      };
      assert.isFalse(yield* harness.responses.native({ ...response, generation: 2 }));
      assert.isFalse(yield* harness.responses.native({ ...response, hostId: "remote" }));
      assert.isTrue(yield* harness.responses.native(response));
      yield* Effect.yieldNow;
      assert.deepEqual(
        harness.completions.map(({ occurrenceToken }) => occurrenceToken),
        [1, 4],
      );
      assert.strictEqual(
        harness.inbox.find("user-input", requestId, (entry) => entry.hostId === "remote")
          ?.occurrenceToken,
        2,
      );
      assert.strictEqual(
        harness.inbox.find("user-input", requestId, (entry) => entry.generation === 2)
          ?.occurrenceToken,
        3,
      );
    }),
  ),
);

it.effect("a timeout queued behind a command cannot answer a replacement native request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const timer = yield* makeAutoResolution.pipe(
        Effect.provideService(CodexRendererPresentationRegistry, yield* makePresentationRegistry),
      );
      let generation = 1;
      const checked = yield* Deferred.make<void>();
      const harness = yield* makeHarness(undefined, timer, (hostId) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(checked, undefined);
          return { kind: "ready" as const, hostId, generation };
        }),
      );
      const threadId = "reconnected-thread";
      const requestId = "same-request";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalUserInput(threadId, requestId));
      aggregate.setStreamRole("owner");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        occurrenceToken: 1,
        kind: "user-input",
        request: userInputView(threadId, requestId),
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const command = yield* harness.conversations
        .runCommand(
          threadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* timer.observeRequest(threadId, requestId, { hostId: "local", generation: 1 });
      yield* TestClock.adjust(USER_INPUT_AUTO_RESOLUTION_COUNTDOWN);
      generation = 2;
      harness.inbox.register({
        hostId: "local",
        generation,
        occurrenceToken: 2,
        kind: "user-input",
        request: userInputView(threadId, requestId),
      });
      yield* timer.observeRequest(threadId, requestId, { hostId: "local", generation });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(command);
      yield* Deferred.await(checked);
      yield* Effect.yieldNow;
      assert.deepEqual(harness.completions, []);
      assert.strictEqual(aggregate.readServerRequests().length, 1);
      assert.strictEqual(
        harness.inbox.find("user-input", requestId, (entry) => entry.generation === 2)
          ?.occurrenceToken,
        2,
      );
      assert.strictEqual((yield* timer.snapshot).length, 1);
    }),
  ),
);

it.effect("keeps a follower occurrence retryable when its host decision fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = codexRuntimeError({
        operation: "test-follower-decision",
        reason: "host-unavailable",
        retryable: true,
      });
      const harness = yield* makeHarness(() => Effect.fail(failure));
      const threadId = "thread-follower";
      const requestId = "approval-follower";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalApproval(threadId, requestId).state);
      aggregate.setStreamRole("follower");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView(threadId, requestId),
      });

      const exit = yield* Effect.exit(
        harness.responses.approval({
          threadId,
          requestId,
          response: { kind: "command", decision: "decline" },
        }),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.isDefined(
        harness.inbox.find("approval", requestId, (pending) => pending.threadId === threadId),
      );
      assert.strictEqual(aggregate.readServerRequests().length, 1);
      assert.deepEqual(harness.completions, []);
    }),
  ),
);

it.effect("keeps an exact pending occurrence when the Main peer becomes owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = "thread-owner-replacement";
      const requestId = "approval-owner-replacement";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalApproval(threadId, requestId).state);
      aggregate.setStreamRole("follower");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView(threadId, requestId),
      });
      aggregate.setStreamRole("owner");

      assert.isTrue(
        yield* harness.responses.approval({
          threadId,
          requestId,
          response: { kind: "command", decision: "decline" },
        }),
      );

      assert.strictEqual(aggregate.readServerRequests().length, 0);
      assert.deepEqual(harness.completions, [
        { threadId, occurrenceToken: 1, response: { decision: "decline" } },
      ]);
    }),
  ),
);

it.effect("never resolves a same-id occurrence from another Thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const requestId = "approval-shared-across-threads";
      const first = harness.conversations.entity("thread-first");
      const second = harness.conversations.entity("thread-second");
      first.acceptCanonicalState(canonicalApproval("thread-first", requestId).state);
      second.acceptCanonicalState(canonicalApproval("thread-second", requestId).state);
      first.setStreamRole("owner");
      second.setStreamRole("owner");
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView("thread-first", requestId),
      });
      harness.inbox.register({
        hostId: "local",
        generation: 1,
        kind: "approval",
        occurrenceToken: 2,
        request: approvalView("thread-second", requestId),
      });

      assert.isTrue(
        yield* harness.responses.approval({
          threadId: "thread-second",
          requestId,
          response: { kind: "command", decision: "decline" },
        }),
      );

      assert.strictEqual(first.readServerRequests().length, 1);
      assert.strictEqual(second.readServerRequests().length, 0);
      assert.isDefined(
        harness.inbox.find("approval", requestId, (pending) => pending.threadId === "thread-first"),
      );
      assert.isUndefined(
        harness.inbox.find(
          "approval",
          requestId,
          (pending) => pending.threadId === "thread-second",
        ),
      );
    }),
  ),
);
