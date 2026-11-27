import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { components } from "@nodex/core-protocol";
import type { ProjectWorkspaceReadSnapshot } from "../../main/core-client/types";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import {
  unavailableManagedChatFacts,
  type ManagedChatFacts as ChatFacts,
} from "./managed-chat-observation";

export const managedChatFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const millis = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export const managedChatTerminal = (
  status: string | null | undefined,
): ChatFacts["terminalStatus"] => {
  if (status === "cancelled" || status === "interrupted") return "interrupted";
  return status === "completed" || status === "failed" ? status : null;
};
export const managedChatState = (
  status: string | null | undefined,
  pending: number,
): ChatFacts["state"] => {
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

type ManagedSession = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "session" }
>["session"];
type ScopedObserver = components["schemas"]["SessionScopedObserver"];
type RuntimeSnapshot = NonNullable<
  Effect.Success<ReturnType<AgentRuntimeApplication["Service"]["observeSessionMetadata"]>>
>;
const runtimeFacts = (
  binding: ManagedSession["execution_ref"],
  metadata: RuntimeSnapshot["metadata"],
  snapshot: RuntimeSnapshot | RuntimeSnapshot["scoped"][number],
): ChatFacts => {
  const { execution, details, lastReply } = snapshot;
  const scoped = "scope" in snapshot;
  const activity = scoped ? null : snapshot.activity;
  const run = details.recentRuns.find((run) => run.runId === execution.runId);
  const runStartedAt = millis(run?.startedAt);
  const earlier = details.latestStartedRun;
  const earlierStartedAt = millis(earlier?.startedAt);
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
  const working =
    execution.status !== "queued" &&
    (activity?.hasWork || details.scopedActivity?.hasWork || execution.continuationPending);
  return {
    agent: {
      instanceId: (scoped && run?.providerInstanceId) || metadata.providerInstanceId,
      model: (scoped && run?.model) || metadata.model,
      effort: metadata.effort,
    },
    waitingAdmissions: scoped
      ? details.waitingAdmissions.filter((queued) => queued.runId === execution.runId)
      : details.waitingAdmissions,
    state: managedChatState(
      working ? "working" : execution.status,
      Math.max(pendingRequests.length, activity?.pendingRequestCount ?? 0),
    ),
    interruptRequested: run?.interruptRequested ?? false,
    runId: execution.runId,
    runStartedAt,
    ...(!scoped && runStartedAt === null && earlier && earlierStartedAt !== null
      ? { earlierRunStart: { runId: earlier.runId, startedAt: earlierStartedAt } }
      : {}),
    terminalStatus: working ? null : managedChatTerminal(execution.status),
    pendingRequests,
    ...(lastReply ? { lastReplyExcerpt: lastReply } : {}),
    ...(run?.failureMessage ? { failureReason: run.failureMessage } : {}),
    progressFingerprint:
      (activity?.awaitingCommands ?? details.scopedActivity?.awaitingCommands)
        ? null
        : managedChatFingerprint([
            binding,
            execution.runId,
            execution.revision,
            ...(!scoped
              ? [metadata.itemCount, activity?.updatedAt]
              : [details.scopedActivity?.progressAt]),
          ]),
  };
};

export class NativeManagedChatFacts extends Context.Service<
  NativeManagedChatFacts,
  {
    readonly read: (
      session: ManagedSession,
      includeLastReply: boolean,
      scopes: readonly ScopedObserver[],
    ) => Effect.Effect<ChatFacts, unknown>;
  }
>()("nodex/host/NativeManagedChatFacts") {}

/** Reads owner metadata only; an absent or replaced owner never supplies a terminal fact. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeManagedChatFacts));
  const read = Effect.fn("ManagedChatFacts.read")(
    function* (
      sessionId: string,
      includeLastReply = false,
      scopes: readonly ScopedObserver[] = [],
    ) {
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
        const snapshot = yield* runtime.observeSessionMetadata({
          sessionId,
          includeLastReply: includeLastReply || !!session.page_turn,
          scopes,
        });
        if (!snapshot) return unavailableManagedChatFacts;
        facts = {
          ...runtimeFacts(binding, snapshot.metadata, snapshot),
          scoped: (snapshot.scoped ?? []).map((scoped) => ({
            scope: scoped.scope,
            facts: runtimeFacts(binding, snapshot.metadata, scoped),
          })),
        };
      } else {
        if (!native) return unavailableManagedChatFacts;
        facts = yield* native.read(session, includeLastReply || !!session.page_turn, scopes);
      }
      const after = yield* core.workspace.read(
        { kind: "session", session_id: sessionId },
        undefined,
        null,
      );
      if (
        after.value.kind !== "session" ||
        after.value.session.archived ||
        managedChatFingerprint([session.execution_ref, session.thread_id]) !==
          managedChatFingerprint([after.value.session.execution_ref, after.value.session.thread_id])
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
