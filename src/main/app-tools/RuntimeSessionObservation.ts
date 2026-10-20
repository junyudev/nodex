import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import { encodeThreadHistoryCursor } from "@nodex/agent-runtime/orchestration/threadHistoryPaging";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import {
  SessionObservation,
  SessionObservationError,
  type SessionObservationResult,
} from "./SessionObservation";

type Provenance = components["schemas"]["AgentTurnProvenance"];
const observationError = (cause: unknown) =>
  new SessionObservationError({ reason: "history_unavailable", cause });
const backendOf = (instanceId: string): SessionObservationResult["backend"] =>
  instanceId === "codex"
    ? "codex"
    : instanceId.startsWith("claude_")
      ? "claude"
      : instanceId.startsWith("opencode_")
        ? "opencode"
        : "acp";
const compactItem = (item: AgentTurnItem, maximum: number, outputs: boolean) => {
  const bounded = (text: string) =>
    text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
  const value = item as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = { id: item.id, type: item.type };
  for (const name of ["status", "role", "text", "title", "command", "summary"])
    if (typeof value[name] === "string") fields[name] = bounded(value[name]);
  if (outputs)
    for (const name of ["output", "result", "error"])
      if (typeof value[name] === "string") fields[name] = bounded(value[name]);
  return fields;
};

/** Session observations read engine metadata first; only explicit history reads admit transcript windows. */
export const make = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  const core = yield* CoreModules;
  const authorize = (sessionId: string, provenance: Provenance) =>
    core.workspace
      .read(
        { kind: "agent_session", session_id: sessionId, provenance },
        { deadlineMs: 10000 },
        provenance.authority.actor_project_id,
      )
      .pipe(
        Effect.mapError((cause) => new SessionObservationError({ reason: "authorization", cause })),
        Effect.flatMap((response) =>
          response.value.kind === "agent_session"
            ? Effect.succeed(response.value)
            : Effect.fail(
                new SessionObservationError({
                  reason: "authorization",
                  cause: new Error("Unexpected Session authorization"),
                }),
              ),
        ),
      );
  const inspect = (sessionId: string, provenance: Provenance) =>
    Effect.gen(function* () {
      const session = yield* authorize(sessionId, provenance);
      const loaded = session.session.execution_ref
        ? yield* application
            .inspect({ sessionId })
            .pipe(
              Effect.provideService(CoreApplicationAgent, provenance),
              Effect.mapError(observationError),
            )
        : null;
      const after = yield* authorize(sessionId, provenance);
      if (
        JSON.stringify(session.session.execution_ref) !==
        JSON.stringify(after.session.execution_ref)
      )
        return yield* new SessionObservationError({
          reason: "authority_changed",
          cause: new Error("Session execution changed"),
        });
      const status = loaded?.thread.status ?? after.thread?.status.status_type ?? "idle";
      const activeFlags = loaded?.thread.pendingRuntimeRequest
        ? [loaded.thread.pendingRuntimeRequest.kind]
        : [...(after.thread?.status.active_flags ?? [])];
      const disposition =
        activeFlags.length > 0 || status === "failed" || status === "systemError"
          ? ("needs_attention" as const)
          : loaded?.thread.activeRunId ||
              status === "running" ||
              status === "active" ||
              status === "preparing" ||
              status === "starting" ||
              status === "waiting"
            ? ("running" as const)
            : ("complete" as const);
      return {
        sessionId,
        title: after.session.display_title,
        backend: loaded
          ? backendOf(loaded.thread.providerInstanceId)
          : (after.thread?.backend_binding.kind ?? null),
        agent: loaded
          ? {
              providerInstanceId: loaded.thread.modelSelection.instanceId,
              model: loaded.thread.modelSelection.model,
            }
          : null,
        status,
        activeFlags,
        disposition,
        cursor:
          "nxs2." +
          createHash("sha256")
            .update(
              JSON.stringify({
                sessionId,
                binding: after.session.execution_ref,
                title: after.session.display_title,
                archived: after.session.archived,
                status,
                activeFlags,
                updatedAt: loaded?.thread.updatedAt ?? after.session.updated_at,
                runId: loaded?.thread.latestRunId,
                pending: loaded?.thread.pendingRuntimeRequest,
              }),
            )
            .digest("base64url"),
      };
    });
  return SessionObservation.of({
    inspect,
    list: (input) =>
      Effect.gen(function* () {
        const provenance = yield* CoreApplicationAgent;
        const response = yield* core.workspace
          .read(
            {
              kind: "session_window",
              archived: input.archived,
              window: { after: input.cursor, first: input.limit },
            },
            { deadlineMs: 10000 },
            provenance?.authority.actor_project_id,
          )
          .pipe(Effect.mapError(observationError));
        if (response.value.kind !== "session_window")
          return yield* observationError(new Error("Unexpected Session window"));
        const items = response.value.sessions.items;
        const sessions = yield* Effect.forEach(
          items,
          ({ task, ...placement }) =>
            Effect.gen(function* () {
              const loaded = task.session.execution_ref
                ? yield* application
                    .inspect({ sessionId: task.session.id })
                    .pipe(Effect.mapError(observationError))
                : null;
              return {
                sessionId: task.session.id,
                projectId: task.session.project_id ?? null,
                projectName: placement.project_name ?? null,
                threadId: loaded?.threadId ?? task.thread?.thread_id ?? null,
                title: task.session.display_title,
                preview:
                  loaded?.thread.latestVisibleMessage?.text?.slice(0, 512) ??
                  task.thread?.thread_preview ??
                  "",
                backend: loaded
                  ? backendOf(loaded.thread.providerInstanceId)
                  : (task.thread?.backend_binding.kind ?? null),
                status: loaded
                  ? {
                      status_type:
                        loaded.thread.status === "failed"
                          ? ("systemError" as const)
                          : loaded.thread.activeRunId
                            ? ("active" as const)
                            : ("idle" as const),
                      active_flags: loaded.thread.pendingRuntimeRequest
                        ? [
                            loaded.thread.pendingRuntimeRequest.kind === "user_input"
                              ? ("waitingOnUserInput" as const)
                              : ("waitingOnApproval" as const),
                          ]
                        : [],
                    }
                  : (task.thread?.status ?? { status_type: "idle", active_flags: [] }),
                archived: task.session.archived,
                pinned: task.session.pinned,
                recencyAt: loaded
                  ? Date.parse(loaded.thread.updatedAt)
                  : (task.thread?.recency_at ?? null),
                placement: task.session.pinned
                  ? { kind: "pinned", source: "session" }
                  : placement.direct_section_id
                    ? { kind: "section", source: "session", sectionId: placement.direct_section_id }
                    : placement.project_section_id
                      ? {
                          kind: "section",
                          source: "project",
                          sectionId: placement.project_section_id,
                        }
                      : placement.project_pinned
                        ? { kind: "pinned", source: "project" }
                        : {
                            kind: "default",
                            source: task.session.project_id ? "project" : "session",
                          },
              };
            }),
          { concurrency: 2 },
        );
        return {
          sessions,
          nextCursor: response.value.sessions.next_cursor ?? null,
          projectionRevision: response.value.sessions.authority.projection_revision,
        };
      }),
    read: (input, provenance) =>
      Effect.gen(function* () {
        const before = yield* authorize(input.sessionId, provenance);
        const control = yield* inspect(input.sessionId, provenance);
        let history: SessionObservationResult["history"] = { availability: "empty", turns: [] };
        if (before.session.execution_ref) {
          const page = input.cursor
            ? yield* application
                .history({ sessionId: input.sessionId, cursor: input.cursor })
                .pipe(
                  Effect.provideService(CoreApplicationAgent, provenance),
                  Effect.mapError(observationError),
                )
            : null;
          const open = page
            ? null
            : yield* application
                .read({ sessionId: input.sessionId })
                .pipe(
                  Effect.provideService(CoreApplicationAgent, provenance),
                  Effect.mapError(observationError),
                );
          const entries = page?.items ?? open?.snapshot.projection.visibleTurnItems ?? [];
          const groups = new Map<string, Record<string, unknown>[]>();
          for (const entry of entries) {
            const key = entry.item.runId ?? entry.sourceItemId;
            const existing = groups.get(key) ?? [];
            existing.push(
              compactItem(entry.item, input.maxOutputCharsPerItem, input.includeOutputs),
            );
            groups.set(key, existing);
          }
          const selected = [...groups.entries()].slice(-input.turnLimit).reverse();
          const hasMore =
            groups.size > selected.length ||
            (page?.hasMoreHistory ?? open?.snapshot.hasMoreHistory ?? false);
          const firstSelected = selected.at(-1)?.[0];
          const anchor = entries.find(
            (entry) => (entry.item.runId ?? entry.sourceItemId) === firstSelected,
          );
          const nextCursor =
            hasMore && anchor
              ? encodeThreadHistoryCursor({
                  snapshotSequence: page?.snapshotSequence ?? open!.snapshot.snapshotSequence,
                  sourceThreadId: anchor.sourceThreadId,
                  sourceItemId: anchor.sourceItemId,
                  position: anchor.position,
                  ordinal: anchor.item.ordinal,
                })
              : null;
          history = {
            availability: "available",
            coverage: "backend",
            page: { order: "newest_first", limit: input.turnLimit, hasMore, nextCursor },
            turns: selected.map(([turnId, items]) => ({ turnId, items })),
          };
        } else if (before.thread)
          history = { availability: "unavailable", reason: "backend_not_loaded" };
        const after = yield* authorize(input.sessionId, provenance);
        if (
          JSON.stringify(before.session.execution_ref) !==
          JSON.stringify(after.session.execution_ref)
        )
          return yield* new SessionObservationError({
            reason: "authority_changed",
            cause: new Error("Session execution changed"),
          });
        return {
          sessionId: input.sessionId,
          projectId: after.session.project_id ?? null,
          threadId: after.session.execution_ref?.thread_id ?? after.thread?.thread_id ?? null,
          title: after.session.display_title,
          backend: control.backend,
          agent: control.agent,
          archived: after.session.archived,
          pinned: after.session.pinned,
          status: { type: control.status, activeFlags: control.activeFlags },
          history,
        };
      }),
  });
});
