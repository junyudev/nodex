import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import {
  agentRuntimeSnapshotFixture,
  agentRuntimeRow,
} from "../../shared/testing/agent-runtime-snapshot";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import type {
  AgentRuntimeControlInput,
  AgentRuntimeResponseInput,
} from "../../shared/agent-runtime-api";
import { make } from "./RuntimeSessionQuestions";

const questions = [
  {
    id: "format",
    header: "Format",
    question: "Which format?",
    options: [],
    allowCustomAnswer: true,
  },
];
const responder = {
  kind: "agent",
  senderThreadId: "coordinator",
  senderSessionId: "sender-session",
} as const;
const fixture = (
  mode: "live" | "message",
  status: AgentSnapshot["projection"]["runtimeRequests"][number]["status"] = "pending",
  rejection?: "not_found" | "not_pending" | "unsupported",
) => {
  const controls: AgentRuntimeControlInput[] = [];
  const responses: AgentRuntimeResponseInput[] = [];
  const snapshot = agentRuntimeSnapshotFixture({
    projection: {
      nodes: [agentRuntimeRow("nodes", { id: "node", runId: "original-run" })],
      runtimeRequests: [
        agentRuntimeRow("runtimeRequests", {
          id: "request",
          kind: "user_input",
          status,
          nodeId: "node",
          responseCapability:
            mode === "live"
              ? { type: mode, providerSessionId: "provider-session" }
              : { type: mode, replyFormat: "codex_question_reply" },
        }),
        agentRuntimeRow("runtimeRequests", {
          id: "approval",
          kind: "permission",
          status: "pending",
        }),
        agentRuntimeRow("runtimeRequests", {
          id: "mcp",
          kind: "mcp-elicitation",
          status: "pending",
        }),
        agentRuntimeRow("runtimeRequests", {
          id: "answered",
          kind: "user_input",
          status: "resolved",
        }),
      ],
      turnItems: [
        agentRuntimeRow("turnItems", {
          type: "user_input_request",
          requestId: "request",
          questions,
        }),
      ],
    },
  });
  const application = {
    listQuestionIds: () => Effect.succeed({ requestIds: status === "pending" ? ["request"] : [] }),
    control: (target: AgentRuntimeControlInput) =>
      Effect.sync(() => {
        controls.push(target);
        return { snapshot };
      }),
    respond: (input: AgentRuntimeResponseInput) => {
      responses.push(input);
      if (rejection)
        return Effect.fail(
          new AgentRuntimeApplicationError({
            operation: "respond",
            message: "Changed during admission",
            questionReason: rejection,
          }),
        );
      if (status !== "pending")
        return Effect.fail(
          new AgentRuntimeApplicationError({
            operation: "respond",
            message: `Runtime request request is ${status}.`,
          }),
        );
      return Effect.succeed({ sequence: 1 });
    },
  } as unknown as AgentRuntimeApplication["Service"];
  return {
    backend: make.pipe(
      Effect.provideService(AgentRuntimeApplication, application),
      Effect.map((backend) =>
        backend({ runtimeMode: "approval-required", interactionMode: "plan" }),
      ),
    ),
    controls,
    responses,
  };
};

for (const mode of ["live", "message"] as const) {
  for (const execution of [undefined, { threadId: "child" }]) {
    it.effect(
      `lists, reads and answers ${mode} questions on ${execution ? "a child" : "the root"}`,
      () =>
        Effect.gen(function* () {
          const f = fixture(mode);
          const backend = yield* f.backend;
          const target = { sessionId: "session", ...(execution ? { execution } : {}) };
          assert.deepEqual(yield* backend.list(target), { requestIds: ["request"] });
          assert.deepEqual(yield* backend.read(target, "request"), {
            requestId: "request",
            questions,
          });
          assert.deepEqual(
            yield* backend.respond(
              target,
              "request",
              { format: ["Markdown"] },
              responder,
              "operation",
            ),
            { requestId: "request", status: "answered" },
          );
          assert.deepInclude(f.responses[0], {
            sessionId: "session",
            runId: "original-run",
            respondedBy: responder,
            submissionId: "operation",
            requirePending: true,
            modeLimit: { runtimeMode: "approval-required", interactionMode: "plan" },
          });
          assert.equal(f.responses[0]?.threadId, execution?.threadId);
          assert.equal(f.controls[0]?.requestId, "request");
          yield* backend.respond(
            target,
            "request",
            { format: ["Markdown"] },
            responder,
            "operation",
          );
          assert.equal(f.responses[0]?.responseFingerprint, f.responses[1]?.responseFingerprint);
        }),
    );
  }
}

it.effect(
  "excludes unknown, approval and permission elicitation requests from reads and answers",
  () =>
    Effect.gen(function* () {
      const f = fixture("live");
      const backend = yield* f.backend;
      for (const requestId of ["missing", "approval", "mcp"]) {
        assert.equal(
          (yield* backend.read({ sessionId: "session" }, requestId).pipe(Effect.flip)).code,
          "not_found",
        );
        assert.equal(
          (yield* backend
            .respond({ sessionId: "session" }, requestId, {}, responder, "operation")
            .pipe(Effect.flip)).code,
          "not_found",
        );
      }
      assert.equal(f.responses.length, 0);
    }),
);

it.effect(
  "reports answered requests as not pending while allowing the command owner to replay exact retries",
  () =>
    Effect.gen(function* () {
      const f = fixture("message", "resolved");
      const backend = yield* f.backend;
      assert.equal(
        (yield* backend.read({ sessionId: "session" }, "request").pipe(Effect.flip)).code,
        "not_pending",
      );
      assert.equal(
        (yield* backend
          .respond(
            { sessionId: "session" },
            "request",
            { format: "Markdown" },
            responder,
            "fresh-operation",
          )
          .pipe(Effect.flip)).code,
        "not_pending",
      );
    }),
);

for (const reason of ["not_found", "not_pending", "unsupported"] as const) {
  it.effect(
    `retains typed ${reason} failures when a question changes during response admission`,
    () =>
      Effect.gen(function* () {
        const backend = yield* fixture("live", "pending", reason).backend;
        const error = yield* backend
          .respond(
            { sessionId: "session" },
            "request",
            { format: "Markdown" },
            responder,
            "operation",
          )
          .pipe(Effect.flip);
        assert.equal(error.code, reason);
      }),
  );
}
