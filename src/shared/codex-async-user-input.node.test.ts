import { describe, expect, test } from "vite-plus/test";
import {
  decodeCodexAsyncQuestionReplies,
  encodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
} from "./codex-async-user-input";
import { projectCodexCanonicalTurnItemViews } from "./codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "./codex-transcript-entry-projection";
import type { CodexCanonicalItem } from "./codex-conversation-state/codex-conversation-state";

const question: CodexCanonicalItem = {
  type: "agentMessage",
  id: "ask",
  text: "Readable fallback",
  phase: "final_answer",
  memoryCitation: null,
  delivery: "async",
  questions: [
    { title: "Where?", options: ["Here", "There"] },
    { title: "Name?", options: null },
  ],
};

describe("asynchronous user input contract", () => {
  test("expands structured questions with stable display identities and commentary semantics", () => {
    const views = projectCodexCanonicalTurnItemViews({
      threadId: "thread",
      turnId: "turn",
      items: [question],
      observedAtMs: 100,
      turnStatus: "inProgress",
    });
    expect(
      views.map((view) => [view.itemId, view.rawItemId, view.assistantPhase, view.markdownText]),
    ).toEqual([
      ['["request_user_input_async","ask",0]', "ask", "commentary", "Where?"],
      ['["request_user_input_async","ask",1]', "ask", "commentary", "Name?"],
    ]);
    expect(
      projectCodexItemViewToTranscriptEntry(views[1]!, "live", 1).asyncQuestion?.options,
    ).toEqual([]);
  });
  test("falls back to a single freeform question only for asynchronous messages", () => {
    expect(expandCodexAsyncQuestions({ ...question, questions: null })).toEqual([
      {
        id: "ask",
        sourceItemId: "ask",
        questionIndex: null,
        title: "Readable fallback",
        options: [],
      },
    ]);
    expect(expandCodexAsyncQuestions({ ...question, delivery: null })).toEqual([]);
  });
  test("round-trips multiple answers, accepting the single-object envelope but rejecting prose and malformed bodies", () => {
    const replies = [{ questionItemId: "q", question: "Name?", answer: 'A\n"quoted" name' }];
    expect(decodeCodexAsyncQuestionReplies(encodeCodexAsyncQuestionReplies(replies))).toEqual(
      replies,
    );
    expect(
      decodeCodexAsyncQuestionReplies(
        `<send_user_message_question_reply>${JSON.stringify(replies[0])}</send_user_message_question_reply>`,
      ),
    ).toEqual(replies);
    for (const invalid of [
      "ordinary answer",
      `${encodeCodexAsyncQuestionReplies(replies)} extra`,
      "<send_user_message_question_reply>[]</send_user_message_question_reply>",
      '<send_user_message_question_reply>{"answer":true}</send_user_message_question_reply>',
    ])
      expect(decodeCodexAsyncQuestionReplies(invalid)).toBeNull();
  });
  test("projects structured answer content without losing its canonical envelope", () => {
    const replies = [{ questionItemId: "q", question: "Name?", answer: "Nodex" }];
    const text = encodeCodexAsyncQuestionReplies(replies);
    const views = projectCodexCanonicalTurnItemViews({
      threadId: "thread",
      turnId: "turn",
      observedAtMs: 1,
      turnStatus: "inProgress",
      items: [
        {
          type: "userMessage",
          id: "reply",
          clientId: null,
          content: [{ type: "text", text, text_elements: [] }],
        },
      ],
    });
    expect(views[0]?.questionReplies).toEqual(replies);
    expect(views[0]?.markdownText).toBe("**Name?**\nNodex");
    expect(views[0]?.rawItem).toMatchObject({ content: [{ type: "text", text }] });
  });
});
