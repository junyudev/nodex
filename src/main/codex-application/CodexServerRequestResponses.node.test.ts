import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexMcpServerElicitationRequest, CodexUserInputRequest } from "../../shared/types";
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
  agentActivityV2McpElicitationRequest,
  agentActivityV2UserInputRequest,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-request-family-corpus";
import { CodexGateway } from "../codex-runtime/CodexGateway";
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
import { ChatSearch } from "../chat-search/ChatSearch";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexWaitThreads } from "./CodexWaitThreads";
import { CoreModules } from "../core-runtime/CoreModules";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexProjectSessionFork } from "./CodexProjectSessionFork";
import { CodexReadThreadHistory } from "./CodexReadThreadHistory";
import {
  AppToolInvocationInbox,
  type AppToolInvocation,
} from "../app-tools/AppToolInvocationInbox";
import { CodexApplicationRequestInbox } from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexSidebarSectionSync } from "./CodexSidebarSectionSync";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadHandoffRuntime } from "./CodexThreadHandoffRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexDelegatedMessages } from "./CodexDelegatedMessages";
import { ConversationCommands } from "./ConversationCommands";
import { make } from "./CodexAppProtocolTools";
import { row } from "../chat-search/ChatSearch.test-support";
import { projectChat } from "../chat-search/ChatCatalogProjection";
import { chatWireEntry } from "../chat-search/ChatSearchRanking";

describe("CodexServerRequestResponses", () => {
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
    environments: null,
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
      promoteQueuedCatalogPage: Effect.succeed(false),
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
        const requestId = "question-shared";
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
        harness.inbox.register({
          hostId: "local",
          generation: 1,
          kind: "user-input",
          occurrenceToken: 2,
          request: userInputView(threadId, requestId),
        });

        assert.isTrue(
          yield* harness.responses.userInput({
            threadId,
            requestId,
            answers: { answer: ["Continue"] },
            questionResponse: {
              operationId: "answer-operation",
              respondedBy: {
                kind: "agent",
                senderThreadId: "sender-thread",
                senderSessionId: "sender-session",
              },
            },
          }),
        );
        yield* Effect.yieldNow;

        assert.deepEqual(
          harness.completions.map(({ occurrenceToken, response }) => ({
            occurrenceToken,
            response,
          })),
          [
            { occurrenceToken: 1, response: { answers: { answer: { answers: ["Continue"] } } } },
            { occurrenceToken: 2, response: CodexAppServerNoResponse },
          ],
        );
        const answer = aggregate
          .readCanonicalState()
          ?.turns.flatMap((turn) => turn.items)
          .find((item) => item.type === "userInputResponse");
        assert.deepEqual(answer?.type === "userInputResponse" ? answer.respondedBy : null, {
          kind: "agent",
          senderThreadId: "sender-thread",
          senderSessionId: "sender-session",
        });
        assert.isTrue(
          yield* harness.responses.userInput({
            threadId,
            requestId,
            answers: { answer: ["Continue"] },
            questionResponse: {
              operationId: "answer-operation",
              respondedBy: {
                kind: "agent",
                senderThreadId: "sender-thread",
                senderSessionId: "sender-session",
              },
            },
          }),
        );
        assert.strictEqual(harness.completions.length, 2);
        assert.strictEqual(aggregate.readServerRequests().length, 0);
        assert.deepEqual(harness.emitted, [
          {
            kind: "codex",
            value: { type: "userInputResolved", requestId },
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

  it.effect(
    "executes timed-out MCP elicitation as an exact decline on the tracked generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const autoResolutionRuntime = yield* makeAutoResolution.pipe(
            Effect.provideService(
              CodexRendererPresentationRegistry,
              yield* makePresentationRegistry,
            ),
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

  it.effect(
    "settles the exact native occurrence without materializing Main conversation state",
    () =>
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

  it.effect("keeps an exact pending occurrence when the Main peer becomes owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const threadId = "thread-owner-replacement";
        const requestId = "question-owner-replacement";
        const aggregate = harness.conversations.entity(threadId);
        aggregate.acceptCanonicalState(canonicalUserInput(threadId, requestId));
        aggregate.setStreamRole("follower");
        harness.inbox.register({
          hostId: "local",
          generation: 1,
          kind: "user-input",
          occurrenceToken: 1,
          request: userInputView(threadId, requestId),
        });
        aggregate.setStreamRole("owner");

        assert.isTrue(
          yield* harness.responses.userInput({
            threadId,
            requestId,
            answers: { answer: ["Continue"] },
          }),
        );

        assert.strictEqual(aggregate.readServerRequests().length, 0);
        assert.deepEqual(harness.completions, [
          {
            threadId,
            occurrenceToken: 1,
            response: { answers: { answer: { answers: ["Continue"] } } },
          },
        ]);
      }),
    ),
  );

  it.effect("never resolves a same-id occurrence from another Thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const requestId = "question-shared-across-threads";
        const first = harness.conversations.entity("thread-first");
        const second = harness.conversations.entity("thread-second");
        first.acceptCanonicalState(canonicalUserInput("thread-first", requestId));
        second.acceptCanonicalState(canonicalUserInput("thread-second", requestId));
        first.setStreamRole("owner");
        second.setStreamRole("owner");
        harness.inbox.register({
          hostId: "local",
          generation: 1,
          kind: "user-input",
          occurrenceToken: 1,
          request: userInputView("thread-first", requestId),
        });
        harness.inbox.register({
          hostId: "local",
          generation: 1,
          kind: "user-input",
          occurrenceToken: 2,
          request: userInputView("thread-second", requestId),
        });

        assert.isTrue(
          yield* harness.responses.userInput({
            threadId: "thread-second",
            requestId,
            answers: { answer: ["Continue"] },
          }),
        );

        assert.strictEqual(first.readServerRequests().length, 1);
        assert.strictEqual(second.readServerRequests().length, 0);
        assert.isDefined(
          harness.inbox.find(
            "user-input",
            requestId,
            (pending) => pending.threadId === "thread-first",
          ),
        );
        assert.isUndefined(
          harness.inbox.find(
            "user-input",
            requestId,
            (pending) => pending.threadId === "thread-second",
          ),
        );
      }),
    ),
  );
});

describe("CodexAppProtocolTools", () => {
  interface Calls {
    nativeCommands: AppToolInvocation[];
    nativeActive: boolean;
    coreReads: number;
    directoryReads: number;
    historyReads: number;
    turns: number;
    titles: number;
    archives: number;
    conversationForks: number;
    worktreeForks: number;
    handoffs: number;
    handoffInputs: { operationId: string; requestThreadId?: string; threadTitle?: string }[];
  }

  const makeCalls = (): Calls => ({
    nativeCommands: [],
    nativeActive: true,
    coreReads: 0,
    directoryReads: 0,
    historyReads: 0,
    turns: 0,
    titles: 0,
    archives: 0,
    conversationForks: 0,
    worktreeForks: 0,
    handoffs: 0,
    handoffInputs: [],
  });

  const buildTools = (
    backend: "codex" | "acp",
    calls: Calls,
    missing = false,
    hostId = "ssh:builder",
    listing: {
      readonly read?: CoreModules["Service"]["workspace"]["read"];
      readonly search?: ChatSearch["Service"]["search"];
    } = {},
  ) =>
    make.pipe(
      Effect.provideService(
        CoreModules,
        CoreModules.of({
          workspace: {
            read:
              listing.read ??
              (() =>
                missing
                  ? Effect.fail(
                      coreRuntimeError({
                        operation: "workspace.read",
                        reason: "operation",
                        retryable: false,
                        cause: new CoreModuleResponseError({
                          code: "not_found",
                          message: "Thread not found",
                          retryable: false,
                          recovery: { kind: "none" },
                        }),
                      }),
                    )
                  : Effect.sync(() => {
                      calls.coreReads += 1;
                      return {
                        value: {
                          kind: "thread",
                          thread: {
                            backend_binding:
                              backend === "codex"
                                ? { driver: "codex", instanceId: "codex" }
                                : { driver: "acpRegistry", instanceId: "acp_claude" },
                          },
                        },
                      } as never;
                    })),
          },
        } as never),
      ),
      Effect.provideService(CodexThreadDirectory, {
        resolve: () =>
          Effect.sync(() => {
            calls.directoryReads += 1;
            return {
              durable: { sessionId: "session-target", executionHostId: hostId },
              summary: {
                threadName: "**Target** [task](https://example.com)",
                threadPreview: "",
              },
            } as never;
          }),
      } as unknown as CodexThreadDirectory["Service"]),
      Effect.provideService(CodexReadThreadHistory, {
        read: () =>
          Effect.sync(() => {
            calls.historyReads += 1;
            return {} as never;
          }),
      } as unknown as CodexReadThreadHistory["Service"]),
      Effect.provideService(CodexDelegatedMessages, {
        send: () =>
          Effect.sync(() => {
            calls.turns += 1;
          }),
      } as unknown as CodexDelegatedMessages["Service"]),
      Effect.provideService(CodexThreadTitlePersistence, {
        set: () =>
          Effect.sync(() => {
            calls.titles += 1;
          }),
      } as unknown as CodexThreadTitlePersistence["Service"]),
      Effect.provideService(ConversationCommands, {
        archive: () =>
          Effect.sync(() => {
            calls.archives += 1;
          }),
        unarchive: () =>
          Effect.sync(() => {
            calls.archives += 1;
          }),
      } as unknown as ConversationCommands["Service"]),
      Effect.provideService(CodexConversationFork, {
        fork: () =>
          Effect.sync(() => {
            calls.conversationForks += 1;
            return { threadId: "forked" } as never;
          }),
      } as unknown as CodexConversationFork["Service"]),
      Effect.provideService(CodexProjectSessionFork, {
        fork: () =>
          Effect.sync(() => {
            calls.worktreeForks += 1;
            return { pendingWorktreeId: "pending" } as never;
          }),
      } as unknown as CodexProjectSessionFork["Service"]),
      Effect.provideService(CodexThreadHandoffRuntime, {
        get: (operationId: string) =>
          Effect.succeed(
            calls.handoffInputs.find((input) => input.operationId === operationId) ?? null,
          ),
        launch: (input: { operationId: string; requestThreadId?: string; threadTitle?: string }) =>
          Effect.sync(() => {
            calls.handoffs += 1;
            calls.handoffInputs.push(input);
            return input as never;
          }),
      } as unknown as CodexThreadHandoffRuntime["Service"]),
      Effect.provideService(CodexApplicationEventHub, {
        publish: () => undefined,
      } as unknown as CodexApplicationEventHub["Service"]),
      Effect.provideService(
        CodexPendingServerRequestRuntime,
        {} as CodexPendingServerRequestRuntime["Service"],
      ),
      Effect.provideService(AppToolInvocationInbox, {
        invoke: (input: AppToolInvocation) =>
          Effect.sync(() => {
            calls.nativeCommands.push(input);
            return {
              content: [],
              structuredContent: { sessionId: "runtime-session", threadId: "runtime-thread" },
            };
          }),
      } as unknown as AppToolInvocationInbox["Service"]),
      Effect.provideService(CodexApplicationRequestInbox, {
        captureNativeTurnSource: () => Effect.succeed({ isActive: () => calls.nativeActive }),
      } as unknown as CodexApplicationRequestInbox["Service"]),
      Effect.provideService(CodexMainConversationManagers, {
        current: () => ({
          assertCurrent: (generation: number) => {
            if (generation !== 7 || !calls.nativeActive)
              throw new Error("Native generation retired");
          },
        }),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexSidebarSectionSync, {} as CodexSidebarSectionSync["Service"]),
      Effect.provideService(CodexThreadCatalog, {} as CodexThreadCatalog["Service"]),
      Effect.provideService(ChatSearch, {
        search: listing.search ?? (() => Effect.succeed({ matches: [], complete: true })),
        searchMessages: () => Effect.succeed({ matches: [], truncated: false, sources: [] }),
        rankSessionIds: () => Effect.succeed([]),
      }),
      Effect.provideService(CodexWaitThreads, { execute: () => Effect.die("unused wait tool") }),
      Effect.provideService(TerminalSessions, {} as TerminalSessions["Service"]),
    );

  const call = (tool: string, arguments_: Record<string, unknown>) => ({
    threadId: "thread-caller",
    turnId: "turn-caller",
    callId: `call-${tool}`,
    namespace: "codex_app",
    tool,
    arguments: arguments_,
  });

  it.effect("rejects ACP-owned targets before invoking any Codex thread owner", () =>
    Effect.gen(function* () {
      const calls = makeCalls();
      const tools = yield* buildTools("acp", calls);
      const target = "thread-acp";
      const attempts = [
        call("read_thread", { threadId: target }),
        call("send_message_to_thread", { threadId: target, prompt: "Continue." }),
        call("set_thread_title", { threadId: target, title: "No" }),
        call("set_thread_archived", { threadId: target, archived: true }),
        call("fork_thread", { threadId: target, environment: { type: "same-directory" } }),
        call("fork_thread", { threadId: target, environment: { type: "worktree" } }),
        call("handoff_thread", { threadId: target }),
      ];

      for (const attempt of attempts) {
        const response = yield* tools.execute(attempt as never);
        assert.isFalse(response.success);
        assert.match(JSON.stringify(response), /not owned by the Codex Agent Backend/);
      }

      assert.strictEqual(calls.coreReads, attempts.length);
      assert.strictEqual(calls.directoryReads, 0);
      assert.strictEqual(calls.historyReads, 0);
      assert.strictEqual(calls.turns, 0);
      assert.strictEqual(calls.titles, 0);
      assert.strictEqual(calls.archives, 0);
      assert.strictEqual(calls.conversationForks, 0);
      assert.strictEqual(calls.worktreeForks, 0);
      assert.strictEqual(calls.handoffs, 0);
    }),
  );

  it.effect("admits an explicitly remote Core-owned Codex target before sending a message", () =>
    Effect.gen(function* () {
      const calls = makeCalls();
      const tools = yield* buildTools("codex", calls);

      const response = yield* tools.execute(
        call("send_message_to_thread", {
          threadId: "thread-codex",
          prompt: "Continue.",
        }) as never,
      );

      assert.isTrue(response.success);
      assert.strictEqual(calls.coreReads, 1);
      assert.strictEqual(calls.directoryReads, 1);
      assert.strictEqual(calls.turns, 1);
    }),
  );

  it.effect(
    "keeps a repeated handoff call attached to one operation and its requesting conversation",
    () =>
      Effect.gen(function* () {
        const calls = makeCalls();
        const tools = yield* buildTools("codex", calls);
        const request = call("handoff_thread", { threadId: "thread-target" });
        const first = yield* tools.execute(request as never);
        const second = yield* tools.execute(request as never);
        assert.isTrue(first.success);
        assert.deepEqual(second, first);
        assert.strictEqual(calls.handoffs, 1);
        assert.strictEqual(calls.handoffInputs[0]?.requestThreadId, request.threadId);
        assert.strictEqual(calls.handoffInputs[0]?.threadTitle, "Target task");
      }),
  );

  it.effect("read_thread can inspect a native task before durable workspace import", () =>
    Effect.gen(function* () {
      const calls = makeCalls();
      const tools = yield* buildTools("codex", calls, true);
      const response = yield* tools.execute(
        call("read_thread", { threadId: "native-only" }) as never,
      );
      assert.isTrue(response.success);
      assert.strictEqual(calls.historyReads, 1);
      assert.strictEqual(calls.directoryReads, 0);
    }),
  );

  it.effect(
    "local native tool Session writes retain original source and enter the Runtime owner",
    () =>
      Effect.gen(function* () {
        const calls = makeCalls();
        const tools = yield* buildTools("codex", calls, false, "local");
        const context = { nativeSource: { hostId: "local", generation: 7 } };
        const source = call("create_thread", {
          prompt: "Build",
          target: { type: "projectless" },
          thinking: "high",
        });
        assert.isTrue((yield* tools.execute(source as never, context)).success);
        assert.isTrue((yield* tools.execute(source as never, context)).success);
        assert.deepEqual(calls.nativeCommands[0]?.arguments, {
          prompt: "Build",
          target: { type: "projectless" },
          reasoningEffort: "high",
        });
        assert.deepEqual(calls.nativeCommands[0]?.arguments, calls.nativeCommands[1]?.arguments);
        assert.equal(calls.nativeCommands[0]?.caller.turnId, "turn-caller");
        assert.equal(calls.nativeCommands[0]?.caller.callId, source.callId);
        assert.equal(calls.nativeCommands[0]?.caller.generation, 7);
        assert.equal(calls.coreReads, 0);
        assert.isTrue(
          (yield* tools.execute(
            call("send_message_to_thread", { threadId: "target", prompt: "Continue" }) as never,
            context,
          )).success,
        );
        assert.isTrue(
          (yield* tools.execute(call("fork_thread", { threadId: "target" }) as never, context))
            .success,
        );
        assert.deepEqual(
          calls.nativeCommands.slice(2).map((input) => [input.name, input.arguments]),
          [
            ["send_message_to_session", { sessionId: "session-target", prompt: "Continue" }],
            ["fork_session", { sessionId: "session-target" }],
          ],
        );
        assert.equal(calls.turns, 0);
        assert.equal(calls.conversationForks, 0);
        assert.equal(calls.worktreeForks, 0);
        calls.nativeActive = false;
        assert.isFalse(calls.nativeCommands[0]?.caller.isActive());
        assert.isFalse((yield* tools.execute(source as never, context)).success);
        assert.equal(calls.nativeCommands.length, 4);
      }),
  );

  it.effect(
    "lists bounded ranked chats while preserving native previews in the tool response",
    () =>
      Effect.gen(function* () {
        const native = row("native", "Searchable chat", "native");
        const entry = chatWireEntry(projectChat(native)!);
        const queries: unknown[] = [];
        const reads: unknown[] = [];
        const tools = yield* buildTools("codex", makeCalls(), false, "local", {
          search: (input) =>
            Effect.sync(() => {
              queries.push(input);
              return {
                matches: [
                  {
                    chat: { ...entry, projectId: null },
                    titleRanges: [],
                    hint: null,
                    excerpt: null,
                  },
                ],
                complete: true,
              };
            }),
          read: (input) =>
            Effect.sync(() => {
              reads.push(input);
              if (input.kind === "session_window")
                return {
                  value: {
                    kind: "session_window",
                    sessions: { items: [native], next_cursor: null },
                  },
                } as never;
              if (input.kind === "project_window")
                return {
                  value: { kind: "project_window", projects: { items: [], next_cursor: null } },
                } as never;
              if (input.kind === "sidebar_section_window")
                return {
                  value: {
                    kind: "sidebar_section_window",
                    sections: {
                      items: [{ section_id: "sidebar:chats", kind: "chats", name: null }],
                      next_cursor: null,
                    },
                  },
                } as never;
              return undefined as never;
            }),
        });
        const response = yield* tools.execute(
          call("list_threads", { query: "Searchable", limit: 1 }) as never,
        );
        assert.isTrue(response.success);
        assert.deepEqual(queries, [{ query: "searchable", limit: 1, startedOnly: true }]);
        assert.deepInclude(reads, {
          kind: "session_window",
          archived: false,
          session_ids: ["native"],
          window: { first: 100, after: null },
        });
        const content = response.contentItems.find((item) => item.type === "inputText");
        assert.ok(content?.type === "inputText");
        const result = JSON.parse(content.text) as {
          schemaVersion: number;
          sections: { items: unknown[] }[];
        };
        assert.equal(result.schemaVersion, 4);
        assert.deepInclude(result.sections[0]!.items[0], {
          threadId: "native",
          sessionId: "native",
          title: "Searchable chat",
          preview: "Opening prompt",
          summary: "Opening prompt",
        });
      }),
  );
});
