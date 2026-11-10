import { describe, expect, test } from "vite-plus/test";
import { classifyImageSource, resolveRelativeImagePath } from "./image-source";
import { readMarkdown } from "./nodex-markdown";
import {
  projectMessageBlocks,
  projectMessageText,
  projectPromptBlockForSend,
  readImagePlaceholders,
  removeImagePlaceholder,
} from "./message-agent-input";

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
      { type: "paragraph", content: [{ type: "text", text: "between", styles: {} }], children: [] },
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
          children: [{ type: "paragraph", content: [{ type: "text", text: "Body", styles: {} }] }],
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
  expect(projectMessageText("Use $review, $5 and $HOME.").text).toBe("Use $review, $5 and $HOME.");
});
