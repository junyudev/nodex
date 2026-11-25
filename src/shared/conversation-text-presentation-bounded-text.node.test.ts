import { describe, expect, test, it } from "vite-plus/test";
import { appendTextTail } from "./bounded-text";
import { CHAT_REPLY_PREVIEW_LIMIT } from "./chat-reply-preview";
import { presentChatReplyPreview } from "./chat-reply-preview-text";
import { projectCodexMarkdownToPlainText as project } from "./codex-markdown-text";
import sourceCases from "./fixtures/codex-markdown-source-text.json";
import { stripCodexRemarkDirectiveLines } from "./codex-remark-directives";
import { prepareConversationMarkdownDisplay as prepare } from "./conversation-markdown-display";
import { toDesktopNotificationPlainText } from "./desktop-notification-text";
import { resolveCodexTurnNotificationBody } from "./codex-thread-notification";
import { parseCodexHeartbeatAssistantMessage } from "./codex-turn-notification";
import { classifyImageSource, resolveRelativeImagePath } from "./image-source";
import { readMarkdown } from "./nodex-markdown";
import {
  projectMessageBlocks,
  projectMessageText,
  projectPromptBlockForSend,
  readImagePlaceholders,
  removeImagePlaceholder,
} from "./message-agent-input";
import {
  composeMessageText,
  messageImageBlock,
  messageTextOf,
  parseMessageText,
  serializeMessageText,
  splitMessageContent,
} from "./message-content";
import { sideChatRequestTitle } from "./side-chat-title";
import { appendAgentAppContext, prepareAgentMessage } from "./agent-prompt";

describe("appendTextTail", () => {
  test("keeps input at the exact limit without reporting truncation", () => {
    expect(appendTextTail({ current: "ab", delta: "cde", maxChars: 5 })).toEqual({
      text: "abcde",
      didTruncate: false,
    });
  });

  test("keeps the newest JavaScript characters when the combined value is over the limit", () => {
    expect(appendTextTail({ current: "abcd", delta: "ef", maxChars: 5 })).toEqual({
      text: "bcdef",
      didTruncate: true,
    });
  });

  test("slices an oversized delta without first joining it to the current tail", () => {
    const current = {
      toString: () => {
        throw new Error("current should not be coerced when delta owns the complete tail");
      },
    } as unknown as string;

    expect(appendTextTail({ current, delta: "0123456789", maxChars: 4 })).toEqual({
      text: "6789",
      didTruncate: true,
    });
  });

  test("preserves prior truncation after later short deltas", () => {
    expect(
      appendTextTail({
        current: "345",
        delta: "6",
        maxChars: 5,
        didTruncate: true,
      }),
    ).toEqual({
      text: "3456",
      didTruncate: true,
    });
  });

  test("treats zero as a valid limit", () => {
    expect(appendTextTail({ current: "", delta: "x", maxChars: 0 })).toEqual({
      text: "",
      didTruncate: true,
    });
  });

  test("uses JavaScript UTF-16 offset semantics", () => {
    expect(appendTextTail({ current: "a", delta: "🧪", maxChars: 2 })).toEqual({
      text: "🧪",
      didTruncate: true,
    });
  });

  test.each([-1, 1.5, Number.NaN])("rejects invalid limit %s", (maxChars) => {
    expect(() => appendTextTail({ current: "", delta: "", maxChars })).toThrow(RangeError);
  });
});

describe("presentChatReplyPreview", () => {
  it("reads a reply's Markdown as one line of text", () => {
    expect(
      presentChatReplyPreview("## Done\n\n- Fixed **the race** in `sync.ts`\n- Added a test"),
    ).toBe("Done Fixed the race in sync.ts Added a test");
  });

  it("keeps no more of a long reply than a row can show", () => {
    const preview = presentChatReplyPreview("字".repeat(CHAT_REPLY_PREVIEW_LIMIT + 40));
    expect(Array.from(preview ?? "")).toHaveLength(CHAT_REPLY_PREVIEW_LIMIT);
  });

  it("has nothing to show for a reply without readable text", () => {
    expect(presentChatReplyPreview("   \n\n ")).toBeNull();
  });
});

describe("compact Markdown text", () => {
  it("separates words at explicit Markdown and HTML line breaks", () => {
    expect(project("First  \nSecond<br>Third<br />Fourth")).toBe("First Second Third Fourth");
  });
  it.each(sourceCases)("normalizes source text: $source", ({ source, text }) => {
    expect(project(source)).toBe(text);
  });
  it("projects GFM tables, tasks and strikethrough", () => {
    expect(project("| First | Second |\n| --- | --- |\n| ~~old~~ | new |\n\n- [x] done")).toBe(
      "First Second old new done",
    );
  });
  it("hides HTML scripts, styles and comments while retaining visible content", () => {
    expect(project("hello <script>secret **code**</script> world <!-- private -->")).toBe(
      "hello world",
    );
    expect(project("<div>Visible <style>body { color: red }</style> text</div>")).toBe(
      "Visible text",
    );
  });
  it("keeps directive labels and container content without attributes", () => {
    expect(project('::codex-followup[Continue]{prompt="private"}')).toBe("Continue");
    expect(project(':::writing{variant="email"}\nDear reader\n:::')).toBe("Dear reader");
  });
  it("treats non-ASCII or non-letter directive names as literal Markdown", () => {
    expect(project(':1x[label]{key="hidden"}')).toBe(':1x[label]{key="hidden"}');
    expect(project(':中文[label]{key="hidden"}')).toBe(':中文[label]{key="hidden"}');
    expect(project(':中文[**label**]{key="hidden"}')).toBe(':中文[label]{key="hidden"}');
  });
  it("retains literal directives in fenced code", () => {
    expect(project('```text\n::literal[value]{attribute="yes"}\n```')).toBe(
      '::literal[value]{attribute="yes"}',
    );
  });
  it("keeps the source-normalization fence boundary separate from body code semantics", () => {
    const literal = '::codex-inline-vis{file="literal.html"}';
    expect(project(`\`${literal}\``)).toBe(literal.slice(1));
    expect(project(`    ${literal}`)).toBe("");
    expect(project(`>     ${literal}`)).toBe(literal.slice(1));
    expect(project('   ::codex-inline-vis{file="real.html"}')).toBe("");
  });
  it("removes private citation payloads", () => {
    expect(project("Evidence \uE200cite\uE202private\uE201 found")).toBe("Evidence found");
  });
});

describe("codex remark directives", () => {
  test("strips standalone directive lines and normalizes spacing", () => {
    const value = [
      "Summary complete.",
      "",
      '::inbox-item{title="Ready" summary="Review it"}',
      "",
      "",
      "::archive-thread{}",
      "Next step is clear.",
    ].join("\n");

    expect(stripCodexRemarkDirectiveLines(value)).toBe("Summary complete.\n\nNext step is clear.");
  });

  test("keeps inline directive-looking text visible", () => {
    expect(stripCodexRemarkDirectiveLines('Done. ::inbox-item{title="Inline"}')).toBe(
      'Done. ::inbox-item{title="Inline"}',
    );
  });

  test("excludes executable indented directives while preserving indented code", () => {
    for (const indentation of ["", " ", "  ", "   "]) {
      expect(
        stripCodexRemarkDirectiveLines(
          `${indentation}::codex-inline-vis{file=plot.html}\nActual response`,
        ),
      ).toBe("Actual response");
    }
    expect(
      stripCodexRemarkDirectiveLines("    ::codex-inline-vis{file=literal.html}\nActual response"),
    ).toBe("    ::codex-inline-vis{file=literal.html}\nActual response");
  });
});

describe("conversation markdown display", () => {
  const options = { streaming: true, inlineVisualizations: true } as const;

  describe("assistant display preparation", () => {
    test.each([
      ['::codex-inline-vis{file="/chart.html" mode="wide"}', true],
      ['::codex-inline-vis{path="/chart.html" title="" expandable="false"}', true],
      ['::codex-inline-vis{file="/chart.html"\ttitle="A } ] title"}', true],
      ['::codex-inline-vis{mode="wide" file="/chart.html"}', true],
      ["::codex-inline-vis{file=/chart.html}", true],
      ['::codex-inline-vis{file=""}', true],
      ['::codex-inline-vis{file="/chart.html" title="unterminated}', false],
      ['::codex-inline-vis{file="/chart.html" unknown="true"}', true],
      ['::codex-inline-vis{file="/chart.html" mode="narrow"}', true],
    ] as const)("guards only the final visualization header: %s", (header, admitted) => {
      const canonical = "Complete prefix\n" + header;
      for (const streaming of [true, false]) {
        expect(prepare(canonical, { ...options, streaming }).source).toBe(
          admitted ? canonical : "Complete prefix\n",
        );
        // An empty final line and an explicit gate-off are separate caller contracts.
        expect(prepare(canonical + "\n", { ...options, streaming }).source).toBe(canonical + "\n");
        if (!streaming)
          expect(prepare(canonical, { streaming, inlineVisualizations: false }).source).toBe(
            canonical,
          );
      }
    });

    test("keeps an unknown declaration while removing only streaming hidden metadata", () => {
      expect(prepare('Before\n::unknown{file="unclosed', options).source).toBe(
        'Before\n::unknown{file="unclosed',
      );
      expect(prepare('Before\n::created-thread{threadId="id"}\nAfter', options).source).toBe(
        "Before\nAfter",
      );
      expect(prepare("Before\n::cre", options).source).toBe("Before");
      expect(
        prepare('Before\n::created-thread{threadId="id"}', { ...options, streaming: false }).source,
      ).toBe('Before\n::created-thread{threadId="id"}');
    });

    test.each([
      ["Hello [world", "Hello "],
      ["Hello [world](https://example.com", "Hello "],
      ["![image](https://example.com/x", ""],
      ["before **partial", "before **partial**"],
      ["before ***", "before ***"],
      ["before **partial*", "before **partial**"],
      ["before `partial", "before `partial"],
      ["- [ ]", "- [ ]"],
      ["before :codex-followup[pending", "before "],
      ['before :writing{title="unclosed', "before "],
      ['before :writing{title="Closed } ] title"}', 'before :writing{title="Closed } ] title"}'],
    ])("repairs only the displayed streaming tail: %j", (canonical, expected) => {
      expect(prepare(canonical, options).source).toBe(expected);
      expect(prepare(canonical, { ...options, streaming: false }).source).toBe(canonical);
    });

    test("preserves code payload, Unicode separators and open-fence state", () => {
      const payload =
        'alpha\n\n\n\nbeta\u2028gamma\u2029delta\u0085epsilon\n::unknown{file="literal"}';
      const source = `\`\`\`text\n${payload}\n\`\`\``;
      expect(prepare(source, options)).toEqual({ source, openCodeFence: false });
      expect(prepare(source, { ...options, streaming: false })).toEqual({
        source,
        openCodeFence: null,
      });
      const open = `\`\`\`text\n${payload}`;
      expect(prepare(open, options)).toEqual({ source: open, openCodeFence: true });
      expect(prepare(source.replaceAll("\n", "\r\n"), options).source).toBe(source);
    });

    test("separates real front metadata from setext without hiding its entries", () => {
      expect(prepare("---\ntitle: demo\n---\nbody", options).source).toBe(
        "---\ntitle: demo\n\n---\nbody",
      );
      for (const source of ["Name\n---", "---\nplain\n---\nbody", "---\ntitle: demo\nbody"])
        expect(prepare(source, options).source).toBe(source);
    });

    test("converts validated legacy declarations without touching a root code block", () => {
      const marker = "\uE200visualize\uE202chart.html\uE201";
      expect(prepare(marker, { ...options, streaming: false }).source).toBe(
        '::codex-inline-vis{file="chart.html"}',
      );
      const code = `\`\`\`text\n${marker}\n\`\`\``;
      expect(prepare(code, { ...options, streaming: false }).source).toBe(code);
      const invalid = "\uE200visualize\uE202../chart.html\uE201";
      expect(prepare(invalid, { ...options, streaming: false }).source).toBe(invalid);
    });
  });
});

describe("desktop notification plain text", () => {
  test("removes executable HTML, tags, markdown decoration, and line breaks", () => {
    expect(
      toDesktopNotificationPlainText(
        [
          "# **Done**",
          "<script>alert('secret')</script>",
          "<style>.hidden { color: red }</style>",
          "Read [the report](https://example.com) &amp; continue.<br>Now.",
        ].join("\n"),
      ),
    ).toBe("Done Read the report & continue. Now.");
  });

  test("decodes entities and retains the complete reply for native presentation", () => {
    expect(toDesktopNotificationPlainText("A &#x1f680; B &#67;")).toBe("A 🚀 B C");
    expect(toDesktopNotificationPlainText(null)).toBe("");
    const reply = "已完成 🚀 ".repeat(150).trim();
    expect(toDesktopNotificationPlainText(reply)).toBe(reply);
    expect(() => toDesktopNotificationPlainText("&#x110000;")).not.toThrow();
  });

  test.each(["reply", "heartbeat-message", "heartbeat-visible"])(
    "%s preserves fenced code and following content until native delivery",
    (source) => {
      const markdown = "## Result\n```ts\nconst value_name = 1;\n```\nAll checks passed.";
      const lastAgentMessage =
        source === "reply"
          ? markdown
          : source === "heartbeat-message"
            ? `<heartbeat><decision>NOTIFY</decision><message>${markdown}</message></heartbeat>`
            : `${markdown}\n<heartbeat><decision>NOTIFY</decision></heartbeat>`;
      const body = resolveCodexTurnNotificationBody({
        lastAgentMessage,
        heartbeatAssistantMessage: parseCodexHeartbeatAssistantMessage(lastAgentMessage),
      });
      expect(toDesktopNotificationPlainText(body)).toBe(
        "Result const value_name = 1; All checks passed.",
      );
    },
  );

  test("keeps readable links and code while omitting private citation and directive payloads", () => {
    expect(
      toDesktopNotificationPlainText(
        [
          "**Done.** Use `Map<Key, Value>` and `file_name`.",
          "Read [the report](https://example.com/report_(final)).",
          "Evidence \uE200cite\uE202private-source\uE201 checked.",
          '::codex-followup[Continue]{prompt="private prompt"}',
          '::codex-inline-vis{file="private.html"}',
        ].join("\n\n"),
      ),
    ).toBe("Done. Use Map<Key, Value> and file_name. Read the report. Evidence checked. Continue");
  });
});

describe("message agent input", () => {
  describe("a message as an Agent receives it", () => {
    test("serializes text, thread mentions, images, and agent configs", () => {
      const promptInput = projectMessageBlocks([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See ", styles: {} },
            { type: "threadMention", props: { uuid: "thread-123" } },
            { type: "text", text: " with mode ", styles: {} },
            {
              type: "agentConfig",
              props: {
                mode: "plan",
                provider: "openai",
                model: "gpt-5.2-codex",
                reasoning: "high",
                speed: "fast",
              },
            },
          ],
          children: [],
        },
        {
          type: "image",
          props: { url: "nodex://assets/image.png", caption: "Architecture sketch" },
          children: [],
        },
      ]);

      expect(promptInput.text).toBe(
        "See <nodex://sessions/thread-123> with mode&#x20;\n\n[Image #1] (caption: Architecture sketch)",
      );
      expect(promptInput.images).toEqual([
        { source: "nodex://assets/image.png", caption: "Architecture sketch" },
      ]);
      expect(promptInput.agentConfigs).toEqual([
        {
          mode: "plan",
          provider: "openai",
          model: "gpt-5.2-codex",
          reasoning: "high",
          speed: "fast",
        },
      ]);
    });

    test("numbers images in reading order and keeps a file's path for the Agent to act on", () => {
      const result = projectMessageBlocks([
        { type: "image", props: { url: "nodex://files/first", caption: "First" }, children: [] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "between", styles: {} }],
          children: [],
        },
        { type: "image", props: { url: "/tmp/second.png", caption: "Second" }, children: [] },
        { type: "image", props: { url: "file:///tmp/third.png" }, children: [] },
      ]);
      expect(result.text).toBe(
        "[Image #1] (caption: First)\n\nbetween\n\n[Image #2] (caption: Second; path: /tmp/second.png)\n\n[Image #3] (path: /tmp/third.png)",
      );
      expect(result.images?.map((image) => image.source)).toEqual([
        "nodex://files/first",
        "/tmp/second.png",
        "file:///tmp/third.png",
      ]);
    });

    test("a web image stays a link, since Nodex never fetches the web for an Agent", () => {
      const result = projectMessageText(
        "Badge ![build](https://img.shields.io/badge/build-passing-green) and ![shot](/tmp/shot.png)",
      );
      expect(result.text).toBe(
        "Badge ![build](https://img.shields.io/badge/build-passing-green) and [Image #1] (caption: shot; path: /tmp/shot.png)",
      );
      expect(result.images).toEqual([{ source: "/tmp/shot.png", caption: "shot" }]);
    });

    test("images in the text count after the images that travel ahead of it", () => {
      const result = projectMessageText("Compare with ![](nodex://files/later)", {
        precedingImageCount: 2,
      });
      expect(result.text).toBe("Compare with [Image #3]");
      expect(result.images).toEqual([{ source: "nodex://files/later" }]);
    });

    test("text with nothing to project reaches the Agent exactly as written", () => {
      const text = "* keep my bullet\n\nand  my spacing, ![badge](https://example.com/b.svg)";
      expect(projectMessageText(text)).toEqual({ text });
    });

    test("sends captionless image-only content", () => {
      const result = projectMessageBlocks([
        { type: "image", props: { url: "nodex://assets/photo.png", caption: "" }, children: [] },
      ]);
      expect(result.text).toBe("[Image #1]");
      expect(result.images).toEqual([{ source: "nodex://assets/photo.png" }]);
    });
  });

  describe("a Prompt as a chat receives it", () => {
    const prompt = {
      id: "prompt-root",
      type: "prompt",
      props: {
        sentSessionId: "deleted-session",
        sentMessageId: "prompt-message",
        sentAt: "2026-10-31T08:30:00.000Z",
      },
      content: [
        { type: "text", text: "Review ", styles: {} },
        { type: "text", text: "this change", styles: { bold: true } },
        { type: "inlineImage", props: { url: "nodex://files/first", alt: "First" } },
        { type: "agentConfig", props: { mode: "plan", model: "test-model" } },
      ],
      children: [
        {
          id: "nested",
          type: "prompt",
          content: [{ type: "text", text: "Boundary cases", styles: {} }],
          children: [{ type: "image", props: { url: "nodex://files/second", caption: "Second" } }],
        },
      ],
    };

    test("projects rich first lines and nested children without mutating the source", () => {
      const source = structuredClone(prompt);
      expect(projectPromptBlockForSend(prompt)).toEqual([
        { type: "paragraph", content: prompt.content },
        { type: "paragraph", content: prompt.children[0].content },
        { type: "image", props: { url: "nodex://files/second", caption: "Second" }, children: [] },
      ]);
      expect(prompt).toEqual(source);
    });

    test("sends Prompt content with images and Agent settings in reading order", () => {
      const result = projectMessageBlocks([
        {
          type: "callout",
          content: [{ type: "text", text: "Context", styles: {} }],
          children: [prompt],
        },
      ]);
      expect(result).toEqual({
        text: "> [!TIP]\n> Context\n>\n> Review **this change**[Image #1] (caption: First)\n>\n> Boundary cases\n>\n> [Image #2] (caption: Second)",
        images: [
          { source: "nodex://files/first", caption: "First" },
          { source: "nodex://files/second", caption: "Second" },
        ],
        agentConfigs: [{ mode: "plan", model: "test-model" }],
      });
    });

    test("keeps children sendable when the first line is empty", () => {
      expect(
        projectMessageBlocks([
          {
            type: "prompt",
            children: [
              { type: "paragraph", content: [{ type: "text", text: "Body", styles: {} }] },
            ],
          },
        ]).text,
      ).toBe("<br>\n\nBody");
    });
  });

  describe("a sent message read back", () => {
    test("shows each image where the Agent read its placeholder", () => {
      const { text } = projectMessageText(
        "See ![shot](</tmp/a (1).png>) and ![](nodex://files/b), then `[Image #9]` in code",
        { precedingImageCount: 1 },
      );
      const [paragraph] = readImagePlaceholders(readMarkdown(text));
      const content = paragraph?.content as { type: string; text?: string; props?: object }[];
      expect(content.map((item) => item.props ?? item.text)).toEqual([
        "See ",
        { number: 2, caption: "shot", path: "/tmp/a (1).png" },
        " and ",
        { number: 3, caption: "", path: null },
        ", then ",
        "[Image #9]",
        " in code",
      ]);
    });
  });

  describe("a message losing one of its images", () => {
    test("drops what named the image and moves later images up, so each still names its own", () => {
      const { text } = projectMessageText(
        "Compare ![shot](</tmp/a (1).png>) with ![](nodex://files/b)",
        {
          precedingImageCount: 1,
        },
      );
      expect(removeImagePlaceholder(text, 1)).toBe(
        "Compare [Image #1] (caption: shot; path: /tmp/a (1).png) with [Image #2]",
      );
      expect(removeImagePlaceholder(text, 2)).toBe("Compare with [Image #2]");
      expect(removeImagePlaceholder(text, 3)).toBe(
        "Compare [Image #2] (caption: shot; path: /tmp/a (1).png) with",
      );
    });

    test.each([
      [
        "a line of its own, and the blank line that set it apart",
        "One\n\n[Image #1]\n\nTwo",
        "One\n\nTwo",
      ],
      ["the opening of the message", "[Image #1]\n\nTwo", "Two"],
      ["the whole message", "[Image #1]", ""],
      ["the start of a line", "[Image #1] looks wrong", "looks wrong"],
      ["every mention of the image", "[Image #1] and again [Image #1]!", "and again!"],
      ["its details", "See [Image #1] (caption: a) now", "See now"],
    ])("takes %s", (_case, text, expected) => {
      expect(removeImagePlaceholder(text, 1)).toBe(expected);
    });

    test.each([
      ["inline code", "Type `[Image #1]` to refer to it"],
      ["a fenced block", "```\n[Image #1]\n```"],
      ["a longer fence that holds a shorter one", "````\n```\n[Image #1]\n```\n````"],
      ["no placeholder at all", "  Just words  "],
    ])("leaves %s exactly as written", (_case, text) => {
      expect(removeImagePlaceholder(text, 1)).toBe(text);
    });

    test("still renumbers after a fence closes, and an image another image follows", () => {
      expect(removeImagePlaceholder("```\n[Image #3]\n```\nSee [Image #3]", 1)).toBe(
        "```\n[Image #3]\n```\nSee [Image #2]",
      );
    });
  });

  describe("what an image's source names", () => {
    test("classifies each source form", () => {
      expect(classifyImageSource("nodex://files/abc")).toEqual({ kind: "file", fileId: "abc" });
      expect(classifyImageSource("nodex://assets/a.png").kind).toBe("asset");
      expect(classifyImageSource("data:image/png;base64,YQ==").kind).toBe("data");
      expect(classifyImageSource("/Users/me/a.png")).toEqual({
        kind: "path",
        path: "/Users/me/a.png",
      });
      expect(classifyImageSource("C:\\Users\\me\\a.png")).toEqual({
        kind: "path",
        path: "C:/Users/me/a.png",
      });
      expect(classifyImageSource("file://server/share/a.png")).toEqual({
        kind: "path",
        path: "//server/share/a.png",
      });
      expect(classifyImageSource("https://example.com/a.png").kind).toBe("web");
      expect(classifyImageSource("shots/a.png")).toEqual({ kind: "relative", path: "shots/a.png" });
      expect(classifyImageSource("javascript:alert(1)").kind).toBe("unsupported");
      expect(classifyImageSource("//cdn.example.com/a.png").kind).toBe("unsupported");
    });

    test("reads a relative path from the folder the content is read in", () => {
      expect(resolveRelativeImagePath("shots/a%20b.png", "/Users/me/app")).toBe(
        "/Users/me/app/shots/a b.png",
      );
      expect(resolveRelativeImagePath("../docs/./x.png", "/Users/me/app/")).toBe(
        "/Users/me/docs/x.png",
      );
      expect(resolveRelativeImagePath("assets\\x.png", "C:\\work\\app")).toBe(
        "C:/work/app/assets/x.png",
      );
      expect(resolveRelativeImagePath("../../../x.png", "/a")).toBeNull();
      expect(resolveRelativeImagePath("x.png", null)).toBeNull();
    });
  });

  test("projects skill atoms in Prompt and table content while leaving ordinary dollars and code intact", () => {
    const source =
      ':::prompt[Run(:skill{name="review"}).]\n  Cost $5 and use `:skill{name="code"}`.\n:::\n\n| Skills |\n| --- |\n| :skill{name="tools:other"} |';
    expect(projectMessageText(source).text).toBe(
      'Run( $review ).\n\nCost $5 and use `:skill{name="code"}`.\n\n| Skills |\n| --- |\n| $tools:other |',
    );
    expect(projectMessageText("Use $review, $5 and $HOME.").text).toBe(
      "Use $review, $5 and $HOME.",
    );
  });
});

describe("message content", () => {
  const image = (id: string) => `![](nodex://files/${id})`;
  const sources = (
    blocks: readonly { type: string; props?: Readonly<Record<string, unknown>> }[],
  ) => blocks.map((block) => block.props?.url ?? block.type);

  describe("message text", () => {
    it("reads back exactly as it was written", () => {
      for (const text of [
        "Settings buttons have **no labels**:\n\n- the gear\n  - in the toolbar\n- the close button",
        "First line\nsecond line\n\nA new paragraph with a < b and C:\\Users",
        "> quoted\n> twice\n\nThen see https://example.com/docs.",
        "| a | b |\n| - | - |\n| 1 | 2 |",
        "```ts\nconst a = 1;\n\nconst b = 2;\n```",
        "\\- not a list\n1\\. not a number either",
        "Plan:\n  first, the toolbar\n    then the dialogs\nDone.",
        "_italic_, `snake_case` and **注意：**这里",
      ]) {
        const written = serializeMessageText(parseMessageText(text));
        expect(written).not.toBeNull();
        expect(parseMessageText(written!)).toEqual(parseMessageText(text));
      }
    });

    it("writes a stored message back the way a person writes it", () => {
      expect(
        serializeMessageText(readMarkdown("one<br>two\nthree\n- [link](https://a.example/x)")),
      ).toBe("one\ntwo\nthree\n\n- [link](https://a.example/x)");
      expect(
        serializeMessageText(readMarkdown("[https://a.example/x](https://a.example/x) works")),
      ).toBe("https://a.example/x works");
    });

    it("edits every stored extension as exact Markdown source", () => {
      for (const text of [
        "one<br><br>two",
        ":span[underlined]{underline}",
        ":::toggle[Details]\n  Child\n:::",
      ]) {
        const blocks = readMarkdown(text, "exact");
        expect(readMarkdown(serializeMessageText(blocks), "exact")).toEqual(blocks);
      }
    });
  });

  describe("splitMessageContent", () => {
    it("reads the images before the text as its attachments, shown first", () => {
      const content = splitMessageContent(
        readMarkdown([image("a"), image("b"), "The banner is cut off", "- on hover"].join("\n\n")),
      );
      expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
      expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
      expect(content.attachmentsAt).toBe("start");
    });

    it("keeps the images of a message that ends with them where they are", () => {
      const content = splitMessageContent(
        readMarkdown(["The banner is cut off", "- on hover", image("a"), image("b")].join("\n\n")),
      );
      expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
      expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
      expect(content.attachmentsAt).toBe("end");
    });

    it("keeps an image between paragraphs in the text, in order", () => {
      const content = splitMessageContent(
        readMarkdown(["Before", image("a"), "After", image("b")].join("\n\n")),
      );
      expect(sources(content.text)).toEqual(["paragraph", "nodex://files/a", "paragraph"]);
      expect(sources(content.attachments)).toEqual(["nodex://files/b"]);
      // Only one run is the row: images at both ends leave the last ones in the text.
      const both = splitMessageContent(
        readMarkdown([image("a"), "Between", image("b")].join("\n\n")),
      );
      expect(sources(both.attachments)).toEqual(["nodex://files/a"]);
      expect(sources(both.text)).toEqual(["paragraph", "nodex://files/b"]);
    });

    it("drafts a prompt from the text alone, as written", () => {
      expect(
        messageTextOf(
          [image("a"), "**Ship** the changelog", "- tag it", "Keep a \\< b"].join("\n\n"),
        ),
      ).toBe("**Ship** the changelog\n\n- tag it\n\nKeep a < b");
    });

    it("writes a Composer's images and then its text, which read back as its attachments", () => {
      const body = composeMessageText("Settings are cut off\r\n- on hover\n\n", [
        messageImageBlock("a"),
        messageImageBlock("b"),
      ]);
      expect(body).toBe(
        "![](nodex://files/a)\n\n![](nodex://files/b)\n\nSettings are cut off\n- on hover",
      );
      const content = splitMessageContent(parseMessageText(body));
      expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
      expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
      expect(composeMessageText("  ", [messageImageBlock("a")])).toBe("![](nodex://files/a)");
    });
  });
});

describe("side chat title", () => {
  test("names a side chat from the last request body with Markdown and citations projected to prose", () => {
    expect(
      sideChatRequestTitle(
        "Context\n## My request:\nEarlier request\n## My request for Codex:\n  **Review** [this guide](https://example.com)\n\n and `report`\tresults citeturn0search0",
      ),
    ).toBe("Review this guide and report results");
  });

  test("removes only the exact leading page-comment context envelope before projecting its request", () => {
    const request = "**Inspect** this\n## My request:\nliteral request heading";
    expect(
      sideChatRequestTitle(
        `<page-comment-context>\nPage evidence\n</page-comment-context>\n## My request:\n${request}`,
      ),
    ).toBe("Inspect this My request: literal request heading");
    expect(
      sideChatRequestTitle("<page-comment-context>authored prose</page-comment-context>"),
    ).toBe("authored prose");
  });

  test("leaves an empty request untitled and preserves long display labels without a character cap", () => {
    expect(sideChatRequestTitle("Context\n## My request:\n \t")).toBeNull();
    expect(sideChatRequestTitle("<!-- invisible comment -->")).toBeNull();
    const request = "Detailed request ".repeat(200).trim();
    expect(sideChatRequestTitle(request)).toBe(request);
  });

  test("names a compiled request from its authored text without attached selections or app context", async () => {
    const compile = (text: string) =>
      prepareAgentMessage(
        text,
        { text, selectedTextAttachments: [{ id: "selection", text: "Inherited evidence" }] },
        async () => "",
      );
    const selected = await compile("**Inspect** the request");
    const message = appendAgentAppContext(
      selected,
      [{ text: "Interactive response state" }],
      "App context",
    );
    expect(sideChatRequestTitle(message.text)).toBe("Inspect the request");
    expect(sideChatRequestTitle((await compile("")).text)).toBeNull();
  });
});
