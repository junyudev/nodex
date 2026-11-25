import { describe, expect, test, vi } from "vite-plus/test";
import type { AgentMessageDisplay } from "@nodex/codex-app-server-protocol/v2";
import {
  codexAnswerModerationNotice,
  codexAnswerModerationText,
  codexAnswerModerationWithholdsText,
  codexReadableAnswerText,
} from "./codex-answer-moderation";
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
import { cappedApproximateValueBytes } from "./codex-bounded-value-size";
import {
  buildCodexGrantedPermissionProfile,
  buildCodexPermissionRequestDetails,
  formatCodexPermissionPath,
  resolveCodexPermissionRequestTitleModel,
} from "./codex-permission-request";
import {
  collectCodexPromptAgentConfigs,
  prepareCodexPrompt,
  splitCodexPromptAgentConfigLines,
} from "./codex-prompt-preparation";
import { codexImageInputSource } from "./codex-image-input";

describe("codex answer moderation", () => {
  const moderated = (display: AgentMessageDisplay | null) => ({ moderated: true, display });

  describe("codex answer moderation", () => {
    test.each([
      { name: "no verdict", moderation: null, notice: null, withholds: false },
      {
        name: "an unmoderated verdict",
        moderation: { moderated: false, display: null },
        notice: null,
        withholds: false,
      },
      {
        name: "a plain show",
        moderation: moderated({ mode: "show", version: 1, trustedContacts: "skip" }),
        notice: null,
        withholds: false,
      },
      {
        name: "a show with a helpline",
        moderation: moderated({
          mode: "show",
          version: 1,
          trustedContacts: "check",
          annotation: { kind: "wellbeingHelpline", subject: "answer" },
        }),
        notice: { kind: "helpline" },
        withholds: false,
      },
      {
        name: "a hide",
        moderation: moderated({
          mode: "hide",
          version: 1,
          replacement: { kind: "wellbeingPromptHelpline" },
        }),
        notice: { kind: "withheld" },
        withholds: true,
      },
      {
        name: "a cyber block",
        moderation: moderated({ mode: "block", version: 1, reason: { kind: "cyber" } }),
        notice: { kind: "blocked", reason: "cyber" },
        withholds: true,
      },
      {
        name: "a protection block",
        moderation: moderated({
          mode: "block",
          version: 1,
          reason: { kind: "protection", protectionType: "fixture" },
        }),
        notice: { kind: "blocked", reason: "protection" },
        withholds: true,
      },
    ])("presents $name", ({ moderation, notice, withholds }) => {
      const presented = codexAnswerModerationNotice(moderation);
      expect(presented).toEqual(notice);
      expect(codexAnswerModerationWithholdsText(presented)).toBe(withholds);
      const readable = codexReadableAnswerText({ text: "the answer", moderation });
      expect(readable).toBe(
        withholds && presented ? codexAnswerModerationText(presented) : "the answer",
      );
    });
  });
});

describe("codex async user input", () => {
  const question: CodexCanonicalItem = {
    type: "agentMessage",
    moderation: null,
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

  test("keeps accepted answer attribution through echoes and history hydration", async () => {
    const { conversationFixture, turnFixture } =
      await import("../main/codex-application/conversation-test-fixture");
    const { collectCodexAsyncQuestionAnswerRecords } = await import("./codex-async-user-input");
    const { mergeCodexCanonicalTurnState } =
      await import("./codex-conversation-state/codex-conversation-state");
    const state = conversationFixture("thread", [turnFixture("source"), turnFixture("reply")]);
    const source = { ...state.turns[0]!, items: [question] };
    const questionId = expandCodexAsyncQuestions(question)[0]!.id;
    const input = [
      {
        type: "text" as const,
        text: encodeCodexAsyncQuestionReplies([
          { questionItemId: questionId, question: "Where?", answer: "There" },
        ]),
        text_elements: [],
      },
    ];
    const questionResponse = {
      operationId: "operation",
      respondedBy: { kind: "agent" as const, senderThreadId: "sender", senderSessionId: null },
    };
    const reply = {
      ...state.turns[1]!,
      params: {
        ...state.turns[1]!.params,
        clientUserMessageId: "submission",
        input,
        questionResponse,
      },
      items: [{ type: "userMessage" as const, id: "echo", clientId: "submission", content: input }],
    };
    const hydrated = mergeCodexCanonicalTurnState(reply, {
      ...reply,
      params: { ...state.turns[1]!.params, input },
    });
    const records = collectCodexAsyncQuestionAnswerRecords(
      JSON.parse(JSON.stringify([source, hydrated])),
    );
    expect(records.get(questionId)).toEqual({
      answer: "There",
      submissionId: "submission",
      ...questionResponse,
    });
    const steering: import("./codex-conversation-state/codex-conversation-state").CodexCanonicalSteeringUserMessageItem =
      {
        type: "steeringUserMessage",
        id: "steer",
        targetTurnId: "source",
        targetTurnStartedAtMs: null,
        status: "pending",
        clientUserMessageId: "steer-submission",
        input,
        attachments: [],
        compareKey: { rawText: "", imageCount: 0 },
        restoreMessage: { questionResponse, context: { commentAttachments: [] } },
      };
    const steered = { ...source, items: [question, steering] };
    expect(collectCodexAsyncQuestionAnswerRecords([steered])).toEqual(new Map());
    const accepted = {
      ...steered,
      items: [
        question,
        { ...steering, status: "accepted" as const, serverUserMessageId: "echo" },
        { type: "userMessage" as const, id: "echo", clientId: "steer-submission", content: input },
      ],
    };
    expect(collectCodexAsyncQuestionAnswerRecords([accepted]).get(questionId)?.respondedBy).toEqual(
      questionResponse.respondedBy,
    );
  });
});

describe("capped protocol value sizing", () => {
  test("short-circuits giant strings and sparse arrays at the requested budget", () => {
    const limit = 128;

    expect(cappedApproximateValueBytes("x".repeat(limit), limit)).toBe(limit + 1);
    expect(cappedApproximateValueBytes(new Array<unknown>(1_000_000), limit)).toBe(limit + 1);
  });

  test("counts shared or cyclic structures once without allocating a serialization", () => {
    const shared = { text: "small" };
    const cycle: { readonly shared: typeof shared; self?: unknown } = { shared };
    cycle.self = cycle;

    expect(cappedApproximateValueBytes(cycle, 1_024)).toBeLessThanOrEqual(1_024);
  });
});

describe("codex permission request helpers", () => {
  test("normalizes network and legacy filesystem permissions into display details", () => {
    const details = buildCodexPermissionRequestDetails({
      network: { enabled: true },
      fileSystem: {
        read: ["/repo", "/repo/shared"],
        write: ["/repo", "/tmp/out"],
      },
    });

    expect(JSON.stringify(details)).toBe(
      JSON.stringify([
        { kind: "network" },
        { kind: "fileSystem", access: "readWrite", paths: ["/repo"] },
        { kind: "fileSystem", access: "read", paths: ["/repo/shared"] },
        { kind: "fileSystem", access: "write", paths: ["/tmp/out"] },
      ]),
    );
  });

  test("uses entries as the canonical filesystem source and ignores deny entries", () => {
    const details = buildCodexPermissionRequestDetails({
      network: null,
      fileSystem: {
        read: ["/legacy"],
        write: ["/legacy"],
        entries: [
          { path: { type: "path", path: "/repo" }, access: "read" },
          { path: { type: "path", path: "/repo" }, access: "write" },
          { path: { type: "glob_pattern", pattern: "/repo/**/*.ts" }, access: "read" },
          { path: { type: "path", path: "/secret" }, access: "deny" },
        ],
      },
    });

    expect(JSON.stringify(details)).toBe(
      JSON.stringify([
        { kind: "fileSystem", access: "readWrite", paths: ["/repo"] },
        { kind: "fileSystem", access: "read", paths: ["/repo/**/*.ts"] },
      ]),
    );
  });

  test("formats special filesystem paths the same way as the reference model", () => {
    expect(formatCodexPermissionPath({ type: "special", value: { kind: "root" } })).toBe("/");
    expect(formatCodexPermissionPath({ type: "special", value: { kind: "minimal" } })).toBe(
      ":minimal",
    );
    expect(
      formatCodexPermissionPath({
        type: "special",
        value: { kind: "project_roots", subpath: null },
      }),
    ).toBe(":project_roots");
    expect(
      formatCodexPermissionPath({
        type: "special",
        value: { kind: "project_roots", subpath: "src" },
      }),
    ).toBe(":project_roots/src");
    expect(formatCodexPermissionPath({ type: "special", value: { kind: "tmpdir" } })).toBe(
      ":tmpdir",
    );
    expect(formatCodexPermissionPath({ type: "special", value: { kind: "slash_tmp" } })).toBe(
      "/tmp",
    );
    expect(
      formatCodexPermissionPath({
        type: "special",
        value: { kind: "unknown", path: "/var", subpath: "log" },
      }),
    ).toBe("/var/log");
  });

  test("resolves single-detail titles and granted permission responses", () => {
    expect(JSON.stringify(resolveCodexPermissionRequestTitleModel([{ kind: "network" }]))).toBe(
      JSON.stringify({ kind: "network" }),
    );
    expect(
      JSON.stringify(
        resolveCodexPermissionRequestTitleModel([
          {
            kind: "fileSystem",
            access: "write",
            paths: ["/repo/out"],
          },
        ]),
      ),
    ).toBe(JSON.stringify({ kind: "fileSystem", access: "write", path: "/repo/out" }));
    expect(
      JSON.stringify(
        resolveCodexPermissionRequestTitleModel([
          { kind: "network" },
          { kind: "fileSystem", access: "read", paths: ["/repo"] },
        ]),
      ),
    ).toBe(JSON.stringify({ kind: "additional" }));

    expect(
      JSON.stringify(
        buildCodexGrantedPermissionProfile({
          network: null,
          fileSystem: {
            read: ["/repo"],
            write: null,
          },
        }),
      ),
    ).toBe(
      JSON.stringify({
        fileSystem: {
          read: ["/repo"],
          write: null,
        },
      }),
    );
  });
});

describe("Codex prompt preparation", () => {
  test("preserves hosted image identity through reconstructed queued prompts", async () => {
    const source = codexImageInputSource({ type: "image", fileId: "file-123" });
    const resolveImageInput = vi.fn(() => {
      throw new Error("Hosted images must not resolve as local files");
    });
    const prepared = await prepareCodexPrompt(
      "Inspect",
      { text: "Inspect", images: [{ source }] },
      { resolveImageInput },
    );
    expect(prepared.inputItems.filter((input) => input.type === "image")).toEqual([
      { type: "image", fileId: "file-123" },
    ]);
    expect(resolveImageInput).not.toHaveBeenCalled();
  });

  test("keeps pasted text as a bounded sidecar until the main command boundary", async () => {
    const resolveImageInput = vi.fn(async (source: string) => ({
      type: "localImage" as const,
      path: `/resolved/${source.split("/").at(-1)}`,
    }));
    const prepared = await prepareCodexPrompt(
      "ignored fallback",
      {
        text: "ship the fix",
        textAttachments: [{ text: "pasted context" }],
        fileAttachments: [
          {
            label: "store.ts",
            path: "src/store.ts",
            fsPath: "/workspace/src/store.ts",
          },
        ],
        addedFiles: [
          {
            label: "store.ts duplicate",
            path: "src/store.ts",
            fsPath: "/workspace/src/store.ts",
          },
        ],
        images: [{ source: "nodex://assets/diagram.png" }],
        mentions: [
          {
            name: "Browser",
            path: "plugin://browser@openai-bundled",
          },
        ],
        skills: [{ name: "feature-dev", path: "/skills/feature-dev" }],
        commentAttachments: [
          {
            id: "comment-1",
            type: "comment",
            content: [{ content_type: "text", text: "Keep the identity stable" }],
            position: { side: "right", path: "src/store.ts", line: 42 },
            createdAt: 1,
          },
        ],
        browserAnnotationAttachments: [
          {
            schemaVersion: 1,
            id: "browser-comment-1",
            browserTabId: "browser-tab-1",
            createdAt: 2,
            note: "Make this action more prominent",
            pageTitle: "Checkout",
            pageUrl: "https://example.com/checkout",
            anchors: [
              {
                id: "anchor-1",
                kind: "element",
                pageUrl: "https://example.com/checkout",
                selector: "main > button",
                rect: { x: 40, y: 80, width: 120, height: 32 },
              },
            ],
            evidence: {
              attachmentId: "browser-evidence.png",
              source: "nodex://assets/browser-evidence.png",
              mimeType: "image/png",
              width: 168,
              height: 80,
            },
          },
        ],
      },
      { resolveImageInput },
    );

    expect(resolveImageInput).toHaveBeenCalledWith("nodex://assets/diagram.png");
    expect(resolveImageInput).toHaveBeenCalledWith("nodex://assets/browser-evidence.png");
    expect(prepared.inputItems.map((item) => item.type)).toEqual([
      "text",
      "text",
      "text",
      "localImage",
      "localImage",
      "mention",
      "mention",
      "skill",
    ]);
    expect(prepared.inputItems.filter((item) => item.type === "mention")).toEqual([
      {
        type: "mention",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
      },
      {
        type: "mention",
        name: "store.ts",
        path: "src/store.ts",
      },
    ]);
    expect(prepared.additionalContext?.["review-diff-comments"]?.kind).toBe("application");
    expect(prepared.additionalContext?.["browser-annotations"]?.kind).toBe("application");
    expect(prepared.pendingInputItems.map((item) => item.type)).toEqual([
      "text",
      "text",
      "text",
      "localImage",
      "localImage",
      "mention",
      "skill",
    ]);
    expect(prepared.pendingInputItems.find((item) => item.type === "mention")).toEqual({
      type: "mention",
      name: "Browser",
      path: "plugin://browser@openai-bundled",
    });
    expect(prepared.pastedTextAttachments).toEqual([{ text: "pasted context" }]);
  });

  test("extracts inline agent config without sending it as prompt text", () => {
    const parsed = splitCodexPromptAgentConfigLines(
      'Investigate the owner path\n\n:agent-config{mode="plan" provider="openai" model="gpt-test" reasoning="high" speed="fast"}',
    );

    expect(parsed.text).toBe("Investigate the owner path");
    expect(parsed.agentConfigs).toEqual([
      {
        mode: "plan",
        provider: "openai",
        model: "gpt-test",
        reasoning: "high",
        speed: "fast",
      },
    ]);
  });

  test("collects structured Agent config sidecars without scanning fallback text", () => {
    const structured = [{ provider: "anthropic", model: "claude-sonnet" }];
    expect(
      collectCodexPromptAgentConfigs(':agent-config{provider="openai"}', {
        text: "Do the work",
        agentConfigs: structured,
      }),
    ).toEqual(structured);
    expect(
      collectCodexPromptAgentConfigs(':agent-config{provider="openai" speed="fast"}', undefined),
    ).toEqual([{ provider: "openai", speed: "fast" }]);
  });

  test("keeps app and chat mentions structured in both live and pending input", async () => {
    const prepared = await prepareCodexPrompt(
      "",
      {
        text: "",
        mentions: [
          {
            name: "plugin-management",
            path: "app://plugin-management",
          },
          {
            name: "Browser parity",
            path: "thread://thread-1",
          },
        ],
      },
      {
        resolveImageInput: vi.fn(async () => ({
          type: "localImage" as const,
          path: "/unused",
        })),
      },
    );

    expect(prepared.inputItems).toEqual([
      {
        type: "mention",
        name: "plugin-management",
        path: "app://plugin-management",
      },
      {
        type: "mention",
        name: "Browser parity",
        path: "thread://thread-1",
      },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.fileAttachments).toEqual([]);
  });

  test("attaches Appshot pixels and application context as one prompt unit", async () => {
    const resolveImageInput = vi.fn(async (source: string) => ({
      type: "localImage" as const,
      path:
        source === "data:image/png;base64,YXBwc2hvdA=="
          ? "/resolved/Safari Appshot.png"
          : "/resolved/other.png",
    }));
    const prepared = await prepareCodexPrompt(
      "",
      {
        text: "Inspect the current app",
        appshots: [
          {
            id: "appshot-1",
            appName: "Safari & Preview",
            bundleIdentifier: "com.apple.Safari",
            windowTitle: 'Plans <2026> "final"',
            axTree: "AXWindow\n  AXButton title=<Continue & save>",
            imageName: "Safari Appshot.png",
            imageDataUrl: "data:image/png;base64,YXBwc2hvdA==",
            appIconDataUrl: null,
          },
        ],
      },
      { resolveImageInput },
    );

    expect(resolveImageInput).toHaveBeenCalledTimes(1);
    expect(resolveImageInput).toHaveBeenCalledWith("data:image/png;base64,YXBwc2hvdA==");
    expect(prepared.inputItems).toEqual([
      {
        type: "text",
        text: "Inspect the current app",
        text_elements: [],
      },
      {
        type: "localImage",
        path: "/resolved/Safari Appshot.png",
      },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.additionalContext?.appshots).toEqual({
      kind: "application",
      value: [
        "# Applications mentioned by the user:",
        "",
        '<appshot app="Safari &amp; Preview" bundle-identifier="com.apple.Safari" window-title="Plans &lt;2026&gt; &quot;final&quot;" image="Safari Appshot.png">',
        "AXWindow",
        "  AXButton title=&lt;Continue &amp; save&gt;",
        "</appshot>",
      ].join("\n"),
    });
  });

  test("preserves composer document order without demoting file mentions", async () => {
    const prepared = await prepareCodexPrompt(
      "",
      {
        text: "Open  before using ",
        documentItems: [
          {
            type: "text",
            text: "Open ",
          },
          {
            type: "mention",
            name: "notes.md",
            path: "docs/notes.md",
          },
          {
            type: "text",
            text: " before using ",
          },
          {
            type: "skill",
            name: "PDF",
            path: "/skills/pdf/SKILL.md",
          },
        ],
        mentions: [
          {
            name: "notes.md",
            path: "docs/notes.md",
          },
        ],
        skills: [
          {
            name: "PDF",
            path: "/skills/pdf/SKILL.md",
          },
        ],
      },
      {
        resolveImageInput: vi.fn(async () => ({
          type: "localImage" as const,
          path: "/unused",
        })),
      },
    );

    expect(prepared.inputItems).toEqual([
      {
        type: "text",
        text: "Open ",
        text_elements: [],
      },
      {
        type: "mention",
        name: "notes.md",
        path: "docs/notes.md",
      },
      {
        type: "text",
        text: " before using ",
        text_elements: [],
      },
      {
        type: "skill",
        name: "PDF",
        path: "/skills/pdf/SKILL.md",
      },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.fileAttachments).toEqual([]);
  });
});
