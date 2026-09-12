import { describe, expect, test } from "vite-plus/test";
import {
  cleanCodexAutoTitlePrompt,
  normalizeCodexGeneratedThreadTitle,
  normalizeCodexManualThreadTitle,
  projectCodexMarkdownToPlainText,
  resolveCodexForkChildThreadTitle,
  resolveCodexForkChildThreadTitleFromCatalog,
  resolveCodexForkSourceConversationTitle,
  resolveCodexElectronDisplayThreadTitle,
} from "./codex-thread-title";

describe("cleanCodexAutoTitlePrompt", () => {
  test("keeps the text after the final Codex request marker", () => {
    expect(cleanCodexAutoTitlePrompt("Context\n## My request for Codex:\nShip title parity")).toBe(
      "Ship title parity",
    );
  });

  test("does not strip markdown links or agent config lines", () => {
    const prompt = '<agent-config mode="plan" />\nRead [docs](README.md)';
    expect(cleanCodexAutoTitlePrompt(prompt)).toBe(prompt);
  });

  test("truncates to 2000 characters", () => {
    expect(cleanCodexAutoTitlePrompt("x".repeat(2_500)).length).toBe(2_000);
  });
});

describe("normalizeCodexGeneratedThreadTitle", () => {
  test("normalizes generated titles like Codex Electron", () => {
    expect(normalizeCodexGeneratedThreadTitle("  x  ")).toBe("x");
    expect(normalizeCodexGeneratedThreadTitle('  title: "Fix flaky test."  ')).toBe(
      "Fix flaky test",
    );
    expect(normalizeCodexGeneratedThreadTitle("\n\n`Add new thread title!`\nignored")).toBe(
      "Add new thread title",
    );
  });

  test("returns null for empty generated titles", () => {
    expect(normalizeCodexGeneratedThreadTitle(" \n\t ")).toBe(null);
  });

  test("truncates generated titles to 36 characters", () => {
    expect(normalizeCodexGeneratedThreadTitle("x".repeat(37))).toBe(`${"x".repeat(35)}…`);
  });
});

describe("normalizeCodexManualThreadTitle", () => {
  test("trims and folds whitespace", () => {
    expect(normalizeCodexManualThreadTitle("  hello   world\nagain  ")).toBe("hello world again");
  });

  test("returns null for empty or whitespace-only titles", () => {
    expect(normalizeCodexManualThreadTitle("")).toBe(null);
    expect(normalizeCodexManualThreadTitle(" \t\n ")).toBe(null);
  });

  test("keeps a 60 character title unchanged", () => {
    const title = "x".repeat(60);
    expect(normalizeCodexManualThreadTitle(title)).toBe(title);
  });

  test("truncates over 60 characters with an ellipsis", () => {
    expect(normalizeCodexManualThreadTitle("x".repeat(61))).toBe(`${"x".repeat(59)}…`);
  });
});

describe("resolveCodexElectronDisplayThreadTitle", () => {
  test("prefers explicit thread names", () => {
    expect(
      resolveCodexElectronDisplayThreadTitle({
        threadName: "Generated title",
        threadPreview: "Preview",
        fallback: "New thread",
      }),
    ).toBe("Generated title");
  });

  test("derives fallback display titles from preview text", () => {
    expect(
      resolveCodexElectronDisplayThreadTitle({
        threadName: "",
        threadPreview: "x".repeat(61),
        fallback: "New thread",
      }),
    ).toBe(`${"x".repeat(59)}…`);
  });

  test("projects explicit and delegated preview Markdown before display", () => {
    expect(
      resolveCodexElectronDisplayThreadTitle({
        threadName: "**Generated** [title](https://example.com)",
        threadPreview: "ignored",
      }),
    ).toBe("Generated title");
    expect(
      resolveCodexElectronDisplayThreadTitle({
        threadPreview:
          "<codex_delegation><source_thread_id>root</source_thread_id><input>Context ## My request: **Fix** [tests](https://example.com)</input></codex_delegation>",
      }),
    ).toBe("Fix tests");
  });

  test("suppresses malformed delegation previews", () => {
    expect(
      resolveCodexElectronDisplayThreadTitle({
        threadPreview: "<codex_delegation>broken",
        fallback: "New thread",
      }),
    ).toBe("New thread");
  });

  test("uses fallback when no title source exists", () => {
    expect(
      resolveCodexElectronDisplayThreadTitle({
        threadName: "",
        threadPreview: "",
        fallback: "New thread",
      }),
    ).toBe("New thread");
  });
});

describe("projectCodexMarkdownToPlainText", () => {
  test("projects CommonMark blocks and inline markup like Codex Electron", () => {
    expect(
      projectCodexMarkdownToPlainText("> **Fix** [forks](https://example.com)\n\n- one\n- `two`"),
    ).toBe("Fix forks one two");
  });
});

describe("resolveCodexForkSourceConversationTitle", () => {
  test("keeps an explicit title untruncated after Markdown projection", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        explicitTitle: `**${"x".repeat(61)}**`,
      }),
    ).toBe("x".repeat(61));
  });

  test("preserves an explicit nonblank title that projects to empty text", () => {
    expect(resolveCodexForkSourceConversationTitle({ explicitTitle: "---" })).toBe("---");
  });

  test("derives and truncates the first user request after its context marker", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: `Ignored context\n## My request for Codex:\n# ${"x".repeat(61)}`,
            text_elements: [],
          },
        ],
      }),
    ).toBe(`${"x".repeat(59)}…`);
  });

  test("uses the first non-empty comment when the first turn has no user message", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: "",
            text_elements: [],
          },
        ],
        firstTurnCommentAttachments: [
          { content: [{ content_type: "text", text: "  " }] },
          { content: [{ content_type: "text", text: "**Prefer** [guards](https://example.com)" }] },
        ],
      }),
    ).toBe("Prefer guards");
  });

  test("parses a serialized comment when live comment attachments are absent", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "# Diff comments:",
              "",
              "## Comment 1",
              "File: src/app.ts",
              "Side: R",
              "Lines: 8",
              "Comment:",
              "**Prefer** a guard clause",
              "",
              "## My request for Codex:",
              "",
            ].join("\n"),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Prefer a guard clause");
  });

  test("projects heartbeat, delegation, goal, and appshot wrappers before title derivation", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: "<heartbeat><current_time_iso>now</current_time_iso><instructions>**Check** status</instructions></heartbeat>",
            text_elements: [],
          },
        ],
      }),
    ).toBe("Check status");
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: "<codex_delegation><source_thread_id>root</source_thread_id><input>Fix &lt;tests&gt;</input></codex_delegation>",
            text_elements: [],
          },
        ],
      }),
    ).toBe("Fix");
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [{ type: "text", text: "/goal **Ship** it", text_elements: [] }],
      }),
    ).toBe("Ship it");
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: '<appshot app="Safari" bundle-identifier="com.apple.Safari">ignored</appshot> **Keep** this',
            text_elements: [],
          },
        ],
      }),
    ).toBe("Keep this");
  });

  test("retains unrecognized appshot contents while removing HTML from the title", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: '<appshot app="Safari">ignored</appshot> **Keep** this',
            text_elements: [],
          },
        ],
      }),
    ).toBe("ignored Keep this");
  });

  test("uses full turn text to trigger appshot stripping for the selected request", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              '<appshot app="Safari" bundle-identifier="com.apple.Safari">context</appshot>',
              "## My request for Codex:",
              '<appshot app="Safari">request evidence</appshot> **Keep** this',
            ].join("\n"),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Keep this");
  });

  test("strips recognized appshots after heartbeat and delegation projection", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "<heartbeat>",
              "<current_time_iso>now</current_time_iso>",
              '<instructions><appshot app="Safari" bundle-identifier="com.apple.Safari">context</appshot> **Check** status</instructions>',
              "</heartbeat>",
            ].join(""),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Check status");
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "<codex_delegation>",
              "<source_thread_id>root</source_thread_id>",
              '<input><appshot app="Safari" bundle-identifier="com.apple.Safari">context</appshot> Fix tests</input>',
              "</codex_delegation>",
            ].join(""),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Fix tests");
  });

  test("removes exact comment-image labels and placeholder wrappers from the message", () => {
    const label =
      "The next image was attached by the user as additional visual context for Comment 1.";
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          { type: "text", text: "**Ship**", text_elements: [] },
          { type: "text", text: label, text_elements: [] },
          { type: "text", text: "<image>", text_elements: [] },
          { type: "image", url: "data:image/png;base64,fixture" },
          { type: "text", text: "</image>", text_elements: [] },
        ],
        firstTurnCommentAttachments: [
          {
            position: { line: 1 },
            content: [{ content_type: "text", text: "Image comment" }],
            localBrowserAttachedImages: [{ dataUrl: "data:image/png;base64,fixture" }],
          },
        ],
      }),
    ).toBe("Ship");
  });

  test("skips empty serialized comments and uses the next non-empty body", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "# Diff comments:",
              "",
              "## Comment 1",
              "File: src/app.ts",
              "Comment:",
              "  ",
              "## Comment 2",
              "File: src/app.ts",
              "Comment:",
              "Use the **second** comment",
              "",
              "## My request for Codex:",
              "",
            ].join("\n"),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Use the second comment");
  });

  test("skips response-annotation JSON before locating serialized comment context", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "",
              "# Response annotations:",
              "",
              "<response-annotations>",
              '{"text":"## My request for Codex:"}',
              "</response-annotations>",
              "# Diff comments:",
              "",
              "## Comment 1",
              "File: src/app.ts",
              "Comment:",
              "Later **comment**",
              "",
              "## My request for Codex:",
              "",
            ].join("\n"),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Later comment");
  });

  test("only treats a validated ambient-browser tail as a comment boundary", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "# Browser comments:",
              "",
              "## Comment 1",
              "File: browser:fixture",
              "Comment:",
              "Keep this heading",
              "# In app browser:",
              "not a valid browser tail",
              "",
              "## My request for Codex:",
              "",
            ].join("\n"),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Keep this heading In app browser: not a valid browser tail");
  });

  test("requires the exact structured suffix before ending a serialized comment section", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "# Diff comments:",
              "",
              "## Comment 1",
              "File: src/app.ts",
              "Comment:",
              "Keep this heading",
              "# Selected text:",
              "ordinary comment prose",
              "",
              "## My request for Codex:",
              "",
            ].join("\n"),
            text_elements: [],
          },
        ],
      }),
    ).toBe("Keep this heading Selected text: ordinary comment prose");
  });

  test("removes image-description text before serialized comment parsing", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [
          {
            type: "text",
            text: [
              "# Browser comments:",
              "",
              "## Comment 1",
              "File: browser:fixture",
              "Comment:",
              "The next image was attached by the user as additional visual context for Comment 1. **Real** body",
              "",
              "## My request for Codex:",
              "",
            ].join("\n"),
            text_elements: [],
          },
          { type: "image", url: "data:image/png;base64,fixture" },
        ],
      }),
    ).toBe("Real body");
  });

  test("does not derive comments without a text input item", () => {
    expect(
      resolveCodexForkSourceConversationTitle({
        firstTurnInput: [{ type: "image", url: "https://example.com/image.png" }],
        firstTurnCommentAttachments: [
          { content: [{ content_type: "text", text: "Do not use this" }] },
        ],
      }),
    ).toBe(null);
  });

  test("does not use a preview-like fallback when title sources are empty", () => {
    expect(resolveCodexForkSourceConversationTitle({})).toBe(null);
  });
});

describe("resolveCodexForkChildThreadTitle", () => {
  const thread = (
    conversationId: string,
    title: string | null,
    forkedFromId: string | null = null,
  ) => ({ conversationId, title, forkedFromId });

  test("returns null for untitled sources and starts titled lineages at two", () => {
    expect(resolveCodexForkChildThreadTitle(thread("untitled", null), [])).toBe(null);
    expect(resolveCodexForkChildThreadTitle(thread("root", "Task"), [])).toBe("Task (2)");
  });

  test("increments across descendants while ignoring unrelated same-name trees", () => {
    const root = thread("root", "Task");
    const known = [
      root,
      thread("child-2", "Task (2)", "root"),
      thread("child-3", "Task (3)", "root"),
      thread("unrelated", "Task (9)"),
    ];
    expect(resolveCodexForkChildThreadTitle(root, known)).toBe("Task (4)");
  });

  test("recovers the base lineage when forking an already suffixed child", () => {
    const root = thread("root", "Task");
    const child = thread("child-2", "Task (2)", "root");
    expect(
      resolveCodexForkChildThreadTitle(child, [root, child, thread("child-3", "Task (3)", "root")]),
    ).toBe("Task (4)");
  });

  test("fits the suffix and ellipsis inside the 60 character limit", () => {
    const title = resolveCodexForkChildThreadTitle(thread("root", "x".repeat(60)), []);
    expect(title?.length ?? 0).toBe(60);
    expect(title?.endsWith("… (2)") ?? false).toBe(true);
  });

  test("ignores archived summaries and reserves pending fork-worktree titles", () => {
    const root = thread("root", "Task");
    expect(
      resolveCodexForkChildThreadTitleFromCatalog({
        source: root,
        storedThreads: [root, { ...thread("archived-child", "Task (2)", "root"), archived: true }],
        activeThreads: [],
        pendingForks: [],
      }),
    ).toBe("Task (2)");
    expect(
      resolveCodexForkChildThreadTitleFromCatalog({
        source: root,
        storedThreads: [root],
        activeThreads: [],
        pendingForks: [thread("pending-child", "Task (2)", "root")],
      }),
    ).toBe("Task (3)");
    expect(
      resolveCodexForkChildThreadTitleFromCatalog({
        source: thread("root", "Stale title"),
        storedThreads: [root],
        activeThreads: [thread("root", "Current title")],
        pendingForks: [],
      }),
    ).toBe("Current title (2)");
  });
});
