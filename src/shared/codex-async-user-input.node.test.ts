import { describe, expect, test } from "vite-plus/test";
import {
  decodeCodexAsyncQuestionReplies,
  encodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
  resolveCodexAsyncQuestionResponse,
  readCodexAsyncQuestionReplies,
  collectCodexAsyncQuestionAnswers,
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
  test("answers a terminal source question without trusting client-supplied wording", () => {
    const source = { turnId: "old-turn", status: "interrupted", items: [question] };
    expect(
      resolveCodexAsyncQuestionResponse([source], {
        sourceTurnIds: ["old-turn"],
        replies: [
          {
            questionItemId: '["request_user_input_async","ask",1]',
            question: "Client wording",
            answer: " Release ",
          },
        ],
      }),
    ).toEqual([
      {
        questionItemId: '["request_user_input_async","ask",1]',
        question: "Name?",
        answer: "Release",
      },
    ]);
  });

  test.each(["another-turn", "missing-turn"])(
    "rejects a question attributed to %s",
    (sourceTurnId) => {
      expect(() =>
        resolveCodexAsyncQuestionResponse(
          [
            { turnId: "old-turn", items: [question] },
            { turnId: "another-turn", items: [] },
          ],
          {
            sourceTurnIds: [sourceTurnId],
            replies: [
              {
                questionItemId: '["request_user_input_async","ask",0]',
                question: "Where?",
                answer: "Here",
              },
            ],
          },
        ),
      ).toThrow();
    },
  );

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
  test("recognizes an attached answer in both transcript folding and question state", () => {
    const replies = [
      {
        questionItemId: '["request_user_input_async","ask",0]',
        question: "Where?",
        answer: "Here",
      },
    ];
    const response: Extract<CodexCanonicalItem, { type: "userMessage" }> = {
      type: "userMessage",
      id: "reply-with-image",
      clientId: "answer-batch",
      content: [
        { type: "text", text: encodeCodexAsyncQuestionReplies(replies), text_elements: [] },
        { type: "localImage", path: "/workspace/reference.png" },
      ],
    };
    expect(readCodexAsyncQuestionReplies(response)).toEqual(replies);
    expect(collectCodexAsyncQuestionAnswers([question, response])).toEqual(
      new Map([[replies[0]!.questionItemId, "Here"]]),
    );
    const ordinary = {
      ...response,
      content: [
        ...response.content,
        { type: "text" as const, text: "Also consider this", text_elements: [] },
      ],
    };
    expect(readCodexAsyncQuestionReplies(ordinary)).toBeNull();
    expect(collectCodexAsyncQuestionAnswers([question, ordinary])).toEqual(new Map());
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
    const replies = [
      {
        questionItemId: "q",
        question: "**Name** [this](https://example.com)?",
        answer: "Nodex",
      },
    ];
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
    expect(views[0]?.markdownText).toBe("**Name this?**\nNodex");
    expect(views[0]?.rawItem).toMatchObject({ content: [{ type: "text", text }] });
  });
});
