import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  collectCodexAsyncQuestionAnswerRecords,
  expandCodexAsyncQuestions,
} from "../../shared/codex-async-user-input";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { CodexCanonicalServerRequest } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexUserInputQuestion } from "../../shared/types";
import { conversationFollowerRequest } from "../../shared/codex-thread-follower-request";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexConversationProjection } from "../codex-application/CodexConversationProjection";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { CodexServerRequestResponses } from "../codex-application/CodexServerRequestResponses";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import {
  SessionQuestionError,
  type SessionQuestionBackend,
  type SessionQuestionTarget,
  type SessionQuestion,
  type SessionQuestionAnswers,
} from "./SessionQuestions";

const failure = (code: SessionQuestionError["code"], message: string) =>
  new SessionQuestionError({ code, message });
/** Owner failures stay in the log; the calling Agent learns only that questions are unavailable. */
const unavailable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, SessionQuestionError, R> =>
  effect.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Native Session question owner failed").pipe(
        Effect.annotateLogs({ cause }),
        Effect.andThen(Effect.fail(failure("unavailable", "Native questions are unavailable"))),
      ),
    ),
  );
const syncId = (id: string | number) => `native:sync:${JSON.stringify(id)}`;
const asyncId = (id: string) => `native:async:${id}`;
const submissionId = (sessionId: string, requestId: string, operationId: string) =>
  `session-question:${createHash("sha256")
    .update(JSON.stringify([sessionId, requestId, operationId]))
    .digest("hex")}`;

type UserInputRequest = Extract<
  CodexCanonicalServerRequest,
  { method: "item/tool/requestUserInput" }
>;
const syncQuestions = (request: UserInputRequest): SessionQuestion[] =>
  request.params.questions.map((native) => {
    const question = native as typeof native &
      Pick<CodexUserInputQuestion, "multiSelect" | "required">;
    return {
      id: question.id,
      header: question.header,
      question: question.question,
      options: (question.options ?? []).map(({ label, description }) => ({ label, description })),
      multiSelect: question.multiSelect ?? false,
      allowCustomAnswer: !question.options?.length || question.isOther,
      isSecret: question.isSecret ?? false,
      required: question.required ?? false,
    };
  });

/** Normalize exactly as the questionnaire: preset labels, trimmed custom text, omitted blanks. */
const normalizeAnswers = (
  questions: readonly SessionQuestion[],
  answers: SessionQuestionAnswers,
  nativeQuestions: readonly Pick<CodexUserInputQuestion, "id" | "initialAnswer">[] = [],
) =>
  Effect.gen(function* () {
    if (Object.keys(answers).some((id) => !questions.some((question) => question.id === id)))
      return yield* failure("unsupported", "An answer does not belong to this request");
    const result: Record<string, readonly string[]> = {};
    for (const question of questions) {
      const raw = answers[question.id];
      const values = raw === undefined ? [] : typeof raw === "string" ? [raw] : raw;
      const preserveText =
        !question.multiSelect &&
        nativeQuestions.some(
          (native) => native.id === question.id && native.initialAnswer !== undefined,
        );
      const normalized = [
        ...new Set(
          values
            .map((value) =>
              preserveText || question.options.some((option) => option.label === value)
                ? value
                : value.trim(),
            )
            .filter((value) => preserveText || value.length > 0),
        ),
      ];
      if (question.required && normalized.length === 0)
        return yield* failure("unsupported", "A required question needs an answer");
      if (!question.multiSelect && normalized.length > 1)
        return yield* failure("unsupported", "This question accepts one answer");
      if (
        !question.allowCustomAnswer &&
        normalized.some((value) => !question.options.some((option) => option.label === value))
      )
        return yield* failure("unsupported", "This question requires a listed option");
      if (normalized.length) result[question.id] = normalized;
    }
    return result;
  });

/** Read-only admission never resumes, imports or adopts a native Session. Caller authority and
 * runtime/Plan ceilings are checked by the shared Session question service before this backend. */
export const makeNativeSessionQuestions = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const projection = yield* CodexConversationProjection;
  const managers = yield* CodexMainConversationManagers;
  const responses = yield* CodexServerRequestResponses;
  const turns = yield* CodexTurnCommands;
  const admission = yield* Semaphore.make(1);
  const receipts = new Map<string, { fingerprint: string; requestId: string }>();
  const resolve = Effect.fn("NativeSessionQuestions.resolve")(function* (
    target: SessionQuestionTarget,
  ) {
    if (target.execution)
      return yield* failure("unsupported", "Native Sessions do not accept an execution selector");
    const session = yield* workspace.getProjectSession(target.sessionId).pipe(unavailable);
    if (!session) return yield* failure("not_found", "Session not found");
    if (session.archived)
      return yield* failure("forbidden", "Archived Sessions cannot answer questions");
    if (session.executionRef || session.thread?.backendBinding.kind !== "codex")
      return yield* failure("unsupported", "This Session has no native Codex conversation");
    const { threadId, executionHostId: hostId } = session.thread;
    const manager = managers.current(hostId);
    const role = manager?.stream.getRole(threadId);
    if (!manager || !role) return yield* failure("unavailable", "Native execution is not loaded");
    const generation = manager.generation;
    yield* unavailable(Effect.try(() => manager.assertCurrent(generation)));
    const state = yield* projection.read(threadId).pipe(unavailable);
    if (state.canonical.hostId !== hostId || state.snapshot?.resumeState !== "resumed")
      return yield* failure("unavailable", "Native execution is not available");
    const resident = residentConversationTurns(state.canonical);
    const answers = collectCodexAsyncQuestionAnswerRecords(resident);
    const asynchronous = resident.flatMap((turn) =>
      turn.turnId === null
        ? []
        : turn.items.flatMap((item) =>
            expandCodexAsyncQuestions(item).map((question) => ({
              question,
              turnId: turn.turnId!,
              requestId: asyncId(question.id),
            })),
          ),
    );
    const synchronous = state.canonical.requests.filter(
      (request): request is UserInputRequest => request.method === "item/tool/requestUserInput",
    );
    return {
      threadId,
      hostId,
      manager,
      generation,
      role,
      state,
      resident,
      answers,
      asynchronous,
      synchronous,
    };
  });
  type Resolved = Effect.Success<ReturnType<typeof resolve>>;
  const select = (resolved: Resolved, requestId: string) => {
    const sync = resolved.synchronous.find((request) => syncId(request.id) === requestId);
    if (sync) return { kind: "sync" as const, request: sync, questions: syncQuestions(sync) };
    const async = resolved.asynchronous.find((entry) => entry.requestId === requestId);
    if (async && !resolved.answers.has(async.question.id))
      return {
        kind: "async" as const,
        entry: async,
        questions: [
          {
            id: async.question.id,
            header: "",
            question: async.question.title,
            options: async.question.options.map((label) => ({ label })),
            multiSelect: false,
            allowCustomAnswer: true,
            isSecret: async.question.isSecret ?? false,
            required: async.question.required ?? false,
          } satisfies SessionQuestion,
        ],
      };
    return null;
  };
  const missing = (resolved: Resolved, requestId: string) => {
    const answeredSync = resolved.resident
      .flatMap((turn) => turn.items)
      .some((item) => item.type === "userInputResponse" && syncId(item.requestId) === requestId);
    const knownAsync = resolved.asynchronous.some((entry) => entry.requestId === requestId);
    return failure(
      answeredSync || knownAsync ? "not_pending" : "not_found",
      "The question is not pending",
    );
  };
  const backend: SessionQuestionBackend = {
    list: (target) =>
      resolve(target).pipe(
        Effect.map((resolved) => ({
          requestIds: [
            ...resolved.synchronous.map((request) => syncId(request.id)),
            ...resolved.asynchronous
              .filter(({ question }) => !resolved.answers.has(question.id))
              .map(({ requestId }) => requestId),
          ],
        })),
      ),
    read: (target, requestId) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(target);
        const selected = select(resolved, requestId);
        if (!selected) return yield* missing(resolved, requestId);
        return { requestId, questions: selected.questions };
      }),
    respond: (target, requestId, answers, responder, operationId) =>
      admission.withPermit(
        Effect.gen(function* () {
          const resolved = yield* resolve(target);
          const key = JSON.stringify([target.sessionId, operationId]);
          const fingerprint = JSON.stringify([
            resolved.threadId,
            resolved.hostId,
            requestId,
            Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)),
            responder,
          ]);
          const receipt = receipts.get(key);
          if (receipt && receipt.fingerprint !== fingerprint)
            return yield* failure("forbidden", "An answer operation cannot change");
          if (receipt) return { requestId, status: "answered" as const };
          const selected = select(resolved, requestId);
          if (!selected) {
            const previous = resolved.resident
              .flatMap((turn) => turn.items)
              .find(
                (item) => item.type === "userInputResponse" && syncId(item.requestId) === requestId,
              );
            const async = resolved.asynchronous.find((entry) => entry.requestId === requestId);
            const record = async ? resolved.answers.get(async.question.id) : undefined;
            const metadata =
              previous?.type === "userInputResponse"
                ? { operationId: previous.responseOperationId, respondedBy: previous.respondedBy }
                : record;
            if (metadata?.operationId !== operationId) return yield* missing(resolved, requestId);
            const questions =
              previous?.type === "userInputResponse"
                ? previous.questions.map((question) => ({
                    ...question,
                    options: question.options.map((option) => ({ ...option })),
                    allowCustomAnswer: !question.options.length || question.isOther,
                  }))
                : async
                  ? [
                      {
                        id: async.question.id,
                        header: "",
                        question: async.question.title,
                        options: [],
                        allowCustomAnswer: true,
                      },
                    ]
                  : [];
            const normalized = yield* normalizeAnswers(
              questions,
              answers,
              previous?.type === "userInputResponse" ? previous.questions : [],
            );
            const expected =
              previous?.type === "userInputResponse"
                ? previous.answers
                : async && record
                  ? { [async.question.id]: [record.answer] }
                  : {};
            if (
              !isDeepStrictEqual(normalized, expected) ||
              !isDeepStrictEqual(metadata.respondedBy, responder)
            )
              return yield* failure("forbidden", "An answer operation cannot change");
            return { requestId, status: "answered" as const };
          }
          yield* unavailable(
            Effect.try(() => {
              resolved.manager.assertCurrent(resolved.generation);
              if (
                !isDeepStrictEqual(
                  resolved.manager.stream.getRole(resolved.threadId),
                  resolved.role,
                )
              )
                throw new Error("Native question owner changed");
            }),
          );
          const normalized = yield* normalizeAnswers(
            selected.questions,
            answers,
            selected.kind === "sync" ? selected.request.params.questions : [],
          );
          const questionResponse = { respondedBy: responder, operationId };
          if (selected.kind === "async") {
            const answer = normalized[selected.entry.question.id]?.[0];
            if (!answer)
              return yield* failure("unsupported", "An asynchronous question needs an answer");
            const accepted = yield* turns
              .respondAsyncQuestions({
                threadId: resolved.threadId,
                submissionId: submissionId(target.sessionId, requestId, operationId),
                expectedExecution: { hostId: resolved.hostId, generation: resolved.generation },
                sourceTurnIds: [selected.entry.turnId],
                replies: [
                  {
                    questionItemId: selected.entry.question.id,
                    question: selected.entry.question.title,
                    answer,
                  },
                ],
                questionResponse,
              })
              .pipe(unavailable);
            if (!accepted)
              return yield* failure("unavailable", "The native answer was not accepted");
          } else {
            const input = {
              threadId: resolved.threadId,
              requestId: selected.request.id,
              answers: normalized,
              questionResponse,
            };
            const accepted =
              resolved.role.role === "owner"
                ? yield* responses.userInput(input).pipe(unavailable)
                : yield* Effect.tryPromise(async () => {
                    resolved.manager.assertCurrent(resolved.generation);
                    const response = await resolved.manager.coordination.requestThreadFollower({
                      hostId: resolved.hostId,
                      targetClientId:
                        resolved.role.role === "follower" ? resolved.role.ownerClientId : "",
                      request: conversationFollowerRequest("thread-follower-submit-user-input", {
                        conversationId: resolved.threadId,
                        requestId: selected.request.id,
                        response: {
                          answers: Object.fromEntries(
                            Object.entries(normalized).map(([id, values]) => [
                              id,
                              { answers: [...values] },
                            ]),
                          ),
                        },
                        questionResponse,
                      }),
                    });
                    if (response.resultType !== "success")
                      throw new Error(
                        response.resultType === "error"
                          ? response.error
                          : "Native owner is unavailable",
                      );
                    return (
                      response.result !== null &&
                      typeof response.result === "object" &&
                      "ok" in response.result &&
                      response.result.ok === true
                    );
                  }).pipe(unavailable);
            if (!accepted)
              return yield* failure("not_pending", "The question is no longer pending");
          }
          receipts.set(key, { fingerprint, requestId });
          return { requestId, status: "answered" as const };
        }),
      ),
  };
  return backend;
});
