import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import {
  hasPendingConversationTurnStart,
  latestConversationTurn,
} from "../../shared/codex-conversation-state/codex-turn-selectors";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import {
  CodexReadThreadHistory,
  type CodexReadThreadHistoryResult,
} from "../codex-application/CodexReadThreadHistory";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";

type Provenance = components["schemas"]["AgentTurnProvenance"];
type AuthorizedSession = Extract<ProjectWorkspaceReadSnapshot["value"], { kind: "agent_session" }>;

export interface SessionHistoryInput {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly turnLimit: number;
  readonly includeOutputs: boolean;
  readonly maxOutputCharsPerItem: number;
}

type AvailableHistory = {
  readonly availability: "available";
  readonly coverage: "backend" | "retained";
  readonly page: CodexReadThreadHistoryResult["page"];
  readonly turns: readonly Record<string, unknown>[];
};
type SessionHistory =
  | AvailableHistory
  | { readonly availability: "empty"; readonly turns: readonly [] }
  | { readonly availability: "unavailable"; readonly reason: "backend_not_loaded" };

/** The configured Agent and model a Runtime Session's next message runs on. */
export interface SessionAgent {
  readonly providerInstanceId: string;
  readonly model: string;
}

export interface SessionObservationResult {
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
}

export class SessionObservationError extends Schema.TaggedError<SessionObservationError>()(
  "SessionObservationError",
  {
    reason: Schema.Literals([
      "authorization",
      "authority_changed",
      "history_unavailable",
      "invalid_cursor",
    ]),
    cause: Schema.Defect(),
  },
) {}

export interface SessionListInput {
  readonly archived: boolean;
  readonly cursor?: string;
  readonly limit: number;
}

type SessionListingItem =
  components["schemas"]["CollectionWindow_ProjectWorkspaceSessionListingItem"]["items"][number];
const listingPlacement = (item: SessionListingItem) => {
  if (item.task.session.pinned) return { kind: "pinned", source: "session" };
  if (item.direct_section_id)
    return { kind: "section", source: "session", sectionId: item.direct_section_id };
  if (item.project_section_id)
    return { kind: "section", source: "project", sectionId: item.project_section_id };
  if (item.project_pinned) return { kind: "pinned", source: "project" };
  return { kind: "default", source: item.task.session.project_id ? "project" : "session" };
};
const listingSummary = ({ task, ...placement }: SessionListingItem) => ({
  sessionId: task.session.id,
  projectId: task.session.project_id ?? null,
  projectName: placement.project_name ?? null,
  threadId: task.thread?.thread_id ?? null,
  title: task.session.display_title,
  preview: task.thread?.thread_preview ?? "",
  backend: task.thread?.backend_binding.kind ?? null,
  status: task.thread?.status ?? { status_type: "idle", active_flags: [] },
  archived: task.session.archived,
  pinned: task.session.pinned,
  recencyAt: task.thread?.recency_at ?? null,
  placement: listingPlacement({ task, ...placement }),
});
type SessionListResult = {
  readonly sessions: readonly ReturnType<typeof listingSummary>[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
};

export interface SessionInspection {
  readonly sessionId: string;
  readonly title: string;
  readonly backend: "codex" | "acp" | "claude" | "opencode" | null;
  readonly agent: SessionAgent | null;
  readonly status: string;
  readonly activeFlags: readonly string[];
  readonly disposition: "running" | "complete" | "needs_attention" | "unavailable";
  readonly cursor: string;
}

const disposition = (
  status: string,
  activeFlags: readonly string[],
  executionInProgress = false,
): SessionInspection["disposition"] => {
  if (
    activeFlags.length > 0 ||
    status === "authentication-required" ||
    status === "failed" ||
    status === "systemError"
  )
    return "needs_attention";
  if (executionInProgress) return "running";
  if (status === "active" || status === "running") return "running";
  if (status === "idle") return "complete";
  return "unavailable";
};

export class SessionObservation extends Context.Service<
  SessionObservation,
  {
    readonly inspect: (
      sessionId: string,
      provenance: Provenance,
    ) => Effect.Effect<SessionInspection, SessionObservationError>;
    readonly list: (
      input: SessionListInput,
    ) => Effect.Effect<SessionListResult, SessionObservationError>;
    readonly read: (
      input: SessionHistoryInput,
      provenance: Provenance,
    ) => Effect.Effect<SessionObservationResult, SessionObservationError>;
  }
>()("nodex/main/app-tools/SessionObservation") {}

const bindingKey = ({ session, thread }: AuthorizedSession): string =>
  JSON.stringify({
    projectId: session.project_id,
    threadId: thread?.thread_id,
    backend: thread?.backend_binding,
  });

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const codex = yield* CodexReadThreadHistory;
  const directory = yield* CodexThreadDirectory;
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
    if (response.value.kind !== "agent_session")
      return yield* new SessionObservationError({
        reason: "authorization",
        cause: new Error("Core returned an unexpected Session authorization result"),
      });
    return response.value;
  });

  const history = Effect.fn("SessionObservation.history")(function* (
    session: AuthorizedSession,
    input: SessionHistoryInput,
  ): Effect.fn.Return<SessionHistory, SessionObservationError> {
    if (!session.thread) {
      if (input.cursor)
        return yield* new SessionObservationError({
          reason: "invalid_cursor",
          cause: new Error("A draft has no history cursor"),
        });
      return { availability: "empty", turns: [] };
    }
    if (session.thread.backend_binding.kind === "codex") {
      const result = yield* codex.read({ ...input, threadId: session.thread.thread_id }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionObservationError({
              reason: cause.reason === "unknown-cursor" ? "invalid_cursor" : "history_unavailable",
              cause,
            }),
        ),
      );
      return {
        availability: "available",
        coverage: "backend",
        page: result.page,
        turns: result.turns,
      };
    }
    return { availability: "unavailable", reason: "backend_not_loaded" };
  });

  return SessionObservation.of({
    inspect: Effect.fn("SessionObservation.inspect")(function* (sessionId, provenance) {
      const before = yield* authorize(sessionId, provenance);
      const thread = before.thread;
      const retained =
        thread?.backend_binding.kind === "codex"
          ? yield* directory
              .resolve({ threadId: thread.thread_id, fidelity: "durable" })
              .pipe(
                Effect.mapError(
                  (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
                ),
              )
          : null;
      const after = yield* authorize(sessionId, provenance);
      if (bindingKey(before) !== bindingKey(after))
        return yield* new SessionObservationError({
          reason: "authority_changed",
          cause: new Error("Session ownership changed during observation"),
        });
      const snapshot = retained?.snapshot;
      const canonicalStatus = retained?.canonical?.threadRuntimeStatus;
      const status =
        canonicalStatus?.type ?? snapshot?.statusType ?? after.thread?.status.status_type ?? "idle";
      const canonicalActiveFlags =
        canonicalStatus?.type === "active" ? canonicalStatus.activeFlags : undefined;
      const activeFlags =
        canonicalActiveFlags ??
        snapshot?.statusActiveFlags ??
        after.thread?.status.active_flags ??
        [];
      const canonical = retained?.canonical;
      const latestTurn = latestConversationTurn(canonical);
      const executionInProgress =
        thread?.backend_binding.kind === "codex" &&
        (latestTurn?.status === "inProgress" || hasPendingConversationTurnStart(canonical));
      const lastTurn = canonical ? latestTurn : snapshot?.turns.at(-1);
      const cursor =
        "nxs1." +
        createHash("sha256")
          .update(
            JSON.stringify({
              profileId: provenance.profile_id,
              binding: bindingKey(after),
              sessionId,
              title: after.session.display_title,
              archived: after.session.archived,
              updatedAt: after.thread?.updated_at ?? after.session.updated_at,
              status,
              activeFlags,
              turnId: lastTurn?.turnId,
              turnStatus: lastTurn?.status,
              pendingTurnStarts: canonical?.unconfirmedTurnSubmissions?.map((submission) => [
                submission.requestId,
                submission.clientUserMessageId,
                submission.stage,
              ]),
              requestIds: snapshot?.requests.map((request) => request.requestId),
            }),
          )
          .digest("base64url");
      return {
        sessionId,
        title: after.session.display_title,
        backend: thread?.backend_binding.kind ?? null,
        agent: null,
        status,
        activeFlags,
        disposition: disposition(status, activeFlags, executionInProgress),
        cursor,
      };
    }),
    list: Effect.fn("SessionObservation.list")(function* (input) {
      const result = yield* core.workspace
        .read(
          {
            kind: "session_window",
            archived: input.archived,
            window: { after: input.cursor, first: input.limit },
          },
          { deadlineMs: 10_000 },
        )
        .pipe(
          Effect.mapError(
            (cause) => new SessionObservationError({ reason: "history_unavailable", cause }),
          ),
        );
      if (result.value.kind !== "session_window")
        return yield* new SessionObservationError({
          reason: "history_unavailable",
          cause: new Error("Unexpected Session listing response"),
        });
      return {
        sessions: result.value.sessions.items.map(listingSummary),
        nextCursor: result.value.sessions.next_cursor ?? null,
        projectionRevision: result.value.sessions.authority.projection_revision,
      };
    }),
    read: Effect.fn("SessionObservation.read")(function* (input, provenance): Effect.fn.Return<
      SessionObservationResult,
      SessionObservationError
    > {
      const before = yield* authorize(input.sessionId, provenance);
      const result = yield* history(before, input);
      const after = yield* authorize(input.sessionId, provenance);
      if (bindingKey(before) !== bindingKey(after))
        return yield* new SessionObservationError({
          reason: "authority_changed",
          cause: new Error("Session ownership or backend changed while reading"),
        });
      return {
        sessionId: after.session.id,
        projectId: after.session.project_id ?? null,
        threadId: after.thread?.thread_id ?? null,
        title: after.session.display_title,
        backend: after.thread?.backend_binding.kind ?? null,
        agent: null,
        archived: after.session.archived,
        pinned: after.session.pinned,
        status: {
          type: after.thread?.status.status_type ?? "idle",
          activeFlags: after.thread?.status.active_flags ?? [],
        },
        history: result,
      };
    }),
  });
});

export const live = Layer.effect(SessionObservation, make);
