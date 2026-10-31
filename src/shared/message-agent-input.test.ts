import { describe, expect, test } from "vite-plus/test";
import { classifyImageSource, resolveRelativeImagePath } from "./image-source";
import { readMarkdown } from "./nodex-markdown";
import {
  projectMessageBlocks,
  projectMessageText,
  readImagePlaceholders,
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
