import { createCodexCanonicalHydratedConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { createCodexQueuedFollowUp } from "../../../shared/codex-queued-follow-up-state";
import { describe, expect, test, vi } from "vite-plus/test";
import { createAsyncQuestionRuntime } from "./async-question-runtime";
import {
  encodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
} from "../../../shared/codex-async-user-input";
import type {
  CodexCanonicalItem,
  CodexCanonicalSteeringUserMessageItem,
  CodexCanonicalTurnState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";

const question: CodexCanonicalItem = {
  type: "agentMessage",
  id: "ask",
  text: "Choose",
  delivery: "async",
  questions: [
    { title: "Which scope?", options: ["Local", "Global"] },
    { title: "What name?", options: null },
  ],
  phase: "final_answer",
  memoryCitation: null,
};
const ids = expandCodexAsyncQuestions(question).map((entry) => entry.id);
function conversation(
  items: readonly CodexCanonicalItem[],
  status: CodexCanonicalTurnState["status"] = "inProgress",
  threadId = "thread",
) {
  const base = createCodexCanonicalHydratedConversationState(
    { ...buildAgentActivityV2CorpusThread([]), id: threadId },
    {
      hostId: "local",
      model: "test",
      reasoningEffort: null,
      cwd: "/repo",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/repo"],
    },
  );
  return {
    threadId,
    canonicalState: {
      ...base,
      turns: [
        {
          rootTurnId: null,
          ...base.turns[0]!,
          turnId: "turn",
          status,
          error: null,
          durationMs: null,
          itemsView: "full" as const,
          items,
        },
      ],
    },
  };
}
function setup() {
  const runtime = createAsyncQuestionRuntime();
  runtime.reconcile(conversation([]));
  runtime.reconcile(conversation([question]));
  runtime.receive("thread", "ask", 200);
  return runtime;
}
function answer(answerText: string, id = "answer"): CodexCanonicalItem {
  return {
    type: "userMessage",
    id,
    clientId: id,
    content: [
      {
        type: "text",
        text: encodeCodexAsyncQuestionReplies([
          { questionItemId: ids[0]!, question: "Which scope?", answer: answerText },
        ]),
        text_elements: [],
      },
    ],
  };
}

describe("asynchronous question lifecycle", () => {
  test("history does not open; live multi-question arrival opens without selecting or submitting a default", () => {
    const history = createAsyncQuestionRuntime();
    history.reconcile(conversation([question]));
    expect(history.read("thread").selectedId).toBeNull();
    const refreshed = createAsyncQuestionRuntime();
    refreshed.reconcile(conversation([]));
    refreshed.reconcile(conversation([question]));
    expect(refreshed.read("thread").selectedId).toBeNull();
    const runtime = setup();
    expect(runtime.read("thread").openIds).toEqual(ids);
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("");
    expect(runtime.read("thread").questions[ids[0]!]!.deadlineMs).toBe(30_200);
  });
  test("interaction cancels expiry; obsolete expiry callbacks cannot close a reopened question", () => {
    const runtime = setup();
    runtime.touch("thread", ids[0]!);
    runtime.expire("thread", ids[0]!, 30_200);
    expect(runtime.read("thread").selectedId).toBe(ids[0]);
    runtime.close("thread");
    runtime.open("thread", ids[0]!);
    runtime.expire("thread", ids[0]!, 30_200);
    expect(runtime.read("thread").openedAutomatically).toBe(false);
    expect(runtime.read("thread").selectedId).toBe(ids[0]);
  });
  test("unattended questions close without being skipped or answered", () => {
    const runtime = setup();
    runtime.expire("thread", ids[0]!, 30_200);
    expect(runtime.read("thread").selectedId).toBeNull();
    expect(runtime.read("thread").questions[ids[0]!]!.skipped).toBe(false);
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("");
  });
  test("skip omits only that answer and submission uses the current turn envelope", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, " Local ");
    runtime.skip("thread", ids[1]!);
    const deliver = vi.fn().mockResolvedValue({ turnId: "turn" });
    await runtime.submit("thread", deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toBe("turn");
    expect(deliver.mock.calls[0]![1]).toEqual([
      { questionItemId: ids[0], question: "Which scope?", answer: "Local" },
    ]);
    expect(runtime.read("thread").selectedId).toBeNull();
  });
  test("failures preserve drafts and permit retry", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, "Local");
    await expect(
      runtime.submit("thread", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(runtime.read("thread").submitting).toBe(false);
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("Local");
    expect(runtime.read("thread").selectedId).toBe(ids[0]);
  });
  test("turn completion retains an unanswered question with its source identity", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, "Local");
    runtime.reconcile(conversation([question], "completed"));
    const steer = vi.fn();
    await runtime.submit("thread", steer);
    runtime.open("thread", ids[0]!);
    expect(steer).toHaveBeenCalledOnce();
    expect(steer.mock.calls[0]?.[2]).toMatchObject({ sourceTurnIds: ["turn"] });
    expect(runtime.read("thread").selectedId).toBe(ids[0]);
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("Local");
  });
  test("accepted answers update an untouched draft but preserve newer local edits", () => {
    const runtime = setup();
    runtime.reconcile(conversation([question, answer("Local")]));
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("Local");
    runtime.setDraft("thread", ids[0]!, "New local answer");
    runtime.reconcile(conversation([question, answer("Global")]));
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("New local answer");
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Global");
  });
  test("new questions append without stealing selection; threads and entity generations are isolated", () => {
    const runtime = setup();
    runtime.select("thread", ids[1]!);
    const extra = { ...question, id: "ask-again" };
    runtime.reconcile(conversation([question, extra]));
    runtime.receive("thread", "ask-again");
    expect(runtime.read("thread").selectedId).toBe(ids[1]);
    expect(runtime.read("thread").openIds).toHaveLength(4);
    runtime.close("thread");
    runtime.receive("thread", "ask-again");
    expect(runtime.read("thread").selectedId).toBeNull();
    runtime.reconcile(conversation([question], "inProgress", "other"));
    expect(runtime.read("other").selectedId).toBeNull();
    runtime.reconcile({ ...conversation([question]), conversationEntityGeneration: 2 });
    expect(runtime.read("thread").selectedId).toBeNull();
  });
  test("in-flight edits survive an accepted submission", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, "Local");
    let resolve!: () => void;
    const sending = runtime.submit(
      "thread",
      () =>
        new Promise<{ turnId: string }>((done) => {
          resolve = () => done({ turnId: "turn" });
        }),
    );
    runtime.setDraft("thread", ids[0]!, "Global");
    resolve();
    await sending;
    expect(runtime.read("thread").selectedId).toBe(ids[0]);
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("Global");
  });
  test("pending steering is not an answer and an old server echo cannot override an update", () => {
    const runtime = setup();
    const old = answer("Local", "old");
    const updated = answer("Global", "updated");
    if (old.type !== "userMessage" || updated.type !== "userMessage") throw new Error("fixture");
    const steer = (
      item: typeof old,
      status: "pending" | "accepted",
    ): CodexCanonicalSteeringUserMessageItem => ({
      type: "steeringUserMessage",
      id: `steer:${item.id}`,
      targetTurnId: "turn",
      targetTurnStartedAtMs: null,
      status,
      clientUserMessageId: item.clientId,
      input: item.content,
      attachments: [],
      restoreMessage: {
        queueRow: createCodexQueuedFollowUp({
          followUpId: item.id,
          clientUserMessageId: item.id,
          threadId: "thread",
          prompt: "reply",
          createdAtMs: 0,
        }),
        context: { commentAttachments: [] },
      },
      compareKey: {
        rawText: item.content[0]?.type === "text" ? item.content[0].text : "",
        imageCount: 0,
      },
    });
    runtime.reconcile(conversation([question, steer(old, "pending")]));
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("");
    runtime.reconcile(
      conversation([question, steer(old, "accepted"), steer(updated, "accepted"), old]),
    );
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Global");
    runtime.reconcile(
      conversation([
        question,
        steer(old, "accepted"),
        steer(updated, "accepted"),
        answer("Local", "new-response"),
      ]),
    );
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Local");
    runtime.reconcile(
      conversation([
        question,
        { ...steer(old, "accepted"), serverUserMessageId: "different-server-message" },
        steer(updated, "accepted"),
        old,
      ]),
    );
    // A different server message cannot be demoted to the earlier steer solely by client/text match.
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Local");
  });
  test("acknowledges a successful reply before the echo and prunes only unchanged answers", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, " Local ");
    runtime.setDraft("thread", ids[1]!, "Name");
    runtime.select("thread", ids[1]!);
    let resolve!: (value: { turnId: string }) => void;
    const sending = runtime.submit(
      "thread",
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    runtime.setDraft("thread", ids[1]!, "New name");
    const extra = { ...question, id: "later" };
    runtime.reconcile(conversation([question, extra]));
    runtime.receive("thread", "later");
    resolve({ turnId: "turn" });
    await sending;
    expect(runtime.read("thread").openIds).toEqual([
      ids[1],
      ...expandCodexAsyncQuestions(extra).map((entry) => entry.id),
    ]);
    expect(runtime.read("thread").selectedId).toBe(ids[1]);
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Local");
    runtime.reconcile(conversation([question, extra]));
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Local");
    expect(runtime.read("thread").questions[ids[1]!]!.draft).toBe("New name");
  });
  test("trimmed unchanged answers close the batch and a null response leaves it retryable", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, " Local ");
    await runtime.submit("thread", async () => null);
    expect(runtime.read("thread").openIds).toEqual(ids);
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("");
    await runtime.submit("thread", async () => ({ turnId: "turn" }));
    expect(runtime.read("thread").openIds).toEqual([]);
  });
  test.each(["complete", "fail"] as const)(
    "a stale submission cannot %s into a replaced generation",
    async (outcome) => {
      const runtime = setup();
      runtime.setDraft("thread", ids[0]!, "Old");
      let resolve!: (value: { turnId: string }) => void;
      let reject!: (error: Error) => void;
      const sending = runtime.submit(
        "thread",
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      runtime.clear("thread");
      runtime.reconcile(conversation([question]));
      runtime.receive("thread", "ask");
      runtime.setDraft("thread", ids[0]!, "New");
      let finishNew!: (value: { turnId: string }) => void;
      const newer = runtime.submit(
        "thread",
        () =>
          new Promise((done) => {
            finishNew = done;
          }),
      );
      if (outcome === "complete") resolve({ turnId: "turn" });
      else reject(new Error("Old request failed"));
      await sending;
      expect(runtime.read("thread").submitting).toBe(true);
      expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("");
      expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("New");
      finishNew({ turnId: "turn" });
      await newer;
    },
  );
  test("questions and answers from older Turns cannot overwrite a reused live item identity", () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, "Old draft");
    const older = conversation([question, answer("Old answer")], "completed").canonicalState
      .turns[0]!;
    const active = {
      ...conversation([question]).canonicalState.turns[0]!,
      turnId: "new-turn",
      status: "inProgress" as const,
    };
    runtime.reconcile({
      threadId: "thread",
      canonicalState: { ...conversation([]).canonicalState, turns: [older, active] },
    });
    expect(runtime.read("thread").openIds).toEqual([]);
    expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("");
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("");
    runtime.receive("thread", "ask");
    expect(runtime.read("thread").selectedId).toBe(ids[0]);
  });
  test("removing the selected question closes the batch instead of unexpectedly switching questions", () => {
    const runtime = setup();
    const extra = { ...question, id: "later" };
    runtime.reconcile(conversation([question, extra]));
    runtime.receive("thread", "later");
    runtime.reconcile(conversation([extra]));
    expect(runtime.read("thread").selectedId).toBeNull();
  });
});

test("preserves an in-flight question batch across an explicit Turn identity correction", async () => {
  const runtime = setup();
  runtime.setDraft("thread", ids[0]!, "Local");
  await runtime.submit("thread", async () => {
    const corrected = conversation([question]);
    corrected.canonicalState.turns[0]!.turnId = "corrected";
    runtime.reconcile({
      ...corrected,
      canonicalState: {
        ...corrected.canonicalState,
        turns: corrected.canonicalState.turns.map((turn) => ({
          ...turn,
          entityKey: "turn",
        })),
      },
    });
    expect(runtime.read("thread").submitting).toBe(true);
    expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("Local");
    return { turnId: "corrected" };
  });
  expect(runtime.read("thread").selectedId).toBeNull();
  expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("Local");
  expect(runtime.read("thread").submitting).toBe(false);
});

test("a corrected Turn keeps its draft and releases submission after a failed retry", async () => {
  const runtime = setup();
  runtime.setDraft("thread", ids[0]!, "Keep me");
  await runtime.submit("thread", async () => {
    const corrected = conversation([question]);
    runtime.reconcile({
      ...corrected,
      canonicalState: {
        ...corrected.canonicalState,
        turns: corrected.canonicalState.turns.map((turn) => ({
          ...turn,
          turnId: "corrected",
          entityKey: "turn",
        })),
      },
    });
    throw new Error("Retry failed after identity correction");
  });
  expect(runtime.read("thread").questions[ids[0]!]!.draft).toBe("Keep me");
  expect(runtime.read("thread").questions[ids[0]!]!.baseline).toBe("");
  expect(runtime.read("thread").selectedId).toBe(ids[0]);
  expect(runtime.read("thread").submitting).toBe(false);
});

test("resident history owns active questions while overlay answers reconcile against the same Turn", () => {
  const runtime = createAsyncQuestionRuntime();
  const fixture = conversation([question]);
  const turn = fixture.canonicalState.turns[0]!;
  const canonicalState = {
    ...fixture.canonicalState,
    turns: [],
    turnHistory: {
      kind: "canonical" as const,
      history: {
        generation: 1,
        isComplete: true,
        islands: [
          {
            id: "tail",
            entries: [{ key: "stable-entry", value: "turn:turn" }],
            olderBoundary: { status: "exhausted" as const, boundaryId: "older" },
            newerBoundary: { status: "exhausted" as const, boundaryId: "newer" },
          },
        ],
        entitiesByKey: { "turn:turn": turn },
      },
    },
  };
  runtime.reconcile({ ...fixture, canonicalState });
  expect(runtime.read("thread").questions[ids[0]!]?.title).toBe("Which scope?");
  expect(runtime.read("thread").openIds).toEqual([]);
  runtime.receive("thread", "ask", 200);
  expect(runtime.read("thread").selectedId).toBe(ids[0]);
  runtime.reconcile({
    ...fixture,
    canonicalState: {
      ...canonicalState,
      turns: [{ ...turn, items: [question, answer("Overlay answer")] }],
    },
  });
  expect(runtime.read("thread").questions[ids[0]!]?.baseline).toBe("Overlay answer");
  runtime.reconcile({
    ...fixture,
    canonicalState: {
      ...canonicalState,
      turnHistory: {
        ...canonicalState.turnHistory,
        history: {
          ...canonicalState.turnHistory.history,
          entitiesByKey: { "turn:turn": { ...turn, status: "completed" } },
        },
      },
    },
  });
  expect(runtime.read("thread").activeTurnId).toBe("turn");
  expect(runtime.read("thread").questions[ids[0]!]?.title).toBe("Which scope?");
});

function draftStorage() {
  const entries = new Map<string, { signature: string; value: unknown }>();
  const listeners = new Map<string, Set<() => void>>();
  const store: import("./question-draft-store").QuestionDraftStore = {
    flush: async () => {},
    read: (key, signature) =>
      entries.get(key)?.signature === signature ? entries.get(key)?.value : undefined,
    watch(key, listener) {
      const current = listeners.get(key) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(key, current);
      return () => {
        current.delete(listener);
      };
    },
    write(key, signature, value) {
      entries.set(key, { signature, value });
      for (const listener of listeners.get(key) ?? []) listener();
    },
    remove(key) {
      entries.delete(key);
      for (const listener of listeners.get(key) ?? []) listener();
    },
  };
  return { store, entries };
}

test("restores authored drafts and panel selection after release and a fresh conversation generation", () => {
  const { store } = draftStorage();
  const first = createAsyncQuestionRuntime({ drafts: store });
  first.reconcile(conversation([question]));
  first.open("thread", ids[1]!);
  first.setDraft("thread", ids[1]!, "Keep my unfinished answer");
  first.clear("thread");
  const reopened = createAsyncQuestionRuntime({ drafts: store });
  reopened.reconcile({ ...conversation([question], "completed"), conversationEntityGeneration: 9 });
  expect(reopened.read("thread").selectedId).toBe(ids[1]);
  expect(reopened.read("thread").questions[ids[1]!]!.draft).toBe("Keep my unfinished answer");
  reopened.reconcile(conversation([question], "completed", "another-thread"));
  expect(reopened.read("another-thread").questions[ids[1]!]!.draft).toBe("");
});

test("secret answers never enter durable question drafts", () => {
  const { store, entries } = draftStorage();
  const runtime = createAsyncQuestionRuntime({ drafts: store });
  const scope = {
    generation: 1,
    entityKey: "request",
    turnId: "turn",
    answers: new Map<string, string>(),
    questions: [
      {
        id: "secret",
        sourceItemId: "ask",
        questionIndex: 0,
        title: "Token?",
        options: [],
        isSecret: true,
      },
    ],
  };
  runtime.reconcileScope("thread", scope);
  runtime.open("thread", "secret");
  runtime.setDraft("thread", "secret", "private-token");
  expect(JSON.stringify([...entries.values()])).not.toContain("private-token");
  runtime.clear();
  runtime.reconcileScope("thread", { ...scope, generation: 2 });
  expect(runtime.read("thread").questions.secret!.draft).toBe("");
});

test("acknowledges each request before a later batch member fails and retries only the remainder", async () => {
  const runtime = setup();
  runtime.setDraft("thread", ids[0]!, "Alpha");
  runtime.setDraft("thread", ids[1]!, "Beta");
  await expect(
    runtime.submit("thread", async (_turn, replies) => {
      runtime.acknowledge("thread", [replies[0]!]);
      throw new Error("Second request failed");
    }),
  ).rejects.toThrow("Second request failed");
  const retry = vi.fn<import("./async-question-runtime").AsyncQuestionDelivery>(async () => ({
    turnId: "turn",
  }));
  await runtime.submit("thread", retry);
  expect(retry.mock.calls[0]?.[1]).toEqual([
    { questionItemId: ids[1], question: "What name?", answer: "Beta" },
  ]);
});

test("retries an unchanged batch with one submission identity and replaces it after an edit", async () => {
  const runtime = setup();
  runtime.setDraft("thread", ids[0]!, "Alpha");
  const tokens: string[] = [];
  const fail: import("./async-question-runtime").AsyncQuestionDelivery = async (
    _turn,
    _replies,
    context,
  ) => {
    tokens.push(context.submissionId);
    throw new Error("Unknown delivery");
  };
  await expect(runtime.submit("thread", fail)).rejects.toThrow();
  await expect(runtime.submit("thread", fail)).rejects.toThrow();
  runtime.setDraft("thread", ids[0]!, "Revised");
  await expect(runtime.submit("thread", fail)).rejects.toThrow();
  expect(tokens[0]).toBe(tokens[1]);
  expect(tokens[2]).not.toBe(tokens[0]);
});

test("message questions retain editable initial text and accept explicit empty answers", async () => {
  const runtime = createAsyncQuestionRuntime();
  runtime.reconcileScope("thread", {
    generation: 1,
    entityKey: "editable",
    turnId: "turn",
    answers: new Map(),
    questions: [
      {
        id: "editable",
        sourceItemId: "source",
        questionIndex: 0,
        title: "Change text?",
        options: [],
        initialAnswer: "  Original  ",
      },
    ],
  });
  runtime.open("thread", "editable");
  expect(runtime.read("thread").questions.editable?.draft).toBe("  Original  ");
  runtime.setDraft("thread", "editable", "");
  const deliver = vi.fn<import("./async-question-runtime").AsyncQuestionDelivery>(async () => ({
    turnId: "turn",
  }));
  await runtime.submit("thread", deliver);
  expect(deliver.mock.calls[0]?.[1]).toEqual([
    { questionItemId: "editable", question: "Change text?", answer: "" },
  ]);
  expect(runtime.read("thread").questions.editable).toMatchObject({ answered: true, baseline: "" });
  expect(runtime.read("thread").selectedId).toBeNull();
});

test("the same native Thread on another host cannot read a question draft", () => {
  const { store } = draftStorage();
  const first = createAsyncQuestionRuntime({ drafts: store, namespace: "native:host-a" });
  first.reconcile(conversation([question]));
  first.open("thread", ids[0]!);
  first.setDraft("thread", ids[0]!, "Host A draft");
  const second = createAsyncQuestionRuntime({ drafts: store, namespace: "native:host-b" });
  second.reconcile(conversation([question]));
  expect(second.read("thread").questions[ids[0]!]!.draft).toBe("");
  expect(second.read("thread").selectedId).toBeNull();
});

test("an unknown native response keeps its immutable submission identity after reopening", async () => {
  const { store } = draftStorage();
  const first = createAsyncQuestionRuntime({ drafts: store });
  first.reconcile(conversation([question]));
  first.open("thread", ids[0]!);
  first.setDraft("thread", ids[0]!, "A durable response");
  const tokens: string[] = [];
  const unknown: import("./async-question-runtime").AsyncQuestionDelivery = async (
    _turn,
    _replies,
    context,
  ) => {
    tokens.push(context.submissionId);
    throw new Error("Unknown native response");
  };
  await expect(first.submit("thread", unknown)).rejects.toThrow();
  first.clear();
  const reopened = createAsyncQuestionRuntime({ drafts: store });
  reopened.reconcile(conversation([question], "completed"));
  await expect(reopened.submit("thread", unknown)).rejects.toThrow();
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBe(tokens[1]);
});

test("a source released during submission preparation cannot make private text durable", async () => {
  const { store, entries } = draftStorage();
  let resume!: () => void;
  const runtime = createAsyncQuestionRuntime({
    drafts: {
      ...store,
      flush: () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    },
  });
  runtime.reconcileScope("thread", {
    generation: 1,
    entityKey: "secret-source",
    turnId: "turn",
    answers: new Map(),
    questions: [
      {
        id: "secret",
        sourceItemId: "source",
        questionIndex: 0,
        title: "Token?",
        options: [],
        isSecret: true,
      },
    ],
  });
  const pending = runtime.prepareSubmission("thread", [
    { questionItemId: "secret", question: "Token?", answer: "private-answer" },
  ]);
  runtime.clear("thread");
  resume();
  await pending;
  expect(JSON.stringify([...entries.values()])).not.toContain("private-answer");
});

test("an execution with no questions does not acquire draft persistence", () => {
  const { store } = draftStorage();
  const readDraft = vi.spyOn(store, "read");
  const watchDraft = vi.spyOn(store, "watch");
  const runtime = createAsyncQuestionRuntime({ drafts: store });
  runtime.reconcile(conversation([]));
  expect(readDraft).not.toHaveBeenCalled();
  expect(watchDraft).not.toHaveBeenCalled();
  runtime.reconcile(conversation([question]));
  expect(readDraft).toHaveBeenCalled();
  expect(watchDraft).toHaveBeenCalled();
});
