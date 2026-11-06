import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { CurrentLogAnnotations } from "effect/References";
import { produce } from "immer";
import { conversationFixture, turnFixture } from "../codex-application/conversation-test-fixture";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexConversationProjection } from "../codex-application/CodexConversationProjection";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import {
  CodexServerRequestResponses,
  type CodexUserInputResponseInput,
} from "../codex-application/CodexServerRequestResponses";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
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
import {
  agentActivityV2McpElicitationRequest,
  agentActivityV2PermissionRequest,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-request-family-corpus";
import { projectCodexCanonicalTurnViews } from "../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../shared/codex-transcript-entry-projection";
import type { ProjectSession } from "../../shared/types";
import type { ConversationFollowerParams } from "../../shared/codex-thread-follower-request";
import { makeNativeSessionQuestions } from "./NativeSessionQuestions";

const target = { sessionId: "session" };
const responder = {
  kind: "agent" as const,
  senderThreadId: "answering-thread",
  senderSessionId: "answering-session",
};
const syncRequestId = 'native:sync:"live"';
const ask = {
  type: "agentMessage" as const,
  id: "ask",
  text: "Fallback",
  phase: "commentary" as const,
  memoryCitation: null,
  delivery: "async" as const,
  questions: [
    { title: "Scope?", options: ["Project", "Library"] },
    { title: "Name?", options: null },
  ],
};
const asyncQuestionId = expandCodexAsyncQuestions(ask)[0]!.id;
const asyncRequestId = `native:async:${asyncQuestionId}`;

const fixture = (hostId = "local", follower = false) => {
  let canonical = conversationFixture("thread", [turnFixture("source", "completed")]);
  canonical = produce(canonical, (draft) => {
    draft.hostId = hostId;
    draft.turns[0]!.items.push(ask);
  });
  canonical = reduceCodexConversationServerRequest(
    canonical,
    {
      id: "live",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread",
        turnId: "source",
        itemId: "live-item",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "choice",
            header: "Scope",
            question: "Which scope?",
            isOther: false,
            isSecret: true,
            options: [
              { label: "Project", description: "Current Project" },
              { label: "Library", description: "Every Project" },
            ],
          },
        ],
      },
    },
    { now: () => 1 },
  ).state;
  canonical = reduceCodexConversationServerRequest(
    canonical,
    {
      ...agentActivityV2McpElicitationRequest,
      id: "elicitation",
      params: {
        ...agentActivityV2McpElicitationRequest.params,
        threadId: "thread",
        turnId: "source",
      },
    },
    { now: () => 1 },
  ).state;
  canonical = produce(canonical, (draft) => {
    draft.requests.push(
      { ...agentActivityV2PermissionRequest, id: "permission" },
      {
        id: "private-picker",
        method: "item/tool/requestOptionPicker",
        params: { threadId: "thread", turnId: "source", question: "Choose setup", options: [] },
      },
      {
        id: "setup-picker",
        method: "item/tool/requestSetupCodexContextPicker",
        params: { threadId: "thread", turnId: "source" },
      },
    );
    draft.requests.push({
      id: "approval",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread",
        turnId: "source",
        itemId: "patch",
        startedAtMs: 1,
        reason: null,
        grantRoot: null,
      },
    });
  });
  const session = {
    id: "session",
    archived: false,
    executionRef: null,
    thread: { threadId: "thread", executionHostId: hostId, backendBinding: { kind: "codex" } },
  } as ProjectSession;
  let loaded = true;
  let rejectAsync = false;
  let generationChecks = 0;
  let generationFailureAt: number | undefined;
  let followerFailure: Error | undefined;
  const syncCalls: CodexUserInputResponseInput[] = [];
  const asyncCalls: CodexAsyncQuestionResponseInput[] = [];
  const forwarded: Array<ConversationFollowerParams["thread-follower-submit-user-input"]> = [];
  const accept = (input: CodexUserInputResponseInput) => {
    syncCalls.push(input);
    const result = reduceCodexConversationUserInputResponse(
      canonical,
      input.requestId,
      input.answers,
      { now: () => 2, questionResponse: input.questionResponse },
    );
    canonical = result.state;
    return result.selectedRequests.length > 0;
  };
  const respond = (input: CodexUserInputResponseInput) => Effect.sync(() => accept(input));
  const make = makeNativeSessionQuestions.pipe(
    Effect.provideService(ProjectWorkspace, {
      getProjectSession: () => Effect.succeed(session),
    } as never),
    Effect.provideService(CodexConversationProjection, {
      read: () => Effect.succeed({ canonical, snapshot: { resumeState: "resumed" } }),
    } as never),
    Effect.provideService(CodexMainConversationManagers, {
      current: () =>
        loaded
          ? {
              generation: 1,
              assertCurrent: () => {
                generationChecks += 1;
                if (generationChecks === generationFailureAt)
                  throw new Error("Native generation changed");
              },
              stream: {
                getRole: () =>
                  follower
                    ? { role: "follower", ownerClientId: "owner-window" }
                    : { role: "owner" },
              },
              coordination: {
                requestThreadFollower: async (input: {
                  hostId: string;
                  targetClientId: string;
                  request: {
                    params: ConversationFollowerParams["thread-follower-submit-user-input"];
                  };
                }) => {
                  if (followerFailure) throw followerFailure;
                  assert.equal(input.hostId, hostId);
                  assert.equal(input.targetClientId, "owner-window");
                  const params = input.request.params;
                  forwarded.push(params);
                  const ok = accept({
                    threadId: params.conversationId,
                    requestId: params.requestId,
                    answers: Object.fromEntries(
                      Object.entries(params.response.answers).map(([id, value]) => [
                        id,
                        value?.answers ?? [],
                      ]),
                    ),
                    questionResponse: params.questionResponse,
                  });
                  return { resultType: "success", result: { ok } };
                },
              },
            }
          : null,
    } as never),
    Effect.provideService(CodexServerRequestResponses, { userInput: respond } as never),
    Effect.provideService(CodexTurnCommands, {
      respondAsyncQuestions: (input: CodexAsyncQuestionResponseInput) =>
        Effect.sync(() => {
          asyncCalls.push(input);
          if (rejectAsync) {
            rejectAsync = false;
            return null;
          }
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
    } as never),
  );
  return {
    make,
    syncCalls,
    asyncCalls,
    forwarded,
    state: () => canonical,
    rejectNextAsync: () => {
      rejectAsync = true;
    },
    failGenerationAt: (check: number) => {
      generationFailureAt = check;
    },
    failFollower: (cause: Error) => {
      followerFailure = cause;
    },
    configureQuestion: (flags: {
      multiSelect?: boolean;
      required?: boolean;
      isOther?: boolean;
      initialAnswer?: string;
    }) => {
      canonical = produce(canonical, (draft) => {
        const request = draft.requests.find(
          (request) => request.method === "item/tool/requestUserInput",
        );
        if (request?.method === "item/tool/requestUserInput")
          Object.assign(request.params.questions[0]!, flags);
      });
    },
    unload: () => {
      loaded = false;
    },
    session,
  };
};

it.effect.each([
  ["local", false],
  ["ssh:remote", false],
  ["local", true],
  ["ssh:remote", true],
] as const)("lists, reads and answers live questions on %s (follower %s)", ([hostId, follower]) =>
  Effect.gen(function* () {
    const f = fixture(hostId, follower);
    const backend = yield* f.make;
    assert.deepEqual((yield* backend.list(target)).requestIds, [
      syncRequestId,
      asyncRequestId,
      `native:async:${expandCodexAsyncQuestions(ask)[1]!.id}`,
    ]);
    const read = yield* backend.read(target, syncRequestId);
    assert.deepEqual(read.questions[0], {
      id: "choice",
      header: "Scope",
      question: "Which scope?",
      options: [
        { label: "Project", description: "Current Project" },
        { label: "Library", description: "Every Project" },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
      isSecret: true,
      required: false,
    });
    const answer = { choice: " Project " };
    assert.deepEqual(
      yield* backend.respond(
        target,
        syncRequestId,
        answer,
        { ...responder, senderRunId: "first-run" },
        "op-sync",
      ),
      {
        requestId: syncRequestId,
        status: "answered",
      },
    );
    yield* backend.respond(
      target,
      syncRequestId,
      answer,
      { ...responder, senderRunId: "later-run" },
      "op-sync",
    );
    assert.equal(f.syncCalls.length, 1);
    assert.equal(f.forwarded.length, follower ? 1 : 0);
    assert.deepEqual(f.syncCalls[0]?.answers, { choice: ["Project"] });
    assert.equal(
      (yield* backend.read(target, syncRequestId).pipe(Effect.flip)).code,
      "not_pending",
    );
    assert.equal(
      (yield* backend
        .respond(target, syncRequestId, answer, responder, "other-op")
        .pipe(Effect.flip)).code,
      "not_pending",
    );
    const reopened = yield* f.make;
    yield* reopened.respond(target, syncRequestId, answer, responder, "op-sync");
    assert.equal(f.syncCalls.length, 1);
    const persisted = JSON.parse(JSON.stringify(f.state()));
    const view = projectCodexCanonicalTurnViews({
      threadId: "thread",
      turn: persisted.turns[0],
      observedAtMs: 2,
    }).find((item) => item.semanticKind === "userInputResponse");
    assert.deepEqual(view?.respondedBy, responder);
    assert.deepEqual(
      projectCodexItemViewToTranscriptEntry(view!, "replay", 0).respondedBy,
      responder,
    );
  }),
);

it.effect.each(["local", "ssh:remote"])(
  "answers async questions on %s once with source identity and attribution",
  (hostId) =>
    Effect.gen(function* () {
      const f = fixture(hostId, true);
      const backend = yield* f.make;
      assert.equal((yield* backend.read(target, asyncRequestId)).questions[0]?.question, "Scope?");
      const answers = { [asyncQuestionId]: " Project " };
      yield* backend.respond(target, asyncRequestId, answers, responder, "op-async");
      yield* backend.respond(target, asyncRequestId, answers, responder, "op-async");
      assert.equal(f.asyncCalls.length, 1);
      assert.equal(f.syncCalls.length, 0);
      assert.deepEqual(f.asyncCalls[0]?.sourceTurnIds, ["source"]);
      assert.match(f.asyncCalls[0]!.submissionId, /^session-question:[a-f0-9]{64}$/);
      const saved = JSON.parse(JSON.stringify(f.state()));
      const records = collectCodexAsyncQuestionAnswerRecords(saved.turns);
      assert.deepEqual(records.get(asyncQuestionId)?.respondedBy, responder);
      assert.equal(
        (yield* backend.read(target, asyncRequestId).pipe(Effect.flip)).code,
        "not_pending",
      );
      const reopened = yield* f.make;
      yield* reopened.respond(target, asyncRequestId, answers, responder, "op-async");
      assert.equal(f.asyncCalls.length, 1);
      assert.isFalse((yield* backend.list(target)).requestIds.includes(asyncRequestId));
      const view = projectCodexCanonicalTurnViews({
        threadId: "thread",
        turn: saved.turns[1],
        observedAtMs: 2,
      })[0]!;
      assert.deepEqual(
        projectCodexItemViewToTranscriptEntry(view, "replay", 0).respondedBy,
        responder,
      );
    }),
);

it.effect(
  "rejects excluded interactions, changed retries, invalid answers and unavailable execution",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const backend = yield* f.make;
      assert.equal(
        (yield* backend.read(target, 'native:sync:"elicitation"').pipe(Effect.flip)).code,
        "not_found",
      );
      assert.equal(
        (yield* backend.read(target, 'native:sync:"approval"').pipe(Effect.flip)).code,
        "not_found",
      );
      for (const id of ["permission", "private-picker", "setup-picker"])
        assert.equal(
          (yield* backend.read(target, `native:sync:${JSON.stringify(id)}`).pipe(Effect.flip)).code,
          "not_found",
        );
      assert.equal(
        (yield* backend.list({ ...target, execution: { threadId: "thread" } }).pipe(Effect.flip))
          .code,
        "unsupported",
      );
      assert.equal(
        (yield* backend
          .respond(target, syncRequestId, { choice: "custom" }, responder, "op")
          .pipe(Effect.flip)).code,
        "unsupported",
      );
      yield* backend.respond(target, syncRequestId, { choice: "Project" }, responder, "op");
      assert.equal(
        (yield* backend
          .respond(target, syncRequestId, { choice: "Library" }, responder, "op")
          .pipe(Effect.flip)).code,
        "forbidden",
      );
      f.unload();
      assert.equal((yield* backend.list(target).pipe(Effect.flip)).code, "unavailable");
      assert.equal(
        (yield* backend.read(target, asyncRequestId).pipe(Effect.flip)).code,
        "unavailable",
      );
      assert.equal(
        (yield* backend
          .respond(target, asyncRequestId, { [asyncQuestionId]: "Project" }, responder, "op2")
          .pipe(Effect.flip)).code,
        "unavailable",
      );
      assert.equal(f.asyncCalls.length, 0);
    }),
);

it.effect("preserves multiple-choice and required question contracts", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.configureQuestion({ multiSelect: true, required: true });
    const backend = yield* f.make;
    const question = (yield* backend.read(target, syncRequestId)).questions[0]!;
    assert.isTrue(question.multiSelect);
    assert.isTrue(question.required);
    assert.equal(
      (yield* backend.respond(target, syncRequestId, {}, responder, "op").pipe(Effect.flip)).code,
      "unsupported",
    );
    yield* backend.respond(
      target,
      syncRequestId,
      { choice: ["Project", "Library"] },
      responder,
      "op",
    );
    assert.deepEqual(f.syncCalls[0]?.answers, { choice: ["Project", "Library"] });
  }),
);

it.effect("retains async submission identity after an unacknowledged delivery", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.rejectNextAsync();
    const backend = yield* f.make;
    const answers = { [asyncQuestionId]: "Project" };
    assert.equal(
      (yield* backend
        .respond(target, asyncRequestId, answers, responder, "retry-op")
        .pipe(Effect.flip)).code,
      "unavailable",
    );
    yield* backend.respond(target, asyncRequestId, answers, responder, "retry-op");
    assert.equal(f.asyncCalls.length, 2);
    assert.equal(f.asyncCalls[0]?.submissionId, f.asyncCalls[1]?.submissionId);
  }),
);

it.effect("keeps explicit form values byte-for-byte as the native questionnaire does", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.configureQuestion({ isOther: true, initialAnswer: "" });
    const backend = yield* f.make;
    yield* backend.respond(
      target,
      syncRequestId,
      { choice: "  custom answer  " },
      responder,
      "exact-form",
    );
    assert.deepEqual(f.syncCalls[0]?.answers, { choice: ["  custom answer  "] });
    const reopened = yield* f.make;
    yield* reopened.respond(
      target,
      syncRequestId,
      { choice: "  custom answer  " },
      responder,
      "exact-form",
    );
    assert.equal(f.syncCalls.length, 1);
  }),
);

it.effect.each([1, 2])("maps generation failure at check %s to unavailable", (check) =>
  Effect.gen(function* () {
    const f = fixture();
    f.failGenerationAt(check);
    const backend = yield* f.make;
    const error = yield* backend
      .respond(target, syncRequestId, { choice: "Project" }, responder, "generation-failed")
      .pipe(Effect.flip);
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "Native questions are unavailable");
    assert.equal(f.syncCalls.length, 0);
  }),
);

it.effect("logs follower delivery failures and returns only the shared unavailable error", () => {
  const warnings: unknown[] = [];
  const logger = Logger.make(({ fiber }) => warnings.push(fiber.getRef(CurrentLogAnnotations)));
  return Effect.gen(function* () {
    const f = fixture("ssh:remote", true);
    const cause = new Error("Private native owner failure");
    f.failFollower(cause);
    const backend = yield* f.make;
    const error = yield* backend
      .respond(target, syncRequestId, { choice: "Project" }, responder, "follower-failed")
      .pipe(Effect.flip);
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "Native questions are unavailable");
    assert.lengthOf(warnings, 1);
    assert.nestedPropertyVal(warnings[0], "cause.cause", cause);
    assert.equal(f.syncCalls.length, 0);
  }).pipe(Effect.withLogger(logger));
});
