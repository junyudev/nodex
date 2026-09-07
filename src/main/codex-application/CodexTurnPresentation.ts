import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type {
  CodexTurnPresentationCaptureInput,
  CodexTurnPresentationTarget,
  CodexTurnPresentationTicket,
} from "../../shared/nodex-app-tools/turn-presentation";
import type { PresentationAnchor } from "../../shared/nodex-app-tools/workbench";
import { createUuidV7 } from "../../shared/uuid-v7";
import { WorkbenchAgentBridge } from "../app-tools/WorkbenchAgentBridge";

export class CodexTurnPresentationError extends Schema.TaggedError<CodexTurnPresentationError>()(
  "CodexTurnPresentationError",
  {
    reason: Schema.Literals([
      "unavailable",
      "stale_renderer",
      "capacity",
      "expired",
      "target_mismatch",
      "submission_mismatch",
      "in_flight",
      "already_accepted",
      "turn_mismatch",
      "closed",
    ]),
    message: Schema.String,
    acceptedTurnId: Schema.NullOr(Schema.String),
  },
) {}

/** Main-only claim. The origin snapshot remains inside its scoped owner. */
export interface CodexTurnPresentationClaim {
  readonly ticketId: string;
  readonly submissionId: string;
}

export interface CodexTurnPresentationLaunch extends CodexTurnPresentationClaim {
  readonly launchId: string;
  readonly threadId: string;
}

type EntryState =
  | { readonly kind: "captured" }
  | { readonly kind: "claimed"; readonly submissionId: string }
  | { readonly kind: "admitted"; readonly launch: CodexTurnPresentationLaunch }
  | {
      readonly kind: "bound";
      readonly launch: CodexTurnPresentationLaunch;
      readonly turnId: string;
    };

interface PresentationEntry {
  readonly target: CodexTurnPresentationTarget;
  readonly anchor: PresentationAnchor;
  readonly expiresAt: number;
  readonly byteLength: number;
  state: EntryState;
  queued: boolean;
}

export class CodexTurnPresentation extends Context.Service<
  CodexTurnPresentation,
  {
    readonly capture: (
      webContentsId: number,
      input: CodexTurnPresentationCaptureInput,
    ) => Effect.Effect<CodexTurnPresentationTicket, CodexTurnPresentationError>;
    readonly claim: (
      ticket: CodexTurnPresentationTicket,
      target: CodexTurnPresentationTarget,
      submissionId: string,
    ) => Effect.Effect<CodexTurnPresentationClaim, CodexTurnPresentationError>;
    readonly begin: (
      claim: CodexTurnPresentationClaim | undefined,
      threadId: string,
    ) => Effect.Effect<CodexTurnPresentationLaunch | null, CodexTurnPresentationError>;
    readonly bind: (
      launch: CodexTurnPresentationLaunch | null,
      turnId: string,
    ) => Effect.Effect<void, CodexTurnPresentationError>;
    /** Protocol client message identity is required; unknown notifications never choose a launch. */
    readonly observeUserMessage: (
      threadId: string,
      turnId: string,
      clientUserMessageId: string | null,
    ) => Effect.Effect<void, CodexTurnPresentationError>;
    readonly abort: (launch: CodexTurnPresentationLaunch | null) => void;
    readonly releaseClaim: (claim: CodexTurnPresentationClaim | undefined) => void;
    /** Resumes a deferred launch only through its original target and logical submission identity. */
    readonly lookupSubmission: (
      target: CodexTurnPresentationTarget,
      submissionId: string,
    ) => CodexTurnPresentationClaim | undefined;
    /** Retained origins are indexed only by exact durable message identity. */
    readonly retainQueued: (claim: CodexTurnPresentationClaim | undefined) => void;
    readonly readQueued: (
      threadId: string,
      clientUserMessageId: string,
    ) => CodexTurnPresentationClaim | undefined;
    readonly reconcileQueued: (
      threadId: string,
      retainedClientMessageIds: readonly string[],
    ) => void;
    readonly read: (threadId: string, turnId: string) => PresentationAnchor | null;
    readonly finish: (threadId: string, turnId: string) => void;
  }
>()("nodex/main/codex-application/CodexTurnPresentation") {}

const sameTarget = (left: CodexTurnPresentationTarget, right: CodexTurnPresentationTarget) =>
  left.kind === "thread"
    ? right.kind === "thread" && left.threadId === right.threadId
    : left.kind === "session"
      ? right.kind === "session" &&
        left.sessionId === right.sessionId &&
        left.launchId === right.launchId
      : right.kind === "side_chat" &&
        left.parentThreadId === right.parentThreadId &&
        left.clientUserMessageId === right.clientUserMessageId;
const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
const failure = (
  reason: CodexTurnPresentationError["reason"],
  message: string,
  acceptedTurnId: string | null = null,
) => new CodexTurnPresentationError({ reason, message, acceptedTurnId });

/** Owns transient submission receipts and exact Turn bindings, never live Scene state. */
export const make: Effect.Effect<
  CodexTurnPresentation["Service"],
  never,
  WorkbenchAgentBridge | Scope.Scope
> = Effect.gen(function* () {
  const bridge = yield* WorkbenchAgentBridge;
  const entries = new Map<string, PresentationEntry>();
  const boundTurns = new Map<string, string>();
  const finishedLaunches = new Map<string, string>();
  const maxEntries = 2_048;
  const maxSnapshotBytes = 768 * 1024;
  const maxRetainedBytes = 32 * 1024 * 1024;
  let retainedBytes = 0;
  const removeEntry = (ticketId: string) => {
    const entry = entries.get(ticketId);
    if (!entry) return;
    retainedBytes -= entry.byteLength;
    entries.delete(ticketId);
  };
  const ticketLifetimeMs = 15 * 60_000;
  let open = true;

  const capture = Effect.fn("CodexTurnPresentation.capture")(function* (
    webContentsId: number,
    input: CodexTurnPresentationCaptureInput,
  ) {
    if (!open) return yield* failure("closed", "Turn presentation is unavailable after shutdown");
    const reference = bridge.referenceForSender(webContentsId);
    if (!reference)
      return yield* failure("unavailable", "The submitting Workbench is not registered");
    if (reference.rendererGeneration !== input.presentation.rendererGeneration) {
      return yield* failure(
        "stale_renderer",
        "The submitting Workbench has been replaced; submit again",
      );
    }
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    for (const [ticketId, entry] of entries) {
      if (entry.state.kind === "captured" && entry.expiresAt <= nowMs) removeEntry(ticketId);
    }
    if (entries.size >= maxEntries)
      return yield* failure("capacity", "Too many pending Turn presentations");
    const anchor = { ...input.presentation, ...reference, capturedAt: DateTime.formatIso(now) };
    const byteLength = Buffer.byteLength(JSON.stringify(anchor), "utf8");
    if (byteLength > maxSnapshotBytes)
      return yield* failure("capacity", "Submission presentation exceeds the 768 KiB size limit");
    if (retainedBytes + byteLength > maxRetainedBytes)
      return yield* failure(
        "capacity",
        "Pending submission presentations exceed the 32 MiB retention limit",
      );
    const ticketId = createUuidV7();
    entries.set(ticketId, {
      target: structuredClone(input.target),
      anchor: structuredClone(anchor),
      expiresAt: nowMs + ticketLifetimeMs,
      byteLength,
      state: { kind: "captured" },
      queued: false,
    });
    retainedBytes += byteLength;
    return { ticketId };
  });

  const claim = Effect.fn("CodexTurnPresentation.claim")(function* (
    ticket: CodexTurnPresentationTicket,
    target: CodexTurnPresentationTarget,
    submissionId: string,
  ) {
    if (!open) return yield* failure("closed", "Turn presentation is unavailable after shutdown");
    const entry = entries.get(ticket.ticketId);
    if (!entry)
      return yield* failure("expired", "This submission presentation is unavailable; submit again");
    if (!sameTarget(entry.target, target))
      return yield* failure(
        "target_mismatch",
        "Submission presentation targets a different Conversation or Session",
      );
    if (!submissionId.trim())
      return yield* failure(
        "submission_mismatch",
        "Submission requires an exact client message identity",
      );
    if (entry.state.kind === "bound")
      return yield* failure(
        "already_accepted",
        "This submission already started a Turn",
        entry.state.turnId,
      );
    if (entry.state.kind === "admitted")
      return yield* failure("in_flight", "This submission is already awaiting its accepted Turn");
    if (entry.state.kind === "claimed" && entry.state.submissionId !== submissionId) {
      return yield* failure(
        "submission_mismatch",
        "Submission presentation belongs to another client message",
      );
    }
    const now = yield* DateTime.now;
    if (entry.state.kind === "captured" && entry.expiresAt <= DateTime.toEpochMillis(now)) {
      removeEntry(ticket.ticketId);
      return yield* failure("expired", "This submission presentation expired; submit again");
    }
    entry.state = { kind: "claimed", submissionId };
    return { ticketId: ticket.ticketId, submissionId };
  });

  const begin = Effect.fn("CodexTurnPresentation.begin")(function* (
    claim: CodexTurnPresentationClaim | undefined,
    threadId: string,
  ) {
    if (!claim) return null;
    const entry = entries.get(claim.ticketId);
    if (!open || !entry)
      return yield* failure("unavailable", "Submission presentation is unavailable");
    if (entry.target.kind === "thread" && entry.target.threadId !== threadId)
      return yield* failure(
        "target_mismatch",
        "Submission presentation targets a different Conversation",
      );
    if (entry.state.kind === "bound")
      return yield* failure(
        "already_accepted",
        "This submission already started a Turn",
        entry.state.turnId,
      );
    if (entry.state.kind === "admitted")
      return yield* failure("in_flight", "This submission is already awaiting its accepted Turn");
    if (entry.state.kind !== "claimed" || entry.state.submissionId !== claim.submissionId)
      return yield* failure("submission_mismatch", "Submission presentation has no matching claim");
    const launch = { ...claim, threadId, launchId: createUuidV7() };
    entry.state = { kind: "admitted", launch };
    return launch;
  });

  const bind = Effect.fn("CodexTurnPresentation.bind")(function* (
    launch: CodexTurnPresentationLaunch | null,
    turnId: string,
  ) {
    if (!launch) return;
    const entry = entries.get(launch.ticketId);
    if (!entry && finishedLaunches.get(launch.launchId) === turnId) return;
    if (!open || !entry)
      return yield* failure("unavailable", "Submission presentation is unavailable");
    const state = entry.state;
    if (state.kind !== "admitted" && state.kind !== "bound")
      return yield* failure(
        "submission_mismatch",
        "Submission presentation has no admitted launch",
      );
    if (state.launch.launchId !== launch.launchId)
      return yield* failure(
        "submission_mismatch",
        "Submission presentation belongs to another launch",
      );
    if (!turnId.trim() || (state.kind === "bound" && state.turnId !== turnId))
      return yield* failure(
        "turn_mismatch",
        "Submission presentation cannot be rebound to a different Turn",
      );
    const key = turnKey(launch.threadId, turnId);
    const boundTicket = boundTurns.get(key);
    if (boundTicket && boundTicket !== launch.ticketId)
      return yield* failure(
        "turn_mismatch",
        "Accepted Turn already has another submission presentation",
      );
    entry.state = { kind: "bound", launch, turnId };
    boundTurns.set(key, launch.ticketId);
  });

  const observeUserMessage = Effect.fn("CodexTurnPresentation.observeUserMessage")(function* (
    threadId: string,
    turnId: string,
    clientUserMessageId: string | null,
  ) {
    if (!clientUserMessageId || boundTurns.has(turnKey(threadId, turnId))) return;
    const candidates = [...entries.values()].flatMap((entry) =>
      entry.state.kind === "admitted" &&
      entry.state.launch.threadId === threadId &&
      entry.state.launch.submissionId === clientUserMessageId
        ? [entry.state.launch]
        : [],
    );
    if (candidates.length !== 1) return;
    yield* bind(candidates[0]!, turnId);
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
      entries.clear();
      retainedBytes = 0;
      boundTurns.clear();
      finishedLaunches.clear();
    }),
  );

  const matchingClaim = (
    target: CodexTurnPresentationTarget,
    submissionId: string,
    queuedOnly: boolean,
  ) => {
    const matches = [...entries.entries()].flatMap(([ticketId, entry]) => {
      if (
        (queuedOnly && !entry.queued) ||
        !sameTarget(entry.target, target) ||
        entry.state.kind === "captured"
      )
        return [];
      const existingId =
        entry.state.kind === "claimed" ? entry.state.submissionId : entry.state.launch.submissionId;
      return existingId === submissionId ? [{ ticketId, submissionId }] : [];
    });
    return matches.length === 1 ? matches[0] : undefined;
  };

  return CodexTurnPresentation.of({
    capture,
    claim,
    begin,
    bind,
    observeUserMessage,
    abort: (launch) => {
      if (!launch) return;
      const entry = entries.get(launch.ticketId);
      if (entry?.state.kind === "admitted" && entry.state.launch.launchId === launch.launchId) {
        entry.state = { kind: "claimed", submissionId: launch.submissionId };
      }
    },
    releaseClaim: (claim) => {
      if (!claim) return;
      const entry = entries.get(claim.ticketId);
      if (entry?.state.kind === "claimed" && entry.state.submissionId === claim.submissionId)
        removeEntry(claim.ticketId);
    },
    lookupSubmission: (target, submissionId) => matchingClaim(target, submissionId, false),
    retainQueued: (claim) => {
      if (!claim) return;
      const entry = entries.get(claim.ticketId);
      if (entry?.state.kind === "claimed" && entry.state.submissionId === claim.submissionId)
        entry.queued = true;
    },
    readQueued: (threadId, clientUserMessageId) =>
      matchingClaim({ kind: "thread", threadId }, clientUserMessageId, true),
    reconcileQueued: (threadId, retainedClientMessageIds) => {
      const retained = new Set(retainedClientMessageIds);
      for (const [ticketId, entry] of entries) {
        if (
          entry.queued &&
          entry.target.kind === "thread" &&
          entry.target.threadId === threadId &&
          entry.state.kind === "claimed" &&
          !retained.has(entry.state.submissionId)
        )
          removeEntry(ticketId);
      }
    },
    read: (threadId, turnId) => {
      const ticketId = boundTurns.get(turnKey(threadId, turnId));
      const entry = ticketId ? entries.get(ticketId) : undefined;
      return entry?.state.kind === "bound" ? structuredClone(entry.anchor) : null;
    },
    finish: (threadId, turnId) => {
      const key = turnKey(threadId, turnId);
      const ticketId = boundTurns.get(key);
      if (!ticketId) return;
      const entry = entries.get(ticketId);
      if (entry?.state.kind === "bound") {
        finishedLaunches.set(entry.state.launch.launchId, turnId);
        if (finishedLaunches.size > 256) {
          const oldest = finishedLaunches.keys().next().value;
          if (oldest) finishedLaunches.delete(oldest);
        }
      }
      boundTurns.delete(key);
      removeEntry(ticketId);
    },
  });
});
