import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { produce, type Patch } from "immer";
import { ConversationStream } from "../../shared/codex-conversation-stream";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import type { CodexTranscriptTextChange } from "../../shared/codex-transcript-projection";
import {
  reduceCodexConversationServerRequest,
  reduceCodexConversationUserInputResponse,
} from "../../shared/codex-conversation-state/codex-server-request-lifecycle";
import {
  collectCodexAsyncQuestionAnswerRecords,
  encodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
  type CodexAsyncQuestionResponseInput,
} from "../../shared/codex-async-user-input";
import { conversationFixture, turnFixture } from "../codex-application/conversation-test-fixture";
import { CodexConversationProjection } from "../codex-application/CodexConversationProjection";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "../codex-application/CodexMainConversationManagers";
import {
  CodexServerRequestResponses,
  type CodexUserInputResponseInput,
} from "../codex-application/CodexServerRequestResponses";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";

const unexpected = (): never => {
  throw new Error("Unexpected native question dependency");
};

/** A resident native conversation; responses use the canonical reducers and reply encoding. */
export const nativeQuestionFixture = () => {
  const threadId = "native-root";
  const ask = {
    type: "agentMessage" as const,
    id: "async-ask",
    text: "Scope?",
    phase: "commentary" as const,
    memoryCitation: null,
    delivery: "async" as const,
    questions: [{ title: "Scope?", options: ["Project", "Library"] }],
  };
  let canonical = reduceCodexConversationServerRequest(
    conversationFixture(threadId, [turnFixture("source")]),
    {
      id: "live",
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId: "source",
        itemId: "live-item",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            isOther: false,
            isSecret: false,
            options: [{ label: "Project", description: "Current Project" }],
          },
        ],
      },
    },
    { now: () => 1 },
  ).state;
  canonical = produce(canonical, (draft) => {
    draft.turns[0]!.items.push(ask);
  });
  const snapshot: CodexConversationSnapshot = {
    threadId,
    projectId: "project",
    source: null,
    threadName: "Questions",
    threadPreview: "",
    cwd: "/worktree",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-10-31T00:00:00Z",
    resumeState: "resumed",
    turns: [],
    requests: [],
    pendingSteers: [],
    backgroundTerminalRows: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    capabilityFlags: {
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
  const stream = new ConversationStream<
    CodexCanonicalConversationState,
    Patch,
    CodexTranscriptTextChange
  >({
    hostId: "local",
    isLocalHost: true,
    canHandleOwnerlessDynamicTool: () => false,
    transport: {
      sendState: unexpected,
      sendFollowing: unexpected,
      requestFollowingStatus: () => {},
      setThreadOwnership: () => {},
    },
    getConversation: () => canonical,
    normalizeSnapshot: (state) => state,
    applyPatches: unexpected,
    setConversation: unexpected,
    notifyConversation: () => {},
    onRoleChanged: () => {},
    onFollowersChanged: unexpected,
    onOwnerUnavailable: unexpected,
    onError: unexpected,
    schedule: unexpected,
  });
  stream.setRole(threadId, { role: "owner" });
  const manager: MainConversationManager = {
    hostId: "local",
    generation: 1,
    context: {
      identity: { kind: "execution-storage", authMode: "fixture" },
      executionHostKey: "local",
    },
    stream,
    assertCurrent: () => {},
    onDispose: unexpected,
    onConnectionReset: unexpected,
    findOwner: unexpected,
    subscribeQueuedMessages: unexpected,
    coordination: {
      threadArchived: unexpected,
      threadUnarchived: unexpected,
      threadQueuedFollowUpsChanged: unexpected,
      setThreadOwnership: unexpected,
      threadStreamStateChanged: unexpected,
      threadStreamFollowingChanged: unexpected,
      threadStreamFollowingStatusRequested: unexpected,
      findThreadOwner: unexpected,
      requestThreadFollower: unexpected,
    },
  };
  const syncCalls: CodexUserInputResponseInput[] = [];
  const asyncCalls: CodexAsyncQuestionResponseInput[] = [];
  const services = Layer.mergeAll(
    Layer.mock(CodexConversationProjection, {
      read: () => Effect.sync(() => ({ canonical, snapshot })),
    }),
    Layer.mock(CodexMainConversationManagers, {
      current: () => manager,
      role: () => stream.getRole(threadId),
      registerFollowerHandler: unexpected,
    }),
    Layer.mock(CodexServerRequestResponses, {
      userInput: (input) =>
        Effect.sync(() => {
          syncCalls.push(input);
          const result = reduceCodexConversationUserInputResponse(
            canonical,
            input.requestId,
            input.answers,
            { now: () => 2, questionResponse: input.questionResponse },
          );
          canonical = result.state;
          return result.selectedRequests.length > 0;
        }),
    }),
    Layer.mock(CodexTurnCommands, {
      releasePreparedNativeStart: unexpected,
      releasePreparedNativeSteer: unexpected,
      respondAsyncQuestions: (input) =>
        Effect.sync(() => {
          asyncCalls.push(input);
          canonical = produce(canonical, (draft) => {
            const source = draft.turns[0]!;
            draft.turns.push({
              ...source,
              turnId: "answer-turn",
              params: {
                ...source.params,
                clientUserMessageId: input.submissionId,
                input: [
                  {
                    type: "text",
                    text: encodeCodexAsyncQuestionReplies(input.replies),
                    text_elements: [],
                  },
                ],
                questionResponse: input.questionResponse,
              },
              items: [],
            });
          });
          return { turnId: "answer-turn" };
        }),
    }),
  );
  return {
    services,
    syncCalls,
    asyncCalls,
    syncId: 'native:sync:"live"',
    asyncQuestionId: expandCodexAsyncQuestions(ask)[0]!.id,
    answerRecords: () => collectCodexAsyncQuestionAnswerRecords(canonical.turns),
  };
};
