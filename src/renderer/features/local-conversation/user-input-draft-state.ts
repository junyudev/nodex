import { useSyncExternalStore } from "react";
import { buildCodexCanonicalRequestIdentityKey } from "../../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexProtocolRequestId } from "@/lib/types";
import { questionDraftStore } from "./question-draft-store";
import {
  buildRequestQuestionSignature,
  type RequestComposerRequest,
  type RequestQuestionnaireDraft,
} from "./view/shared/request-cards/request-card-questionnaire-state";

interface DraftEntry {
  readonly hostId: string;
  readonly conversationId: string;
  readonly requestIdentity: string;
  readonly signature: string;
  readonly draft: RequestQuestionnaireDraft;
  readonly secretIndexes: readonly number[];
}
const entries = new Map<string, DraftEntry>();
const listeners = new Map<string, Set<() => void>>();
const draftKey = (conversationId: string, requestId: CodexProtocolRequestId, namespace: string) =>
  JSON.stringify([
    namespace,
    "questionnaire",
    conversationId,
    buildCodexCanonicalRequestIdentityKey(requestId),
  ]);
const notify = (key: string) => {
  for (const listener of listeners.get(key) ?? []) listener();
};
const isDraft = (value: unknown): value is RequestQuestionnaireDraft => {
  if (!value || typeof value !== "object" || !("answers" in value) || !Array.isArray(value.answers))
    return false;
  if (!("questionIndex" in value) || !Number.isInteger(value.questionIndex)) return false;
  return value.answers.every((answer: unknown) => {
    if (
      !answer ||
      typeof answer !== "object" ||
      !("selectedOptionId" in answer) ||
      !("freeformText" in answer)
    )
      return false;
    if (answer.selectedOptionId !== null && typeof answer.selectedOptionId !== "string")
      return false;
    if (answer.freeformText !== null && typeof answer.freeformText !== "string") return false;
    return (
      !("selectedOptionIds" in answer) ||
      (Array.isArray(answer.selectedOptionIds) &&
        answer.selectedOptionIds.every((id: unknown) => typeof id === "string"))
    );
  });
};

export function clearCodexUserInputDraft(
  conversationId: string,
  requestId: CodexProtocolRequestId,
  hostId = "local",
  namespace?: string,
): void {
  const identity = buildCodexCanonicalRequestIdentityKey(requestId);
  const keys = namespace
    ? [draftKey(conversationId, requestId, namespace)]
    : [...entries]
        .filter(
          ([, entry]) =>
            entry.hostId === hostId &&
            entry.conversationId === conversationId &&
            entry.requestIdentity === identity,
        )
        .map(([key]) => key);
  for (const key of keys) {
    entries.delete(key);
    questionDraftStore.remove(key);
    notify(key);
  }
}

/** Losing a live provider clears private text without discarding the other authored answers. */
export function clearCodexUserInputSecretDraft(
  conversationId: string,
  requestId: CodexProtocolRequestId,
  hostId = "local",
): void {
  const identity = buildCodexCanonicalRequestIdentityKey(requestId);
  for (const [key, entry] of entries) {
    if (
      entry.hostId !== hostId ||
      entry.conversationId !== conversationId ||
      entry.requestIdentity !== identity ||
      !entry.secretIndexes.length
    )
      continue;
    entries.set(key, {
      ...entry,
      draft: {
        ...entry.draft,
        answers: entry.draft.answers.map((answer, index) =>
          entry.secretIndexes.includes(index)
            ? { selectedOptionId: null, freeformText: null }
            : answer,
        ),
      },
    });
    notify(key);
  }
}

/** Each request retains its own draft; secret answers are memory-only. */
export function useCodexUserInputDraft(
  conversationId: string,
  request: RequestComposerRequest,
  scope: { readonly hostId: string; readonly namespace: string } = {
    hostId: "local",
    namespace: "local",
  },
): {
  initialDraft: RequestQuestionnaireDraft | undefined;
  saveDraft: (draft: RequestQuestionnaireDraft) => void;
  clearDraft: () => void;
} {
  const key = draftKey(conversationId, request.requestId, scope.namespace);
  const identity = {
    hostId: scope.hostId,
    conversationId,
    requestIdentity: buildCodexCanonicalRequestIdentityKey(request.requestId),
  };
  const signature = buildRequestQuestionSignature(request);
  const secretIndexes = request.questions.flatMap((question, index) =>
    question.isSecret ? [index] : [],
  );
  const read = () => {
    const entry = entries.get(key);
    if (entry?.signature === signature) return entry.draft;
    const stored = questionDraftStore.read(key, signature);
    if (
      !isDraft(stored) ||
      stored.answers.length !== request.questions.length ||
      stored.questionIndex < 0 ||
      stored.questionIndex >= request.questions.length
    )
      return undefined;
    entries.set(key, { ...identity, signature, draft: stored, secretIndexes });
    return stored;
  };
  const initialDraft = useSyncExternalStore(
    (listener) => {
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      subscribers.add(listener);
      listeners.set(key, subscribers);
      const stop = questionDraftStore.watch(key, () => {
        const stored = questionDraftStore.read(key, signature);
        if (
          isDraft(stored) &&
          stored.answers.length === request.questions.length &&
          stored.questionIndex >= 0 &&
          stored.questionIndex < request.questions.length
        ) {
          const memory = entries.get(key)?.draft;
          const answers = stored.answers.map((answer, index) =>
            request.questions[index]?.isSecret ? (memory?.answers[index] ?? answer) : answer,
          );
          entries.set(key, {
            ...identity,
            signature,
            draft: { ...stored, answers },
            secretIndexes,
          });
        } else entries.delete(key);
        notify(key);
      });
      return () => {
        stop();
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(key);
      };
    },
    read,
    () => undefined,
  );
  return {
    initialDraft,
    saveDraft(draft) {
      entries.set(key, { ...identity, signature, draft, secretIndexes });
      questionDraftStore.write(key, signature, {
        ...draft,
        answers: draft.answers.map((answer, index) =>
          request.questions[index]?.isSecret
            ? { selectedOptionId: null, freeformText: null }
            : answer,
        ),
      });
      notify(key);
    },
    clearDraft: () =>
      clearCodexUserInputDraft(conversationId, request.requestId, scope.hostId, scope.namespace),
  };
}

export function resetCodexUserInputDraftStateForTests(): void {
  for (const key of entries.keys()) questionDraftStore.remove(key);
  entries.clear();
  listeners.clear();
}
