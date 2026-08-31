import { assert, it } from "@effect/vitest";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { CodexApprovalRequest, CodexUserInputRequest } from "../../shared/types";
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
  agentActivityV2UserInputRequest,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-request-family-corpus";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import {
  CodexPendingServerRequestRuntime,
  make as makeInbox,
} from "./CodexPendingServerRequestRuntime";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
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
    turnParamsById: { [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams(threadId) },
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
    turnParamsById: { [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams(threadId) },
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

const makeGateway = (
  requestRawForThread: CodexGateway["Service"]["requestRawForThread"],
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
    connection: unsupported,
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
  handleDisconnect: Effect.void,
});

const makeHarness = (
  requestRawForThread: CodexGateway["Service"]["requestRawForThread"] = () =>
    Effect.succeed(undefined),
  autoResolutionRuntime: CodexUserInputAutoResolution["Service"] = autoResolution,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const conversationContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
    const conversations = Context.get(conversationContext, ConversationEntityMap);
    const completions: Completion[] = [];
    const inbox = yield* makeInbox({
      respond: (threadId, _requestId, occurrenceToken, response) =>
        Effect.sync(() => {
          completions.push({ threadId, occurrenceToken, response });
          return true;
        }),
      reject: () => Effect.succeed(true),
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const emitted: CodexApplicationEvent[] = [];
    const rendererConversations = makeCodexRendererConversationRegistryState();
    const responses = yield* makeResponses.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => emitted.push(event),
        }),
      ),
      Effect.provideService(CodexGateway, makeGateway(requestRawForThread)),
      Effect.provideService(
        CodexOwnerNotificationDrainRuntime,
        CodexOwnerNotificationDrainRuntime.of({
          next: () => 1,
          canAck: () => true,
          ack: () => true,
          awaitCurrent: () => Effect.void,
          resetOwner: () => undefined,
          release: () => undefined,
          clear: () => undefined,
        }),
      ),
      Effect.provideService(CodexPendingServerRequestRuntime, inbox),
      Effect.provideService(CodexRendererConversationRegistry, rendererConversations),
      Effect.provideService(
        CodexThreadReadState,
        CodexThreadReadState.of({
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
      rendererConversations,
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
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView(threadId, requestId),
      });
      harness.inbox.register({
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
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
      );
      const harness = yield* makeHarness(undefined, autoResolutionRuntime);
      const threadId = "thread-auto-resolution";
      const requestId = "user-input-timeout";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalUserInput(threadId, requestId));
      aggregate.setStreamRole("owner");
      harness.inbox.register({
        kind: "user-input",
        occurrenceToken: 1,
        request: userInputView(threadId, requestId),
      });

      yield* autoResolutionRuntime.observeRequest(threadId, requestId);
      yield* TestClock.adjust(USER_INPUT_AUTO_RESOLUTION_COUNTDOWN);
      yield* Effect.yieldNow;

      assert.strictEqual(aggregate.readServerRequests().length, 0);
      assert.deepEqual(harness.completions, [
        { threadId, occurrenceToken: 1, response: { answers: {} } },
      ]);
    }),
  ),
);

it.effect("executes timed-out user input and resolves the exact renderer owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const autoResolutionRuntime = yield* makeAutoResolution.pipe(
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
      );
      const harness = yield* makeHarness(undefined, autoResolutionRuntime);
      const threadId = "thread-auto-resolution";
      const requestId = "user-input-timeout";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalUserInput(threadId, requestId));
      aggregate.setStreamRole("owner");
      harness.rendererConversations.setOwner(threadId, "renderer-owner");
      harness.inbox.register({
        kind: "user-input",
        occurrenceToken: 1,
        request: userInputView(threadId, requestId),
      });

      yield* autoResolutionRuntime.observeRequest(threadId, requestId);
      yield* TestClock.adjust(USER_INPUT_AUTO_RESOLUTION_COUNTDOWN);
      yield* Effect.yieldNow;

      assert.strictEqual(aggregate.readServerRequests().length, 0);
      assert.deepEqual(harness.completions, [
        { threadId, occurrenceToken: 1, response: { answers: {} } },
      ]);
      assert.deepInclude(harness.emitted, {
        kind: "rendererOwnerHostMessage",
        value: {
          targetClientId: "renderer-owner",
          message: {
            type: "threadOwnerNotification",
            hostId: DEFAULT_CODEX_HOST_ID,
            sequence: 1,
            notification: {
              method: "serverRequest/resolved",
              params: { threadId, requestId },
            },
          },
        },
      });
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

it.effect("keeps an exact pending occurrence across renderer owner replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = "thread-owner-replacement";
      const requestId = "approval-owner-replacement";
      const aggregate = harness.conversations.entity(threadId);
      aggregate.acceptCanonicalState(canonicalApproval(threadId, requestId).state);
      aggregate.setStreamRole("owner");
      harness.inbox.register({
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView(threadId, requestId),
      });
      harness.rendererConversations.setOwner(threadId, "owner-before");
      harness.rendererConversations.handleClientDisposed("owner-before");
      harness.rendererConversations.setOwner(threadId, "owner-after");

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
        kind: "approval",
        occurrenceToken: 1,
        request: approvalView("thread-first", requestId),
      });
      harness.inbox.register({
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
