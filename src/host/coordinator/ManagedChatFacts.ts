import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  unavailableManagedChatFacts,
  type ManagedChatFacts as ChatFacts,
} from "./managed-chat-observation";

const millis = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
  if (status === "cancelled" || status === "interrupted") return "interrupted";
  return status === "completed" || status === "failed" ? status : null;
};
  if (pending > 0) return "waiting";
  if (status === "queued") return "queued";
  if (
    ["working", "preparing", "starting", "running", "waiting", "inProgress", "active"].includes(
      status ?? "",
    )
  )
    return "working";
  if (["failed", "cancelled", "interrupted"].includes(status ?? "")) return "failed";
  return "idle";
};

/** Reads owner metadata only; an absent or replaced owner never supplies a terminal fact. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const read = Effect.fn("ManagedChatFacts.read")(
    function* (sessionId: string) {
      const before = yield* core.workspace.read(
        { kind: "session", session_id: sessionId },
        undefined,
        null,
      );
      if (before.value.kind !== "session" || before.value.session.archived)
        return unavailableManagedChatFacts;
      const session = before.value.session;
      const binding = session.execution_ref;
      let facts: ChatFacts;
      if (binding) {
        const snapshot = yield* runtime.observeSessionMetadata({ sessionId });
        if (!snapshot) return unavailableManagedChatFacts;
        const { metadata, execution, details } = snapshot;
        const run = details.recentRuns.find((run) => run.runId === execution.runId);
        const pendingRequests = details.pendingRequests.map((request) => ({
          id: request.id,
          kind: request.kind,
          ...(request.questions.length
            ? {
                question: request.questions.map((q) => q.question).join("\n"),
                questions: request.questions,
              }
            : {}),
        }));
        facts = {
          agent: {
            instanceId: metadata.providerInstanceId,
            model: metadata.model,
            effort: metadata.effort,
          },
          waitingAdmissions: details.waitingAdmissions,
            execution.status === "queued"
              ? "queued"
              : execution.continuationPending
                ? "working"
                : execution.status,
            pendingRequests.length,
          ),
          interruptRequested: run?.interruptRequested ?? false,
          runId: execution.runId,
          runStartedAt: millis(run?.startedAt ?? run?.requestedAt),
          pendingRequests,
          ...(run?.failureMessage ? { failureReason: run.failureMessage } : {}),
            binding,
            execution.runId,
            execution.revision,
            metadata.itemCount,
          ]),
        };
      } else {
      }
      const after = yield* core.workspace.read(
        { kind: "session", session_id: sessionId },
        undefined,
        null,
      );
      if (
        after.value.kind !== "session" ||
        after.value.session.archived ||
      )
        return unavailableManagedChatFacts;
      return facts;
    },
    Effect.timeout("20 seconds"),
    Effect.orElseSucceed(() => unavailableManagedChatFacts),
  );
  return { read };
});
export class ManagedChatFacts extends Context.Service<
  ManagedChatFacts,
  Effect.Success<typeof make>
>()("nodex/ManagedChatFacts") {}
export const live = Layer.effect(ManagedChatFacts, make);
