import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeSessionDetailsFixture } from "@nodex/agent-runtime/orchestration/testkit/SessionDetailsFixture";
import { layerMemory } from "../../../packages/agent-runtime/src/persistence/Sqlite";
import { readSessionDetails } from "@nodex/agent-runtime/orchestration/SessionReadDetails";
import { inboxReplyDestination } from "./inbox-replies";
import { decideInboxReply } from "./inbox-replies";

type Control = Parameters<typeof decideInboxReply>[2];
const control = (
  input: {
    kind?: string;
    capability?: string;
    requests?: number;
  } = {},
): Control =>
  ({
    threadId: "thread",
    snapshot: {
      projection: {
        runtimeRequests: Array.from({ length: input.requests ?? 1 }, (_, i) => ({
          id: `request:${i}`,
          nodeId: "node",
          kind: input.kind ?? "user_input",
          status: "pending",
          responseCapability: { type: input.capability ?? "live" },
        })),
        nodes: [{ id: "node", threadId: "thread", runId: "run" }],
        turnItems: [],
      },
    },
  }) as unknown as Control;
const question = (allowCustomAnswer = true) => ({
  id: "choice",
  header: "Choose",
  question: "Which approach?",
  allowCustomAnswer,
  options: [{ label: "Small change", description: "Keep the scope small" }],
});

const details = (questions = [question()]) => ({
  pendingRequests: [{ id: "request:0", kind: "question" as const, questions }],
});

describe("person replies", () => {
  it("sends the person's unchanged words when no request is pending", () => {
    expect(
      decideInboxReply("result", "  Please follow up.\n", control({ requests: 0 }), details()),
    ).toEqual({
      type: "send",
    });
  });
  it.each(["live", "message"])(
    "answers a %s question with the exact option label",
    (capability) => {
      expect(
        decideInboxReply("attention", "  SMALL Change  ", control({ capability }), details()),
      ).toEqual({
        type: "answer",
        response: {
          request_id: "request:0",
          run_id: "run",
          question_id: "choice",
          answer: "Small change",
        },
      });
    },
  );
  it("retains the person's free-form answer", () => {
    expect(
      decideInboxReply("attention", "  Try a different approach.\n", control(), details()),
    ).toMatchObject({
      response: { answer: "  Try a different approach.\n" },
    });
  });
  it.each([{ kind: "command" }, { requests: 2 }, { capability: "not_resumable" }])(
    "routes ambiguous or unavailable answers through Nodex: %j",
    (input) => {
      expect(decideInboxReply("attention", "Not an option", control(input), details())).toBeNull();
    },
  );
  it.each([[question(), { ...question(), id: "another" }], [question(false)]])(
    "routes ambiguous answers through Nodex",
    (...questions) => {
      expect(
        decideInboxReply("attention", "Not an option", control(), details(questions)),
      ).toBeNull();
    },
  );
  it("keeps result and problem replies with pending questions out of the blocked queue", () => {
    expect(decideInboxReply("result", "Small change", control(), details())).toBeNull();
    expect(decideInboxReply("problem", "Small change", control(), details())).toBeNull();
  });
});

// Exercise the Runtime metadata query against its persisted projection. Control snapshots
// have no transcript items, even when a pending request is resumable.
it.effect("answers and previews a question from the Runtime's transcript-free read path", () =>
  Effect.gen(function* () {
    const fixture = yield* makeSessionDetailsFixture("thread", "run");
    const questions = [{ ...question(), options: [{ label: "Cedar", description: "Cedar" }] }];
    yield* fixture.addQuestion({
      requestId: "request:0",
      status: "pending",
      responseCapability: { type: "live" },
      questions,
    });
    const metadata = yield* readSessionDetails("thread", 1);
    const dispatch = decideInboxReply("attention", " cedar ", control(), metadata);
    expect(dispatch).toEqual({
      type: "answer",
      response: { request_id: "request:0", run_id: "run", question_id: "choice", answer: "Cedar" },
    });
    expect(inboxReplyDestination({ sessionId: "chat", title: "Choose wood" }, dispatch)).toEqual({
      kind: "answer",
      chat: { sessionId: "chat", title: "Choose wood" },
    });
    yield* fixture.updateQuestion("request:0", {
      status: "resolved",
      responseCapability: { type: "live" },
    });
    expect(
      decideInboxReply("attention", "Cedar", control(), yield* readSessionDetails("thread", 1)),
    ).toBeNull();
  }).pipe(Effect.provide(layerMemory)),
);
