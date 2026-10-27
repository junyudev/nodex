import type { QuestionDraftStore } from "./question-draft-store";
import { mergeCodexCanonicalTurnStates } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { residentConversationTurns } from "../../../shared/codex-conversation-state/codex-turn-mutation";
import {
  expandCodexAsyncQuestions,
  collectCodexAsyncQuestionAnswers,
  type CodexAsyncQuestion,
  type CodexAsyncQuestionReply,
} from "../../../shared/codex-async-user-input";
import type { CodexConversationSnapshot } from "../../../shared/types";

/** The questions one execution owner still accepts answers for, and their accepted answers. */
export interface AsyncQuestionScope {
  readonly generation: number | undefined;
  /** The Turn answers are delivered to; null when no question is answerable. */
  readonly turnId: string | null;
  /** Drafts survive while this identity stays the same. */
  readonly entityKey: string | null;
  readonly questions: readonly CodexAsyncQuestion[];
  readonly answers: ReadonlyMap<string, string>;
}

/** Delivers one batch of answers; null means the Turn ended before they could be delivered. */
export type AsyncQuestionDelivery = (
  turnId: string,
  replies: readonly CodexAsyncQuestionReply[],
  context: { readonly submissionId: string; readonly sourceTurnIds: readonly string[] },
) => Promise<{ turnId: string } | null>;

export interface AsyncQuestionDraft extends CodexAsyncQuestion {
  turnId: string;
  draft: string;
  draftKind: "option" | "freeform";
  freeformDraft: string;
  baseline: string;
  answered: boolean;
  canonicalBaseline: string;
  skipped: boolean;
  deadlineMs: number | null;
}
export interface AsyncQuestionSnapshot {
  questions: Readonly<Record<string, AsyncQuestionDraft>>;
  openIds: readonly string[];
  selectedId: string | null;
  openedAutomatically: boolean;
  submitting: boolean;
  activeTurnId: string | null;
}
interface QuestionSubmissionIdentity {
  readonly key: string;
  readonly id: string;
}
const EMPTY: AsyncQuestionSnapshot = {
  questions: {},
  openIds: [],
  selectedId: null,
  openedAutomatically: false,
  submitting: false,
  activeTurnId: null,
};

/** Accepted history owns answers; optional persistence retains only authored, non-secret drafts. */
export function createAsyncQuestionRuntime(
  options: { readonly drafts?: QuestionDraftStore; readonly namespace?: string } = {},
) {
  const states = new Map<string, AsyncQuestionSnapshot>();
  const generations = new Map<string, number | undefined>();
  const listeners = new Set<() => void>();
  const epochs = new Map<string, object>();
  const activeEntityKeys = new Map<string, string | null>();
  const receivedItems = new Map<string, Set<string>>();
  const draftWatches = new Map<string, () => void>();
  const restoring = new Set<string>();
  const submissions = new Map<string, Map<string, QuestionSubmissionIdentity>>();
  const draftKey = (threadId: string, id: string) =>
    JSON.stringify([options.namespace ?? "local", "async", threadId, id]);
  const panelKey = (threadId: string) =>
    JSON.stringify([options.namespace ?? "local", "async-panel", threadId]);
  const signature = (question: CodexAsyncQuestion) =>
    JSON.stringify([
      question.sourceEntityKey,
      question.title,
      question.options,
      question.isSecret ? undefined : question.initialAnswer,
      question.required,
    ]);
  const persistPanel = (threadId: string, state: AsyncQuestionSnapshot) => {
    options.drafts?.write(panelKey(threadId), "panel", {
      openIds: state.openIds,
      selectedId: state.selectedId,
    });
  };
  const persistDraft = (threadId: string, question: AsyncQuestionDraft) => {
    if (question.isSecret) return;
    options.drafts?.write(draftKey(threadId, question.id), signature(question), {
      draft: question.draft,
      draftKind: question.draftKind,
      freeformDraft: question.freeformDraft,
      skipped: question.skipped,
    });
  };
  const read = (threadId: string) => states.get(threadId) ?? EMPTY;
  const publish = (threadId: string, state: AsyncQuestionSnapshot) => {
    states.set(threadId, state);
    for (const listener of listeners) listener();
  };
  const updateQuestion = (threadId: string, id: string, patch: Partial<AsyncQuestionDraft>) => {
    const state = read(threadId);
    const question = state.questions[id];
    if (!question) return;
    publish(threadId, {
      ...state,
      questions: { ...state.questions, [id]: { ...question, ...patch } },
    });
  };
  const close = (threadId: string) => {
    const next = { ...read(threadId), openIds: [], selectedId: null };
    publish(threadId, next);
    persistPanel(threadId, next);
  };
  const restoreDrafts = (threadId: string) => {
    if (!options.drafts || restoring.has(threadId)) return;
    restoring.add(threadId);
    const state = read(threadId);
    const questions = { ...state.questions };
    for (const question of Object.values(questions)) {
      if (question.isSecret) continue;
      const stored = options.drafts.read(draftKey(threadId, question.id), signature(question));
      if (
        !stored ||
        typeof stored !== "object" ||
        !("draft" in stored) ||
        typeof stored.draft !== "string"
      )
        continue;
      if (!("freeformDraft" in stored) || typeof stored.freeformDraft !== "string") continue;
      if (
        !("draftKind" in stored) ||
        (stored.draftKind !== "option" && stored.draftKind !== "freeform")
      )
        continue;
      questions[question.id] = {
        ...question,
        draft: stored.draft,
        freeformDraft: stored.freeformDraft,
        draftKind: stored.draftKind,
        skipped: "skipped" in stored && stored.skipped === true,
      };
    }
    const storedPanel = options.drafts.read(panelKey(threadId), "panel");
    const selected =
      storedPanel &&
      typeof storedPanel === "object" &&
      "selectedId" in storedPanel &&
      typeof storedPanel.selectedId === "string" &&
      questions[storedPanel.selectedId]
        ? storedPanel.selectedId
        : null;
    const openIds =
      selected &&
      storedPanel &&
      typeof storedPanel === "object" &&
      "openIds" in storedPanel &&
      Array.isArray(storedPanel.openIds)
        ? storedPanel.openIds.filter(
            (id): id is string => typeof id === "string" && Boolean(questions[id]),
          )
        : [];
    const hasStoredPanel =
      storedPanel !== null && typeof storedPanel === "object" && "selectedId" in storedPanel;
    const next = {
      ...state,
      questions,
      selectedId: hasStoredPanel ? selected : state.selectedId,
      openIds: hasStoredPanel ? openIds : state.openIds,
    };
    if (JSON.stringify(state) !== JSON.stringify(next)) publish(threadId, next);
    restoring.delete(threadId);
  };
  const watchDrafts = (threadId: string, restore: boolean) => {
    if (!options.drafts || Object.keys(read(threadId).questions).length === 0) return;
    const keys = [
      panelKey(threadId),
      ...Object.values(read(threadId).questions)
        .filter((question) => !question.isSecret)
        .map((question) => draftKey(threadId, question.id)),
    ];
    let added = false;
    for (const key of keys) {
      if (draftWatches.has(key)) continue;
      draftWatches.set(
        key,
        options.drafts.watch(key, () => restoreDrafts(threadId)),
      );
      added = true;
    }
    if (restore || added) restoreDrafts(threadId);
  };
  const answerText = (question: AsyncQuestionDraft) =>
    question.initialAnswer !== undefined ? question.draft : question.draft.trim();
  const acknowledge = (
    threadId: string,
    replies: readonly CodexAsyncQuestionReply[],
    dismissed = replies,
  ) => {
    const current = read(threadId);
    const questions = { ...current.questions };
    const accepted = new Map(dismissed.map((reply) => [reply.questionItemId, reply.answer]));
    for (const reply of replies) {
      const question = questions[reply.questionItemId];
      if (!question) continue;
      questions[reply.questionItemId] = { ...question, baseline: reply.answer, answered: true };
    }
    for (const reply of dismissed) {
      const question = questions[reply.questionItemId];
      if (question && answerText(question) === reply.answer)
        options.drafts?.remove(draftKey(threadId, question.id));
    }
    const openIds = current.openIds.filter(
      (id) =>
        !accepted.has(id) || (questions[id] && answerText(questions[id]!)) !== accepted.get(id),
    );
    const selectedId = openIds.includes(current.selectedId ?? "")
      ? current.selectedId
      : (openIds[0] ?? null);
    if (selectedId) questions[selectedId] = { ...questions[selectedId]!, deadlineMs: null };
    publish(threadId, { ...current, questions, openIds, selectedId });
    persistPanel(threadId, read(threadId));
  };
  const submissionTokenKey = (threadId: string, replies: readonly CodexAsyncQuestionReply[]) =>
    JSON.stringify([
      options.namespace ?? "local",
      "async-submission",
      threadId,
      replies.map((reply) => reply.questionItemId).sort(),
    ]);
  const canPersistSubmission = (
    state: AsyncQuestionSnapshot,
    replies: readonly CodexAsyncQuestionReply[],
  ) =>
    replies.every((reply) => {
      const question = state.questions[reply.questionItemId];
      return question !== undefined && !question.isSecret;
    });
  const getSubmission = (
    threadId: string,
    replies: readonly CodexAsyncQuestionReply[],
    state = read(threadId),
  ) => {
    const sourceTurnIds = [
      ...new Set(
        replies.flatMap((reply) => state.questions[reply.questionItemId]?.sourceTurnId ?? []),
      ),
    ];
    const key = JSON.stringify([sourceTurnIds, replies]);
    const tokenKey = submissionTokenKey(threadId, replies);
    const stored = options.drafts?.read(tokenKey, "submission");
    const recovered =
      stored &&
      typeof stored === "object" &&
      "key" in stored &&
      stored.key === key &&
      "id" in stored &&
      typeof stored.id === "string"
        ? { key, id: stored.id }
        : undefined;
    const identities = submissions.get(threadId) ?? new Map<string, QuestionSubmissionIdentity>();
    const previous = identities.get(tokenKey) ?? recovered;
    const submission = previous?.key === key ? previous : { key, id: crypto.randomUUID() };
    identities.set(tokenKey, submission);
    submissions.set(threadId, identities);
    if (canPersistSubmission(state, replies))
      options.drafts?.write(tokenKey, "submission", submission);
    return submission;
  };
  // Each original request retains its identity when another request in the panel is acknowledged.
  const prepareSubmission = async (
    threadId: string,
    replies: readonly CodexAsyncQuestionReply[],
  ) => {
    const state = read(threadId);
    if (options.drafts) await options.drafts.flush([]);
    const submission = getSubmission(threadId, replies, state);
    if (options.drafts && canPersistSubmission(state, replies))
      await options.drafts.flush([submissionTokenKey(threadId, replies)]);
    return submission.id;
  };
  const reconcileScope = (threadId: string, scope: AsyncQuestionScope) => {
    const { generation, entityKey, answers } = scope;
    const activeTurnId = scope.turnId;
    const initialized = states.has(threadId) && generations.get(threadId) === generation;
    const sameTurn = initialized && activeEntityKeys.get(threadId) === entityKey;
    activeEntityKeys.set(threadId, entityKey);
    const before = sameTurn ? read(threadId) : EMPTY;
    if (!sameTurn) {
      receivedItems.delete(threadId);
      epochs.set(threadId, {});
    }
    const questions: Record<string, AsyncQuestionDraft> = {};
    for (const question of activeTurnId === null ? [] : scope.questions) {
      const candidate = before.questions[question.id];
      const previous =
        candidate?.sourceEntityKey === question.sourceEntityKey ? candidate : undefined;
      const canonicalBaseline = answers.get(question.id) ?? "";
      // A successful steer may be acknowledged before its canonical echo reaches this renderer.
      const baseline =
        previous?.canonicalBaseline === canonicalBaseline
          ? previous.baseline
          : answers.has(question.id)
            ? canonicalBaseline
            : (question.initialAnswer ?? "");
      const answered =
        answers.has(question.id) ||
        (previous?.canonicalBaseline === canonicalBaseline && previous.answered);
      const followsBaseline = !previous || previous.draft === previous.baseline;
      const draft = followsBaseline ? baseline : previous.draft;
      const draftKind =
        followsBaseline && baseline !== previous?.baseline
          ? question.options.includes(draft)
            ? "option"
            : "freeform"
          : (previous?.draftKind ?? "freeform");
      questions[question.id] = {
        ...question,
        turnId: activeTurnId!,
        draft,
        draftKind,
        freeformDraft:
          followsBaseline && draftKind === "freeform" ? draft : (previous?.freeformDraft ?? ""),
        baseline,
        answered,
        canonicalBaseline,
        skipped: previous?.skipped ?? false,
        deadlineMs: previous?.deadlineMs ?? null,
      };
    }
    const selectedId =
      before.selectedId &&
      questions[before.selectedId] &&
      before.questions[before.selectedId]?.sourceEntityKey ===
        questions[before.selectedId]?.sourceEntityKey
        ? before.selectedId
        : null;
    const openIds = selectedId ? before.openIds.filter((id) => questions[id]) : [];
    const openedAutomatically = selectedId !== null && before.openedAutomatically;
    const next = {
      questions,
      openIds,
      selectedId,
      openedAutomatically,
      submitting: before.submitting,
      activeTurnId,
    };
    generations.set(threadId, generation);
    if (initialized && JSON.stringify(read(threadId)) === JSON.stringify(next)) return;
    publish(threadId, next);
    watchDrafts(threadId, !sameTurn);
  };
  return {
    read,
    acknowledge,
    prepareSubmission,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear(threadId?: string) {
      if (threadId) {
        states.delete(threadId);
        generations.delete(threadId);
        epochs.delete(threadId);
        activeEntityKeys.delete(threadId);
        receivedItems.delete(threadId);
      } else {
        states.clear();
        generations.clear();
        epochs.clear();
        activeEntityKeys.clear();
        receivedItems.clear();
      }
      for (const [key, release] of draftWatches) {
        if (threadId && !key.includes(JSON.stringify(threadId))) continue;
        release();
        draftWatches.delete(key);
      }
      if (threadId) submissions.delete(threadId);
      else submissions.clear();
      for (const listener of listeners) listener();
    },
    /** Native source questions remain answerable after their Turn ends. */
    reconcile(
      conversation: Pick<
        CodexConversationSnapshot,
        "threadId" | "conversationEntityGeneration" | "canonicalState"
      >,
    ) {
      const canonical = conversation.canonicalState;
      if (!canonical) return;
      const turns = canonical.turnHistory
        ? mergeCodexCanonicalTurnStates(residentConversationTurns(canonical), canonical.turns)
        : canonical.turns;
      const active = turns.findLast((turn) => turn.status === "inProgress");
      const items = turns.flatMap((turn) => turn.items);
      const questions = turns.flatMap((turn) =>
        turn.items.flatMap(expandCodexAsyncQuestions).map((question) => ({
          ...question,
          sourceTurnId: turn.turnId ?? undefined,
          sourceEntityKey: turn.entityKey ?? turn.turnId ?? undefined,
        })),
      );
      reconcileScope(conversation.threadId, {
        generation: conversation.conversationEntityGeneration,
        turnId: active?.turnId ?? questions.at(-1)?.sourceTurnId ?? null,
        entityKey: "native:questions",
        questions,
        answers: collectCodexAsyncQuestionAnswers(items),
      });
    },
    reconcileScope,
    close,
    /** Called only for an admitted live item/started event, never history hydration. */
    receive(threadId: string, sourceItemId: string, now = Date.now()) {
      const received = receivedItems.get(threadId) ?? new Set<string>();
      const state = read(threadId);
      const sourceKey = JSON.stringify([
        Object.values(state.questions).find((question) => question.sourceItemId === sourceItemId)
          ?.sourceEntityKey,
        sourceItemId,
      ]);
      if (received.has(sourceKey)) return;
      const arrivals = Object.values(state.questions).filter(
        (question) =>
          question.sourceItemId === sourceItemId &&
          question.turnId === state.activeTurnId &&
          !question.answered,
      );
      if (!arrivals.length) return;
      received.add(sourceKey);
      receivedItems.set(threadId, received);
      const questions = { ...state.questions };
      for (const question of arrivals)
        questions[question.id] = { ...question, deadlineMs: now + 30_000 };
      const openIds = [...new Set([...state.openIds, ...arrivals.map((question) => question.id)])];
      const selectedId = state.selectedId ?? arrivals[0]!.id;
      if (questions[selectedId]?.deadlineMs)
        questions[selectedId] = { ...questions[selectedId]!, deadlineMs: now + 30_000 };
      publish(threadId, {
        ...state,
        questions,
        openIds,
        selectedId,
        openedAutomatically: state.selectedId ? state.openedAutomatically : true,
      });
    },
    open(threadId: string, id: string) {
      const state = read(threadId);
      const question = state.questions[id];
      if (!question || question.turnId !== state.activeTurnId) return;
      publish(threadId, {
        ...state,
        openIds: [id],
        selectedId: id,
        openedAutomatically: false,
        questions: { ...state.questions, [id]: { ...question, deadlineMs: null } },
      });
      persistPanel(threadId, read(threadId));
    },
    select(threadId: string, id: string) {
      const state = read(threadId);
      if (!state.openIds.includes(id)) return;
      publish(threadId, {
        ...state,
        selectedId: id,
        questions: { ...state.questions, [id]: { ...state.questions[id]!, deadlineMs: null } },
      });
      persistPanel(threadId, read(threadId));
    },
    setDraft(threadId: string, id: string, draft: string) {
      updateQuestion(threadId, id, {
        draft,
        freeformDraft: draft,
        draftKind: "freeform",
        deadlineMs: null,
      });
      const question = read(threadId).questions[id];
      if (question) persistDraft(threadId, question);
    },
    selectOption(threadId: string, id: string, index: number) {
      const option = read(threadId).questions[id]?.options[index];
      if (option === undefined) return;
      updateQuestion(threadId, id, { draft: option, draftKind: "option", deadlineMs: null });
      persistDraft(threadId, read(threadId).questions[id]!);
    },
    focusFreeform(threadId: string, id: string) {
      const question = read(threadId).questions[id];
      if (!question) return;
      updateQuestion(threadId, id, {
        draft: question.freeformDraft,
        draftKind: "freeform",
        deadlineMs: null,
      });
      persistDraft(threadId, read(threadId).questions[id]!);
    },
    touch(threadId: string, id: string) {
      updateQuestion(threadId, id, { deadlineMs: null });
    },
    skip(threadId: string, id: string) {
      updateQuestion(threadId, id, {
        draft: "",
        freeformDraft: "",
        draftKind: "freeform",
        skipped: true,
        deadlineMs: null,
      });
      const question = read(threadId).questions[id];
      if (question) persistDraft(threadId, question);
    },
    expire(threadId: string, id: string, deadline: number) {
      const state = read(threadId);
      if (state.selectedId !== id || state.questions[id]?.deadlineMs !== deadline) return;
      close(threadId);
    },
    async submit(threadId: string, deliver: AsyncQuestionDelivery) {
      const state = read(threadId);
      if (!state.activeTurnId || state.submitting) return;
      const epoch = epochs.get(threadId);
      const isCurrent = () =>
        epochs.get(threadId) === epoch && read(threadId).activeTurnId !== null;
      const batch = state.openIds.flatMap((id) => {
        const question = state.questions[id];
        return question
          ? [{ questionItemId: id, question: question.title, answer: answerText(question) }]
          : [];
      });
      const replies = batch.filter(
        (reply) =>
          reply.answer.length > 0 ||
          state.questions[reply.questionItemId]?.initialAnswer !== undefined,
      );
      if (!replies.length) {
        close(threadId);
        return;
      }
      publish(threadId, { ...state, submitting: true });
      try {
        const sourceTurnIds = [
          ...new Set(
            replies.flatMap((reply) => state.questions[reply.questionItemId]?.sourceTurnId ?? []),
          ),
        ];
        const submissionId = options.drafts
          ? await prepareSubmission(threadId, replies)
          : getSubmission(threadId, replies).id;
        if (!isCurrent()) return;
        const result = await deliver(state.activeTurnId, replies, {
          submissionId,
          sourceTurnIds,
        });
        if (!isCurrent() || !result) return;
        acknowledge(threadId, replies, batch);
      } catch (error) {
        if (isCurrent() && read(threadId).activeTurnId === state.activeTurnId) throw error;
      } finally {
        if (isCurrent() && read(threadId).submitting)
          publish(threadId, { ...read(threadId), submitting: false });
      }
    },
  };
}
export type AsyncQuestionRuntime = ReturnType<typeof createAsyncQuestionRuntime>;
