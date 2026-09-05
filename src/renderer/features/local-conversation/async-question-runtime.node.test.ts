import { createCodexQueuedFollowUp } from "../../../shared/codex-queued-follow-up-state";
import { describe, expect, test, vi } from "vite-plus/test";
import { createAsyncQuestionRuntime } from "./async-question-runtime";
import {
  decodeCodexAsyncQuestionReplies,
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
  status: CodexCanonicalTurnState["protocol"]["status"] = "inProgress",
  threadId = "thread",
) {
  return {
    threadId,
    canonicalState: {
      turns: [
        {
          protocol: {
            id: "turn",
            status,
            error: null,
            durationMs: null,
            itemsView: "full" as const,
          },
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
    const steer = vi.fn().mockResolvedValue({ turnId: "turn" });
    await runtime.submit("thread", steer);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]![0]).toBe("turn");
    expect(decodeCodexAsyncQuestionReplies(steer.mock.calls[0]![1])).toEqual([
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
  test("turn completion removes the panel and cannot start a replacement turn", async () => {
    const runtime = setup();
    runtime.setDraft("thread", ids[0]!, "Local");
    runtime.reconcile(conversation([question], "completed"));
    const steer = vi.fn();
    await runtime.submit("thread", steer);
    runtime.open("thread", ids[0]!);
    expect(steer).not.toHaveBeenCalled();
    expect(runtime.read("thread").selectedId).toBeNull();
    expect(runtime.read("thread").questions).toEqual({});
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
      protocol: { ...older.protocol, id: "new-turn", status: "inProgress" as const },
    };
    runtime.reconcile({ threadId: "thread", canonicalState: { turns: [older, active] } });
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
    corrected.canonicalState.turns[0]!.protocol.id = "corrected";
    runtime.reconcile({
      ...corrected,
      canonicalState: {
        turns: corrected.canonicalState.turns.map((turn) => ({
          ...turn,
          sidecar: { entityKey: "turn" },
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
        turns: corrected.canonicalState.turns.map((turn) => ({
          ...turn,
          protocol: { ...turn.protocol, id: "corrected" },
          sidecar: { entityKey: "turn" },
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
