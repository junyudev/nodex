import type { CodexCanonicalTurnState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  expandCodexAsyncQuestions,
  collectCodexAsyncQuestionAnswers,
  encodeCodexAsyncQuestionReplies,
  type CodexAsyncQuestion,
} from "../../../shared/codex-async-user-input";
import type { CodexConversationSnapshot } from "../../../shared/types";

export interface AsyncQuestionDraft extends CodexAsyncQuestion {
  turnId: string;
  draft: string;
  draftKind: "option" | "freeform";
  freeformDraft: string;
  baseline: string;
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
const EMPTY: AsyncQuestionSnapshot = {
  questions: {},
  openIds: [],
  selectedId: null,
  openedAutomatically: false,
  submitting: false,
  activeTurnId: null,
};

/** Host-owned ephemeral drafts; accepted conversation messages remain the answer authority. */
export function createAsyncQuestionRuntime() {
  const states = new Map<string, AsyncQuestionSnapshot>();
  const generations = new Map<string, number | undefined>();
  const listeners = new Set<() => void>();
  const epochs = new Map<string, object>();
  const activeEntityKeys = new Map<string, string | null>();
  const receivedItems = new Map<string, Set<string>>();
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
  const close = (threadId: string) =>
    publish(threadId, { ...read(threadId), openIds: [], selectedId: null });
  return {
    read,
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
      for (const listener of listeners) listener();
    },
    reconcile(
      conversation: Pick<CodexConversationSnapshot, "threadId" | "conversationEntityGeneration"> & {
        canonicalState?: {
          turns: readonly (Pick<CodexCanonicalTurnState, "protocol" | "items"> & {
            sidecar?: Pick<CodexCanonicalTurnState["sidecar"], "entityKey">;
          })[];
        } | null;
      },
    ) {
      const threadId = conversation.threadId;
      const canonical = conversation.canonicalState;
      if (!canonical) return;
      const generation = conversation.conversationEntityGeneration;
      const initialized = states.has(threadId) && generations.get(threadId) === generation;
      const active = canonical.turns.findLast((turn) => turn.protocol.status === "inProgress");
      const activeTurnId = active?.protocol.id ?? null;
      const entityKey = active?.sidecar?.entityKey ?? activeTurnId;
      const sameTurn = initialized && activeEntityKeys.get(threadId) === entityKey;
      activeEntityKeys.set(threadId, entityKey);
      const before = sameTurn ? read(threadId) : EMPTY;
      if (!sameTurn) {
        receivedItems.delete(threadId);
        epochs.set(threadId, {});
      }
      // Completed Turns are rendered from canonical history; only the active Turn owns drafts.
      const items = active?.items ?? [];
      const answers = collectCodexAsyncQuestionAnswers(items);
      const questions: Record<string, AsyncQuestionDraft> = {};
      for (const question of items.flatMap(expandCodexAsyncQuestions)) {
        const previous = before.questions[question.id];
        const canonicalBaseline = answers.get(question.id) ?? "";
        // A successful steer may be acknowledged before its canonical echo reaches this renderer.
        const baseline =
          previous?.canonicalBaseline === canonicalBaseline ? previous.baseline : canonicalBaseline;
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
          canonicalBaseline,
          skipped: previous?.skipped ?? false,
          deadlineMs: previous?.deadlineMs ?? null,
        };
      }
      const selectedId =
        before.selectedId && questions[before.selectedId] ? before.selectedId : null;
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
    },
    close,
    /** Called only for an admitted live item/started event, never history hydration. */
    receive(threadId: string, sourceItemId: string, now = Date.now()) {
      const received = receivedItems.get(threadId) ?? new Set<string>();
      if (received.has(sourceItemId)) return;
      const state = read(threadId);
      const arrivals = Object.values(state.questions).filter(
        (question) =>
          question.sourceItemId === sourceItemId &&
          question.turnId === state.activeTurnId &&
          !question.baseline,
      );
      if (!arrivals.length) return;
      received.add(sourceItemId);
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
    },
    select(threadId: string, id: string) {
      const state = read(threadId);
      if (!state.openIds.includes(id)) return;
      publish(threadId, {
        ...state,
        selectedId: id,
        questions: { ...state.questions, [id]: { ...state.questions[id]!, deadlineMs: null } },
      });
    },
    setDraft(threadId: string, id: string, draft: string) {
      updateQuestion(threadId, id, {
        draft,
        freeformDraft: draft,
        draftKind: "freeform",
        deadlineMs: null,
      });
    },
    selectOption(threadId: string, id: string, index: number) {
      const option = read(threadId).questions[id]?.options[index];
      if (option === undefined) return;
      updateQuestion(threadId, id, { draft: option, draftKind: "option", deadlineMs: null });
    },
    focusFreeform(threadId: string, id: string) {
      const question = read(threadId).questions[id];
      if (!question) return;
      updateQuestion(threadId, id, {
        draft: question.freeformDraft,
        draftKind: "freeform",
        deadlineMs: null,
      });
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
    },
    expire(threadId: string, id: string, deadline: number) {
      const state = read(threadId);
      if (state.selectedId !== id || state.questions[id]?.deadlineMs !== deadline) return;
      close(threadId);
    },
    async submit(
      threadId: string,
      steer: (turnId: string, prompt: string) => Promise<{ turnId: string } | null>,
    ) {
      const state = read(threadId);
      if (!state.activeTurnId || state.submitting) return;
      const epoch = epochs.get(threadId);
      const isCurrent = () =>
        epochs.get(threadId) === epoch && read(threadId).activeTurnId !== null;
      const batch = state.openIds.flatMap((id) => {
        const question = state.questions[id];
        return question
          ? [{ questionItemId: id, question: question.title, answer: question.draft.trim() }]
          : [];
      });
      const replies = batch.filter((question) => question.answer.length > 0);
      if (!replies.length) {
        close(threadId);
        return;
      }
      publish(threadId, { ...state, submitting: true });
      try {
        const result = await steer(state.activeTurnId, encodeCodexAsyncQuestionReplies(replies));
        if (!isCurrent() || !result) return;
        const current = read(threadId);
        const questions = { ...current.questions };
        for (const reply of replies) {
          const question = questions[reply.questionItemId];
          if (question) questions[reply.questionItemId] = { ...question, baseline: reply.answer };
        }
        const openIds = current.openIds.filter((id) => {
          const submitted = batch.find((reply) => reply.questionItemId === id);
          return !submitted || questions[id]?.draft.trim() !== submitted.answer;
        });
        const selectedId = openIds.includes(current.selectedId ?? "")
          ? current.selectedId
          : (openIds[0] ?? null);
        if (selectedId) questions[selectedId] = { ...questions[selectedId]!, deadlineMs: null };
        publish(threadId, { ...current, questions, openIds, selectedId });
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
