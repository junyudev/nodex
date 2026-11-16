import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { makeNativeSessionReadDetails } from "../app-tools/NativeSessionReadDetails";
import { latestConversationTurn } from "../../shared/codex-conversation-state/codex-turn-selectors";
import {
  NativeManagedChatFacts,
  managedChatFingerprint as hash,
  managedChatState as state,
  managedChatTerminal as terminal,
} from "../../host/coordinator/ManagedChatFacts";
import {
  unavailableManagedChatFacts,
  type ManagedChatRequest,
} from "../../host/coordinator/managed-chat-observation";

/** Native Codex chats stay with their desktop conversation owner. */
export const live = Layer.effect(
  NativeManagedChatFacts,
  Effect.gen(function* () {
    const directory = yield* CodexThreadDirectory;
    const subagents = yield* CodexSubagentDirectory;
    const nativeDetails = yield* makeNativeSessionReadDetails;
    return {
      read: Effect.fn("NativeManagedChatFacts.read")(function* (session) {
        if (!session.thread_id) return unavailableManagedChatFacts;
        const entry = yield* directory.resolve({
          threadId: session.thread_id,
          fidelity: "durable",
        });
        if (!entry || entry.durable.backendBinding.kind !== "codex")
          return unavailableManagedChatFacts;
        const details = yield* nativeDetails({
          threadId: session.thread_id,
          hostId: entry.durable.executionHostId,
          sessionId: session.id,
          binding: hash([session.thread_id, entry.durable.executionHostId]),
          runLimit: 1,
          base: {},
        });
        if (details.metadata.status.type === "notLoaded") return unavailableManagedChatFacts;
        const run = details.recentRuns[0];
        const live = latestConversationTurn(entry.canonical);
        const current = live && live.turnId === run?.runId ? live : null;
        const pendingRequests: ManagedChatRequest[] = (
          entry.snapshot?.requests ?? []
        ).flatMap<ManagedChatRequest>((request) => {
          if (request.type === "permissionRequest" && request.completed) return [];
          if (request.type === "userInput")
            return [
              {
                id: String(request.requestId),
                kind: "question" as const,
                question: request.questions.map((q) => q.question).join("\n"),
                questions: request.questions,
              },
            ];
          return [
            {
              id: String(request.requestId),
              kind: "approval" as const,
              ...("reason" in request && request.reason ? { question: request.reason } : {}),
            },
          ];
        });
        const flags =
          details.metadata.status.type === "active" ? details.metadata.status.activeFlags : [];
        const status = current?.status ?? run?.status;
        const overview = yield* subagents.readKnownOverview({ rootThreadId: session.thread_id });
        const active = (overview.rows ?? overview.active.rows).filter(
          (row) => row.status === "active" || row.status === "waiting",
        );
        const waiting = pendingRequests.length > 0 || flags.length > 0;
        const working =
          active.length > 0 ||
          (details.metadata.status.type === "active" && !waiting) ||
          state(status, 0) === "working";
        if (!working && overview.completeness !== "complete") return unavailableManagedChatFacts;
        return {
          ...(entry.durable.executionProfile?.modelId
            ? {
                agent: {
                  instanceId: "codex",
                  model: entry.durable.executionProfile.modelId,
                  effort: entry.durable.executionProfile.reasoningEffort ?? null,
                },
              }
            : {}),
          state: waiting ? "waiting" : working ? "working" : state(status, 0),
          interruptRequested: status === "interrupted",
          runId: run?.runId ?? null,
          runStartedAt:
            current?.turnStartedAtMs ?? (run?.startedAt == null ? null : run.startedAt * 1000),
          terminalStatus: working ? null : terminal(status),
          pendingRequests,
          progressFingerprint: hash([
            session.thread_id,
            entry.durable.executionHostId,
            run?.runId,
            entry.durable.updatedAt,
            details.metadata.updatedAt,
            active.map((row) => [row.threadId, row.lastActivityAtMs]),
          ]),
        };
      }),
    };
  }),
);
