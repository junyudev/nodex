import { runtimeSessionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import { historyResultBytes, HISTORY_READ_MAX_BYTES } from "@nodex/agent-runtime/history-read";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import type { SessionHistory, SessionProgress } from "../../shared/nodex-app-tools/session-history";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import {
  hasPendingConversationTurnStart,
  latestConversationTurn,
} from "../../shared/codex-conversation-state/codex-turn-selectors";
import { make as makeNativeExecution } from "./NativeSessionExecution";
import { makeNativeSessionSearch } from "./NativeSessionSearch";
import {
  makeSessionSearch,
  type SessionSearchInput,
  type SessionSearchResult,
} from "./SessionSearch";
import { makeNativeSessionHistory } from "./NativeSessionHistory";
import { runtimeSessionHistory } from "./RuntimeSessionHistory";
import {
  readSessionExecutionDetails,
  makeNativeSessionReadDetails,
  type SessionReadExecution,
} from "./SessionReadDetails";
import {
  readSessionHistory,
  readSessionProgress,
  type SessionHistoryInput,
  type SessionHistorySource,
} from "./SessionHistoryRead";
import {
  make as makeDiscovery,
  SessionDiscoveryError,
  type SessionDiscoveryInput,
  type SessionDiscoveryResult,
} from "./SessionDiscovery";

export type { SessionHistoryInput } from "./SessionHistoryRead";
export type SessionListInput = SessionDiscoveryInput;
type Provenance = components["schemas"]["AgentTurnProvenance"];
type AuthorizedSession = Extract<ProjectWorkspaceReadSnapshot["value"], { kind: "agent_session" }>;

export interface SessionAgent {
  readonly providerInstanceId: string;
  readonly model: string;
}
export interface SessionObservationResult {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly title: string;
  readonly backend: "codex" | "acp" | "claude" | "opencode" | null;
  readonly agent: SessionAgent | null;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly status: { readonly type: string; readonly activeFlags: readonly string[] };
  readonly history: SessionHistory;
  readonly execution: SessionReadExecution | null;
}
export class SessionObservationError extends Schema.TaggedError<SessionObservationError>()(
  "SessionObservationError",
  {
    reason: Schema.Literals([
      "authorization",
      "authority_changed",
      "history_unavailable",
      "invalid_cursor",
      "cursor_stale",
      "item_unavailable",
      "source_limit",
    ]),
    cause: Schema.Defect(),
  },
) {}
export interface SessionInspection {
  readonly execution?: { readonly threadId: string };
  readonly sessionId: string;
  readonly title: string;
  readonly backend: SessionObservationResult["backend"];
  readonly agent: SessionAgent | null;
  readonly status: string;
  readonly activeFlags: readonly string[];
  readonly disposition: "running" | "complete" | "needs_attention" | "unavailable";
  readonly cursor: string;
  readonly selectedRunId: string | null;
  readonly runId: string | null;
  /** Internal Runtime revision for the event-replayed wait bridge. */
  readonly executionRevision?: string;
  /** Native admission is in flight and has not acquired its producer Turn identity yet. */
  readonly selectionPending?: true;
  /** Internal readiness fence while the selected Run is awaiting its automatic continuation. */
  readonly continuationPending?: true;
}
export class SessionObservation extends Context.Service<
  SessionObservation,
  {
    readonly inspect: (
      sessionId: string,
      provenance: Provenance,
      runId?: string | null,
      execution?: { readonly threadId: string },
    ) => Effect.Effect<SessionInspection, SessionObservationError>;
    readonly awaitChange: (
      inspection: SessionInspection,
      provenance: Provenance,
      timeoutMs: number,
    ) => Effect.Effect<void, SessionObservationError>;
    readonly search: (
      input: SessionSearchInput,
    ) => Effect.Effect<SessionSearchResult, SessionObservationError>;
    readonly list: (
      input: SessionListInput,
    ) => Effect.Effect<SessionDiscoveryResult, SessionObservationError>;
    readonly read: (
      input: SessionHistoryInput,
      provenance: Provenance,
    ) => Effect.Effect<SessionObservationResult, SessionObservationError>;
    readonly progress: (
      sessionId: string,
      provenance: Provenance,
      runId?: string | null,
      execution?: { readonly threadId: string },
    ) => Effect.Effect<SessionProgress, SessionObservationError>;
  }
>()("nodex/main/app-tools/SessionObservation") {}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bindingOf = ({ session, thread }: AuthorizedSession) => ({
  execution: session.execution_ref ?? null,
  native: thread
    ? { id: thread.thread_id, backend: thread.backend_binding, hostId: thread.execution_host_id }
    : null,
});
const backendOf = (driver: string | null): SessionObservationResult["backend"] =>
  driver === "codex" || driver === "claude" || driver === "opencode" || driver === "acp"
    ? driver
    : null;
const dispositionOf = (
  status: string,
  flags: readonly string[],
  active = false,
): SessionInspection["disposition"] => {
  if (flags.length || ["authentication-required", "failed", "systemError"].includes(status))
    return "needs_attention";
  if (active || ["active", "running", "preparing", "starting", "waiting"].includes(status))
    return "running";
  if (status === "notLoaded") return "unavailable";
  return "complete";
};

/** Target bindings select the history owner for every caller and every configured Provider. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const application = yield* AgentRuntimeApplication;
  const directory = yield* CodexThreadDirectory;
  const native = yield* makeNativeSessionHistory;
  const nativeDetails = yield* makeNativeSessionReadDetails;
  const nativeExecution = yield* makeNativeExecution;
  const discovery = makeDiscovery({ core, sessionCatalog: application.sessionCatalog });
  const nativeSearch = yield* makeNativeSessionSearch;
  const search = yield* makeSessionSearch({
    core,
    sessionSearch: application.sessionSearch,
    sessionSearchResolve: application.sessionSearchResolve,
    sessionMetadata: application.sessionMetadata,
    native: nativeSearch,
  });
  const authorize = Effect.fn("SessionObservation.authorize")(function* (
    sessionId: string,
    provenance: Provenance,
  ) {
    const response = yield* core.workspace
      .read(
        { kind: "agent_session", session_id: sessionId, provenance },
        { deadlineMs: 10_000 },
        provenance.authority.actor_project_id,
      )
      .pipe(
        Effect.mapError((cause) => new SessionObservationError({ reason: "authorization", cause })),
      );
    if (response.value.kind === "agent_session") return response.value;
    return yield* new SessionObservationError({
      reason: "authorization",
      cause: new Error("Unexpected Session authorization result"),
    });
  });
  const unchanged = Effect.fn("SessionObservation.unchanged")(function* (
    before: AuthorizedSession,
    provenance: Provenance,
  ) {
    const after = yield* authorize(before.session.id, provenance);
    if (hash(bindingOf(before)) === hash(bindingOf(after))) return after;
    return yield* new SessionObservationError({
      reason: "authority_changed",
      cause: new Error("Session execution changed during observation"),
    });
  });
  const resolve = Effect.fn("SessionObservation.resolve")(function* (
    before: AuthorizedSession,
    history = true,
    execution?: { readonly threadId: string },
  ): Effect.fn.Return<
    {
      readonly source: SessionHistorySource | null;
      readonly backend: SessionObservationResult["backend"];
      readonly agent: SessionAgent | null;
      readonly threadId: string | null;
      readonly status: string;
      readonly flags: readonly string[];
      readonly active: boolean;
      readonly pendingStart?: boolean;
      readonly revision: unknown;
    },
    SessionObservationError
  > {
    if (execution && !before.session.execution_ref)
      return yield* new SessionObservationError({
        reason: "authorization",
        cause: new Error("Execution targets require a Runtime Session"),
      });
    if (before.session.execution_ref) {
      const loaded = yield* application
        .inspect(
          runtimeSessionTarget({
            sessionId: before.session.id,
            ...(execution ? { execution } : {}),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
          ),
        );
      return {
        source: runtimeSessionHistory(application, before.session.id, undefined, execution),
        backend: backendOf(loaded.thread.providerDriver),
        agent: {
          providerInstanceId: loaded.thread.modelSelection.instanceId,
          model: loaded.thread.modelSelection.model,
        },
        threadId: loaded.threadId,
        status: loaded.thread.status,
        flags: loaded.thread.pendingRuntimeRequest
          ? [loaded.thread.pendingRuntimeRequest.kind]
          : [],
        active: loaded.thread.activeRunId !== null,
        revision: {
          updatedAt: loaded.thread.updatedAt,
          runId: loaded.thread.latestRunId,
          pending: loaded.thread.pendingRuntimeRequest,
        },
      };
    }
    if (before.thread?.backend_binding.kind === "codex") {
      if (!history) {
        const retained = yield* directory
          .resolve({ threadId: before.thread.thread_id, fidelity: "durable" })
          .pipe(
            Effect.mapError(
              (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
            ),
          );
        const canonical = retained?.canonical;
        const latestTurn = latestConversationTurn(canonical);
        const status = canonical?.threadRuntimeStatus;
        const snapshot = retained?.snapshot;
        return {
          source: null,
          backend: "codex",
          agent: null,
          threadId: before.thread.thread_id,
          status: status?.type ?? snapshot?.statusType ?? before.thread.status.status_type,
          flags:
            status?.type === "active"
              ? status.activeFlags
              : (snapshot?.statusActiveFlags ?? before.thread.status.active_flags),
          active: latestTurn?.status === "inProgress" || hasPendingConversationTurnStart(canonical),
          pendingStart:
            (latestTurn?.status === "inProgress" && latestTurn.turnId === null) ||
            canonical?.unconfirmedTurnSubmissions?.some(
              (submission) => submission.method === "turn/start",
            ) === true,
          revision: {
            turn: latestTurn
              ? { id: latestTurn.turnId, status: latestTurn.status }
              : snapshot?.turns.at(-1) && {
                  id: snapshot.turns.at(-1)?.turnId,
                  status: snapshot.turns.at(-1)?.status,
                },
            pending: canonical?.unconfirmedTurnSubmissions?.map((submission) => [
              submission.requestId,
              submission.clientUserMessageId,
              submission.stage,
            ]),
            requests: snapshot?.requests.map((request) => request.requestId),
            updatedAt: before.thread.updated_at,
          },
        };
      }
      const loaded = yield* native(
        before.thread.thread_id,
        before.thread.execution_host_id ?? undefined,
      ).pipe(
        Effect.mapError((cause) => new SessionObservationError({ reason: cause.reason, cause })),
      );
      return {
        source: loaded.source,
        backend: "codex",
        agent: null,
        threadId: loaded.thread.id,
        status: loaded.thread.status.type,
        flags: loaded.thread.status.type === "active" ? loaded.thread.status.activeFlags : [],
        active: loaded.thread.status.type === "active",
        revision: loaded.thread.updatedAt,
      };
    }
    return {
      source: null,
      backend: before.thread?.backend_binding.kind ?? null,
      agent: null,
      threadId: before.thread?.thread_id ?? null,
      status: before.thread ? "notLoaded" : "idle",
      flags: [],
      active: false,
      revision: null,
    };
  });
  const mapReadError = (cause: { readonly reason: SessionObservationError["reason"] }) =>
    new SessionObservationError({ reason: cause.reason, cause });
  return SessionObservation.of({
    search: (input) =>
      search(input).pipe(
        Effect.mapError(
          (cause) =>
            new SessionObservationError({
              reason:
                cause instanceof SessionDiscoveryError &&
                (cause.reason === "invalid_cursor" ||
                  cause.reason === "cursor_stale" ||
                  cause.reason === "source_limit")
                  ? cause.reason
                  : "history_unavailable",
              cause,
            }),
        ),
      ),
    list: (input) =>
      discovery(input).pipe(
        Effect.mapError(
          (cause) =>
            new SessionObservationError({
              reason: cause.reason === "invalid_cursor" ? "invalid_cursor" : "history_unavailable",
              cause,
            }),
        ),
      ),
    inspect: (sessionId, provenance, runId, executionTarget) =>
      Effect.gen(function* () {
        const before = yield* authorize(sessionId, provenance);
        const resolved = yield* resolve(before, false, executionTarget);
        const execution = before.session.execution_ref
          ? yield* application
              .execution({
                ...runtimeSessionTarget({
                  sessionId,
                  ...(executionTarget ? { execution: executionTarget } : {}),
                }),
                ...(runId === undefined ? {} : { runId }),
              })
              .pipe(
                Effect.mapError(
                  (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
                ),
              )
          : before.thread?.backend_binding.kind === "codex"
            ? yield* nativeExecution({
                threadId: before.thread.thread_id,
                ...(before.thread.execution_host_id
                  ? { hostId: before.thread.execution_host_id }
                  : {}),
                ...(runId === undefined ? {} : { runId }),
              }).pipe(
                Effect.mapError(
                  (cause) => new SessionObservationError({ reason: cause.reason, cause }),
                ),
              )
            : null;
        if (runId && !execution)
          return yield* new SessionObservationError({
            reason: "item_unavailable",
            cause: new Error("This Session has no readable Run"),
          });
        const nativeCurrent =
          execution?.runId !== null &&
          execution?.runId ===
            (typeof resolved.revision === "object" &&
            resolved.revision !== null &&
            "turn" in resolved.revision
              ? (resolved.revision as { turn?: { id: string } }).turn?.id
              : undefined);
        // A native start is already accepted work even before app-server publishes its Turn.
        // Do not pin an older completed Turn (or an empty Session) while that identity is pending.
        const selectionPending = runId === undefined && resolved.pendingStart === true;
        const selectedRunId = selectionPending ? null : (execution?.selectedRunId ?? null);
        const status = selectionPending
          ? "starting"
          : execution
            ? (execution.status ?? "idle")
            : resolved.status;
        const flags = selectionPending
          ? resolved.flags
          : execution && "activeFlags" in execution
            ? execution.activeFlags
            : nativeCurrent
              ? resolved.flags
              : [];
        const active =
          selectionPending ||
          (execution && "continuationPending" in execution
            ? execution.continuationPending ||
              ["queued", "preparing", "starting", "running", "waiting"].includes(
                execution.status ?? "",
              )
            : execution?.status === "inProgress");
        const after = yield* unchanged(before, provenance);
        return {
          sessionId,
          title: after.session.display_title,
          backend: resolved.backend,
          agent: resolved.agent,
          ...(executionTarget ? { execution: executionTarget } : {}),
          selectedRunId,
          runId: selectionPending ? null : (execution?.runId ?? null),
          ...(selectionPending ? { selectionPending: true as const } : {}),
          ...(execution && "continuationPending" in execution && execution.continuationPending
            ? { continuationPending: true as const }
            : {}),
          ...(execution && "continuationPending" in execution
            ? { executionRevision: execution.revision }
            : {}),
          status,
          activeFlags: flags,
          disposition: dispositionOf(status, flags, active),
          cursor: `nxs4.${hash({
            binding: bindingOf(after),
            execution: executionTarget ?? null,
            title: after.session.display_title,
            archived: after.session.archived,
            selectedRunId,
            status,
            flags,
            revision: selectionPending
              ? resolved.revision
              : (execution?.revision ?? resolved.revision),
          })}`,
        };
      }).pipe(Effect.provideService(CoreApplicationAgent, provenance)),
    awaitChange: (inspection, provenance, timeoutMs) =>
      Effect.gen(function* () {
        if (inspection.executionRevision === undefined) return yield* Effect.never;
        const before = yield* authorize(inspection.sessionId, provenance);
        yield* application
          .waitExecution({
            ...runtimeSessionTarget(inspection),
            runId: inspection.selectedRunId,
            afterRevision: inspection.executionRevision,
            timeoutMs: Math.min(20000, timeoutMs),
          })
          .pipe(
            Effect.mapError(
              (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
            ),
          );
        yield* unchanged(before, provenance);
      }).pipe(Effect.provideService(CoreApplicationAgent, provenance)),
    read: (input, provenance) =>
      Effect.gen(function* () {
        const before = yield* authorize(input.sessionId, provenance);
        const resolved = yield* resolve(before, true, input.execution);
        const base = {
          schemaVersion: 2 as const,
          sessionId: before.session.id,
          projectId: before.session.project_id ?? null,
          threadId: resolved.threadId,
          title: before.session.display_title,
          backend: resolved.backend,
          agent: resolved.agent,
          archived: before.session.archived,
          pinned: before.session.pinned,
          status: { type: resolved.status, activeFlags: resolved.flags },
        };
        if (!resolved.source) {
          if (input.itemId !== undefined)
            return yield* new SessionObservationError({
              reason: "item_unavailable",
              cause: new Error("This Session has no readable item"),
            });
          if (input.cursor)
            return yield* new SessionObservationError({
              reason: "invalid_cursor",
              cause: new Error("This Session has no readable history"),
            });
          yield* unchanged(before, provenance);
          const history: SessionHistory = before.thread
            ? { availability: "unavailable", reason: "backend_not_loaded", items: [] }
            : { availability: "empty", items: [] };
          return { ...base, execution: null, history };
        }
        const binding = hash({
          binding: bindingOf(before),
          execution: input.execution ?? null,
          profile: provenance.profile_id,
          epoch: provenance.authority.store_epoch,
        });
        const execution =
          before.session.execution_ref && resolved.threadId
            ? yield* readSessionExecutionDetails({
                application,
                sessionId: input.sessionId,
                threadId: resolved.threadId,
                runtimeId: before.session.execution_ref!.runtime_id,
                binding,
                runLimit: input.runLimit ?? 10,
                ...(input.runCursor === undefined ? {} : { runCursor: input.runCursor }),
                base,
              }).pipe(Effect.mapError(mapReadError))
            : before.thread?.backend_binding.kind === "codex"
              ? yield* nativeDetails({
                  sessionId: input.sessionId,
                  threadId: before.thread.thread_id,
                  ...(before.thread.execution_host_id == null
                    ? {}
                    : { hostId: before.thread.execution_host_id }),
                  binding,
                  runLimit: input.runLimit ?? 10,
                  ...(input.runCursor === undefined ? {} : { runCursor: input.runCursor }),
                  base,
                }).pipe(Effect.mapError(mapReadError))
              : null;
        if (input.runCursor && execution === null)
          return yield* new SessionObservationError({
            reason: "invalid_cursor",
            cause: new Error("This Session has no Runtime Run history"),
          });
        const { history, admitted } = yield* readSessionHistory({
          request: input,
          binding,
          source: resolved.source,
          wrap: (history) => ({ ...base, execution, history }),
        }).pipe(Effect.mapError(mapReadError));
        const after = yield* unchanged(before, provenance);
        const result = { ...base, projectId: after.session.project_id ?? null, execution, history };
        if (historyResultBytes(result) > HISTORY_READ_MAX_BYTES)
          return yield* new SessionObservationError({
            reason: "source_limit",
            cause: new Error("Session metadata changed beyond the response budget"),
          });
        if (
          provenance.authority.runtime?.turn_kind === "run" &&
          before.session.execution_ref &&
          history.availability === "available"
        ) {
          if (admitted.length)
            yield* application
              .acknowledgeRead({ ...runtimeSessionTarget(input), items: admitted })
              .pipe(
                Effect.mapError(
                  (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
                ),
              );
        }
        return result;
      }).pipe(Effect.provideService(CoreApplicationAgent, provenance)),
    progress: (sessionId, provenance, runId, executionTarget) =>
      Effect.gen(function* () {
        const before = yield* authorize(sessionId, provenance);
        const resolved = yield* resolve(before, true, executionTarget);
        const source =
          runId === undefined
            ? resolved.source
            : runId === null
              ? null
              : before.session.execution_ref
                ? runtimeSessionHistory(application, sessionId, runId, executionTarget)
                : before.thread?.backend_binding.kind === "codex"
                  ? (yield* native(
                      before.thread.thread_id,
                      before.thread.execution_host_id ?? undefined,
                      runId,
                    ).pipe(Effect.mapError(mapReadError))).source
                  : resolved.source;
        if (!source) {
          yield* unchanged(before, provenance);
          return {
            availability:
              runId === null || !before.thread ? ("empty" as const) : ("unavailable" as const),
            coverage:
              runId === null || !before.thread ? ("complete" as const) : ("unavailable" as const),
            nextCursor: null,
            latestMessage: null,
            latestTool: null,
          };
        }
        const result = yield* readSessionProgress({
          sessionId,
          binding: hash({
            binding: bindingOf(before),
            execution: executionTarget ?? null,
            profile: provenance.profile_id,
            epoch: provenance.authority.store_epoch,
          }),
          source,
        }).pipe(Effect.mapError(mapReadError));
        yield* unchanged(before, provenance);
        return result;
      }).pipe(Effect.provideService(CoreApplicationAgent, provenance)),
  });
});

export const live = Layer.effect(SessionObservation, make);
