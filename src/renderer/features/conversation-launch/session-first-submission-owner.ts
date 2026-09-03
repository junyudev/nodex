import type { CodexConversationTurn, CodexPromptInput, CodexUserAttachment } from "../../lib/types";
import { createUuidV7 } from "../../../shared/uuid-v7";

export type FirstSubmissionBackend = "codex" | "acp";

export type FirstSubmissionPhase =
  | "accepted"
  | "materializingTarget"
  | "startingThread"
  | "adoptingOwner"
  | "startingTurn"
  | "failed";

export interface FirstSubmissionIdentity {
  readonly launchId: string;
  readonly clientUserMessageId: string;
}

export interface FirstSubmissionHandle extends FirstSubmissionIdentity {
  readonly originProjectId: string | null;
  readonly originSessionId: string;
}

export interface FirstSubmissionFailure {
  readonly message: string;
  readonly stage: "materializingTarget" | "startingThread" | "adoptingOwner" | "startingTurn";
}

export interface SessionFirstSubmission extends FirstSubmissionIdentity {
  readonly backend: FirstSubmissionBackend;
  readonly originProjectId: string | null;
  readonly originSessionId: string;
  readonly targetProjectId: string | null;
  readonly targetSessionId: string;
  readonly threadId: string | null;
  readonly clientThreadId: string | null;
  readonly prompt: string;
  readonly promptInput: CodexPromptInput | undefined;
  readonly phase: FirstSubmissionPhase;
  readonly acceptedAt: number;
  readonly updatedAt: number;
  readonly failure: FirstSubmissionFailure | null;
}

export interface SessionFirstSubmissionsSnapshot {
  readonly submissions: readonly SessionFirstSubmission[];
}

export interface FirstSubmissionPresentationTarget {
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly clientThreadId?: string | null;
}

export interface BeginFirstSubmissionInput {
  readonly backend: FirstSubmissionBackend;
  readonly originProjectId: string | null;
  readonly originSessionId: string;
  readonly prompt: string;
  readonly promptInput?: CodexPromptInput;
}

interface SessionFirstSubmissionOwnerDependencies {
  readonly createId?: () => string;
  readonly now?: () => number;
}

type FirstSubmissionPatch = Partial<
  Pick<
    SessionFirstSubmission,
    "targetProjectId" | "targetSessionId" | "threadId" | "clientThreadId" | "phase" | "failure"
  >
>;

const EMPTY_SNAPSHOT: SessionFirstSubmissionsSnapshot = Object.freeze({
  submissions: Object.freeze([]),
});

const PHASE_ORDER: Readonly<Record<Exclude<FirstSubmissionPhase, "failed">, number>> = {
  accepted: 0,
  materializingTarget: 1,
  startingThread: 2,
  adoptingOwner: 3,
  startingTurn: 4,
};

function isStalePhase(
  current: FirstSubmissionPhase,
  next: FirstSubmissionPhase | undefined,
): boolean {
  if (!next || next === current || next === "failed") return false;
  if (current === "failed") return true;
  return PHASE_ORDER[next] < PHASE_ORDER[current];
}

function readCanonicalClientUserMessageId(turn: CodexConversationTurn): string | null {
  for (const item of turn.items) {
    if (item.semanticKind !== "userMessage" && item.kind !== "userMessage") continue;
    if (!item.rawItem || typeof item.rawItem !== "object") continue;
    const clientId = (item.rawItem as { readonly clientId?: unknown }).clientId;
    if (typeof clientId === "string" && clientId.trim()) return clientId;
  }
  return null;
}

export function hasCanonicalFirstSubmission(
  turns: readonly CodexConversationTurn[],
  clientUserMessageId: string,
): boolean {
  return turns.some((turn) => readCanonicalClientUserMessageId(turn) === clientUserMessageId);
}

/** A renderer-optimistic turn has no server id and is not yet a safe handoff boundary. */
export function hasDurableCanonicalFirstSubmission(
  turns: readonly CodexConversationTurn[],
  clientUserMessageId: string,
): boolean {
  return turns.some(
    (turn) =>
      turn.turnId !== null && readCanonicalClientUserMessageId(turn) === clientUserMessageId,
  );
}

function buildUserAttachments(submission: SessionFirstSubmission): CodexUserAttachment[] {
  const itemId = `first-submission:${submission.clientUserMessageId}`;
  const promptInput = submission.promptInput;
  if (!promptInput) return [];

  const files = [
    ...(promptInput.fileAttachments ?? []).map((file) => ({
      label: file.label,
      path: file.path,
      sourceKind: "mention" as const,
    })),
    ...(promptInput.addedFiles ?? []).map((file) => ({
      label: file.label,
      path: file.path,
      sourceKind: "mention" as const,
    })),
    ...(promptInput.textAttachments ?? []).flatMap((attachment) =>
      attachment.file
        ? [
            {
              label: attachment.file.label,
              path: attachment.file.path,
              sourceKind: "mention" as const,
            },
          ]
        : [],
    ),
    ...(promptInput.mentions ?? []).map((mention) => ({
      label: mention.name,
      path: mention.path,
      sourceKind: "mention" as const,
    })),
    ...(promptInput.skills ?? []).map((skill) => ({
      label: skill.name,
      path: skill.path,
      sourceKind: "skill" as const,
    })),
  ].map((file, index): CodexUserAttachment => ({
    type: "file",
    id: `${itemId}:file:${index}`,
    ...file,
  }));
  const images = [
    ...(promptInput.images ?? []).map((image) => ({
      source: image.source,
      caption: image.caption,
    })),
    ...(promptInput.appshots ?? []).map((appshot) => ({
      source: appshot.imageDataUrl,
      caption: appshot.appName,
    })),
  ].map((image, index): CodexUserAttachment => ({
    type: "image",
    id: `${itemId}:image:${index}`,
    source: image.source,
    sourceKind: "inline-image",
    ...(image.caption ? { caption: image.caption } : {}),
  }));
  return [...files, ...images];
}

function buildPresentationTurn(submission: SessionFirstSubmission): CodexConversationTurn {
  const itemId = `first-submission:${submission.clientUserMessageId}`;
  const threadId = submission.threadId ?? `launch:${submission.launchId}`;
  const userAttachments = buildUserAttachments(submission);
  const failed = submission.phase === "failed";
  return {
    threadId,
    turnId: null,
    status: failed ? "failed" : "inProgress",
    ...(failed && submission.failure ? { errorMessage: submission.failure.message } : {}),
    itemIds: [itemId],
    turnStartedAtMs: submission.acceptedAt,
    startedAt: submission.acceptedAt,
    items: [
      {
        threadId,
        turnId: null,
        itemId,
        type: "userMessage",
        kind: "userMessage",
        semanticKind: "userMessage",
        role: "user",
        status: failed ? "failed" : "completed",
        source: "live",
        markdownText: submission.promptInput?.text ?? submission.prompt,
        ...(failed ? { deliveryStatus: "not-sent" as const } : {}),
        ...(userAttachments.length > 0 ? { userAttachments } : {}),
        ...(submission.promptInput?.commentAttachments?.length
          ? { commentAttachments: [...submission.promptInput.commentAttachments] }
          : {}),
        rawItem: {
          id: itemId,
          type: "userMessage",
          clientId: submission.clientUserMessageId,
          content: [],
        },
        createdAt: submission.acceptedAt,
        updatedAt: submission.updatedAt,
      },
    ],
  };
}

function matchesPresentationTarget(
  submission: SessionFirstSubmission,
  target: FirstSubmissionPresentationTarget,
): boolean {
  if (target.threadId && submission.threadId === target.threadId) return true;
  if (target.clientThreadId && submission.clientThreadId === target.clientThreadId) return true;
  if (!target.sessionId) return false;
  return submission.targetSessionId === target.sessionId;
}

export function selectSessionFirstSubmission(
  snapshot: SessionFirstSubmissionsSnapshot,
  target: FirstSubmissionPresentationTarget,
): SessionFirstSubmission | null {
  return (
    [...snapshot.submissions]
      .reverse()
      .find((candidate) => matchesPresentationTarget(candidate, target)) ?? null
  );
}

export function projectSessionFirstSubmissionTurns(
  snapshot: SessionFirstSubmissionsSnapshot,
  target: FirstSubmissionPresentationTarget,
  canonicalTurns: readonly CodexConversationTurn[],
): CodexConversationTurn[] {
  const submission = selectSessionFirstSubmission(snapshot, target);
  if (!submission || hasCanonicalFirstSubmission(canonicalTurns, submission.clientUserMessageId)) {
    return canonicalTurns as CodexConversationTurn[];
  }
  return [...canonicalTurns, buildPresentationTurn(submission)];
}

export interface SessionFirstSubmissionOwner {
  readonly getSnapshot: () => SessionFirstSubmissionsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly begin: (input: BeginFirstSubmissionInput) => FirstSubmissionHandle;
  readonly update: (launchId: string, patch: FirstSubmissionPatch) => void;
  readonly fail: (launchId: string, failure: FirstSubmissionFailure) => void;
  readonly complete: (launchId: string) => void;
  readonly projectTurns: (
    target: FirstSubmissionPresentationTarget,
    canonicalTurns: readonly CodexConversationTurn[],
  ) => CodexConversationTurn[];
  readonly dispose: () => void;
}

export function createSessionFirstSubmissionOwner(
  dependencies: SessionFirstSubmissionOwnerDependencies = {},
): SessionFirstSubmissionOwner {
  const createId = dependencies.createId ?? createUuidV7;
  const now = dependencies.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;

  const publish = (submissions: readonly SessionFirstSubmission[]): void => {
    snapshot = Object.freeze({ submissions: Object.freeze([...submissions]) });
    for (const listener of listeners) listener();
  };

  const update = (launchId: string, patch: FirstSubmissionPatch): void => {
    let changed = false;
    const submissions = snapshot.submissions.map((submission) => {
      if (submission.launchId !== launchId) return submission;
      if (isStalePhase(submission.phase, patch.phase)) return submission;
      const candidate = Object.freeze({
        ...submission,
        ...patch,
        updatedAt: now(),
      });
      changed = Object.entries(patch).some(
        ([key, value]) => submission[key as keyof SessionFirstSubmission] !== value,
      );
      return changed ? candidate : submission;
    });
    if (changed) publish(submissions);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin: (input) => {
      const launchId = createId();
      const clientUserMessageId = createId();
      const acceptedAt = now();
      const retained = snapshot.submissions.filter((submission) => {
        const matchesOrigin =
          submission.originSessionId === input.originSessionId &&
          submission.originProjectId === input.originProjectId;
        const matchesCurrentTarget =
          submission.targetSessionId === input.originSessionId &&
          submission.targetProjectId === input.originProjectId;
        return !matchesOrigin && !matchesCurrentTarget;
      });
      const submission: SessionFirstSubmission = Object.freeze({
        launchId,
        clientUserMessageId,
        backend: input.backend,
        originProjectId: input.originProjectId,
        originSessionId: input.originSessionId,
        targetProjectId: input.originProjectId,
        targetSessionId: input.originSessionId,
        threadId: null,
        clientThreadId: null,
        prompt: input.prompt,
        promptInput: input.promptInput,
        phase: "accepted",
        acceptedAt,
        updatedAt: acceptedAt,
        failure: null,
      });
      publish([...retained, submission]);
      return {
        launchId,
        clientUserMessageId,
        originProjectId: input.originProjectId,
        originSessionId: input.originSessionId,
      };
    },
    update,
    fail: (launchId, failure) => update(launchId, { phase: "failed", failure }),
    complete: (launchId) => {
      const submissions = snapshot.submissions.filter(
        (submission) => submission.launchId !== launchId,
      );
      if (submissions.length === snapshot.submissions.length) return;
      publish(submissions);
    },
    projectTurns: (target, canonicalTurns) =>
      projectSessionFirstSubmissionTurns(snapshot, target, canonicalTurns),
    dispose: () => {
      listeners.clear();
      snapshot = EMPTY_SNAPSHOT;
    },
  };
}

export const sessionFirstSubmissionOwner = createSessionFirstSubmissionOwner();
