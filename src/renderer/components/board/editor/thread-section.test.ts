import { describe, expect, test } from "vite-plus/test";
import {
  buildThreadSectionPromptInput,
  deriveThreadSectionPromptBlocks,
  resolveShortcutBlockId,
  resolveThreadSectionForBlock,
  resolveThreadSectionSendPlan,
  resolveThreadSections,
  resolveTopLevelBlockId,
  serializeThreadSectionPrompt,
  type ThreadSectionBlockLike,
} from "./thread-section";

function createBlock(
  block: Partial<ThreadSectionBlockLike> & { id: string; type: string },
): ThreadSectionBlockLike {
  return {
    props: {},
    children: [],
    ...block,
  };
}

function createEditor(blocks: ThreadSectionBlockLike[]) {
  const parentById = new Map<string, { id: string }>();

  const walk = (nodes: ThreadSectionBlockLike[], parent?: ThreadSectionBlockLike) => {
    for (const node of nodes) {
      if (parent && typeof node.id === "string") {
        parentById.set(node.id, { id: parent.id as string });
      }
      walk(node.children ?? [], node);
    }
  };

  walk(blocks);

  return {
    getSelection: () => ({ blocks: [{ id: "child-1" }] }),
    getTextCursorPosition: () => ({ block: { id: "child-1", type: "paragraph" } }),
    getParentBlock: (id: string) => parentById.get(id),
  };
}

describe("thread-section helpers", () => {
  test("groups top-level blocks between thread-section markers", () => {
    const blocks = [
      createBlock({
        id: "section-1",
        type: "threadSection",
        props: { label: "First", threadId: "thr-1" },
      }),
      createBlock({
        id: "body-1",
        type: "paragraph",
        content: [{ type: "text", text: "alpha", styles: {} }],
      }),
      createBlock({
        id: "body-2",
        type: "paragraph",
        content: [{ type: "text", text: "beta", styles: {} }],
      }),
      createBlock({ id: "section-2", type: "threadSection", props: { label: "", threadId: "" } }),
      createBlock({
        id: "body-3",
        type: "paragraph",
        content: [{ type: "text", text: "gamma", styles: {} }],
      }),
    ];

    const sections = resolveThreadSections(blocks);

    expect(sections.length).toBe(2);
    expect(sections[0]?.markerBlockId).toBe("section-1");
    expect(JSON.stringify(sections[0]?.bodyBlockIds)).toBe(JSON.stringify(["body-1", "body-2"]));
    expect(sections[1]?.markerBlockId).toBe("section-2");
    expect(JSON.stringify(sections[1]?.bodyBlockIds)).toBe(JSON.stringify(["body-3"]));
  });

  test("resolves current section from a top-level body block", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection", props: { label: "First" } }),
      createBlock({
        id: "body-1",
        type: "paragraph",
        content: [{ type: "text", text: "alpha", styles: {} }],
      }),
      createBlock({ id: "section-2", type: "threadSection", props: { label: "Second" } }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "body-1");

    expect(section?.markerBlockId).toBe("section-1");
    expect(section?.label).toBe("First");
  });

  test("resolves a nested child thread section from following sibling content", () => {
    const blocks = [
      createBlock({
        id: "parent-1",
        type: "toggleListItem",
        children: [
          createBlock({ id: "intro", type: "paragraph" }),
          createBlock({ id: "section-1", type: "threadSection", props: { label: "Nested" } }),
          createBlock({
            id: "body-1",
            type: "paragraph",
            children: [createBlock({ id: "body-1-child", type: "paragraph" })],
          }),
          createBlock({ id: "body-2", type: "paragraph" }),
          createBlock({ id: "section-2", type: "threadSection", props: { label: "Next" } }),
          createBlock({ id: "body-3", type: "paragraph" }),
        ],
      }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "body-1-child");

    expect(section?.markerBlockId).toBe("section-1");
    expect(JSON.stringify(section?.bodyBlockIds)).toBe(JSON.stringify(["body-1", "body-2"]));
    expect(section?.label).toBe("Nested");
  });

  test("uses only the marker's following sibling range for the prompt", () => {
    const blocks = [
      createBlock({
        id: "section-1",
        type: "threadSection",
        children: [
          createBlock({ id: "child-1", type: "paragraph" }),
          createBlock({ id: "child-2", type: "paragraph" }),
        ],
      }),
      createBlock({ id: "lol", type: "paragraph" }),
      createBlock({ id: "lalala", type: "paragraph" }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "lol");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];

    expect(JSON.stringify(promptBlocks.map((block) => block.id))).toBe(
      JSON.stringify(["lol", "lalala"]),
    );
  });

  test("excludes nested child thread sections from an ancestor section prompt", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({
        id: "hello",
        type: "paragraph",
        children: [
          createBlock({ id: "section-2", type: "threadSection" }),
          createBlock({ id: "hi", type: "paragraph" }),
        ],
      }),
      createBlock({ id: "aaa", type: "paragraph" }),
      createBlock({ id: "asd", type: "paragraph" }),
      createBlock({ id: "asdasd", type: "paragraph" }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "asd");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];
    const helloBlock = promptBlocks[0];

    expect(JSON.stringify(promptBlocks.map((block) => block.id))).toBe(
      JSON.stringify(["hello", "aaa", "asd", "asdasd"]),
    );
    expect(JSON.stringify((helloBlock?.children ?? []).map((block) => block.id))).toBe(
      JSON.stringify([]),
    );
  });

  test("serializes section prompts through the clipboard plain-text path", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({
        id: "body-1",
        type: "paragraph",
        content: [
          { type: "text", text: "before ", styles: {} },
          {
            type: "attachment",
            props: {
              kind: "file",
              mode: "link",
              source: "/tmp/report.txt",
              name: "report.txt",
              mimeType: "text/plain",
              bytes: 42,
              origin: "/tmp/report.txt",
            },
          },
          { type: "text", text: " after", styles: {} },
        ],
      }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "body-1");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];

    expect(serializeThreadSectionPrompt(promptBlocks)).toBe(
      "before [report.txt](/tmp/report.txt) after",
    );
  });

  test("serializes thread mentions as text without prompt mentions", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({
        id: "body-1",
        type: "paragraph",
        content: [
          { type: "text", text: "see ", styles: {} },
          {
            type: "threadMention",
            props: {
              uuid: "019-thread",
            },
          },
          { type: "text", text: " before send", styles: {} },
        ],
      }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "body-1");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];
    const promptInput = buildThreadSectionPromptInput(promptBlocks);

    expect(serializeThreadSectionPrompt(promptBlocks)).toBe("see [Thread: 019-thread] before send");
    expect(promptInput.text).toBe("see [Thread: 019-thread] before send");
    expect("mentions" in promptInput).toBe(false);
  });

  test("builds prompt input from image blocks and agent config chips", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({
        id: "body-1",
        type: "paragraph",
        content: [
          { type: "text", text: "before ", styles: {} },
          {
            type: "agentConfig",
            props: {
              mode: "plan",
              model: "gpt-5.5",
              reasoning: "high",
              unknownAttributes: "",
              rawAttributes: "",
            },
          },
          { type: "text", text: " after", styles: {} },
        ],
      }),
      createBlock({
        id: "image-1",
        type: "image",
        props: {
          url: "https://example.com/diagram.png",
          caption: "System diagram",
        },
      }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "body-1");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];
    const promptInput = buildThreadSectionPromptInput(promptBlocks);

    expect(promptInput.text).toBe("before  after\n[Image #1] (caption: System diagram)");
    expect(promptInput.images?.length ?? 0).toBe(1);
    expect(promptInput.images?.[0]?.source).toBe("https://example.com/diagram.png");
    expect(promptInput.images?.[0]?.caption).toBe("System diagram");
    expect(promptInput.agentConfigs?.length ?? 0).toBe(1);
    expect(promptInput.agentConfigs?.[0]?.mode).toBe("plan");
    expect(promptInput.agentConfigs?.[0]?.model).toBe("gpt-5.5");
    expect(promptInput.agentConfigs?.[0]?.reasoning).toBe("high");
  });

  test("numbers multiple image placeholders in prompt order", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({
        id: "image-1",
        type: "image",
        props: {
          url: "https://example.com/first.png",
          caption: "First diagram",
        },
      }),
      createBlock({
        id: "body-1",
        type: "paragraph",
        content: [{ type: "text", text: "between", styles: {} }],
      }),
      createBlock({
        id: "image-2",
        type: "image",
        props: {
          url: "/tmp/second.png",
          caption: "Second diagram",
        },
      }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "image-1");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];
    const promptInput = buildThreadSectionPromptInput(promptBlocks);

    expect(promptInput.text).toBe(
      "[Image #1] (caption: First diagram)\nbetween\n[Image #2] (caption: Second diagram)",
    );
    expect(promptInput.images?.map((image) => image.source).join(",")).toBe(
      "https://example.com/first.png,/tmp/second.png",
    );
  });

  test("uses a bare placeholder for captionless image-only sections", () => {
    const blocks = [
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({
        id: "image-1",
        type: "image",
        props: {
          url: "nodex://assets/photo.png",
          caption: "",
        },
      }),
    ];

    const section = resolveThreadSectionForBlock(blocks, "image-1");
    const promptBlocks = section ? deriveThreadSectionPromptBlocks(section) : [];
    const promptInput = buildThreadSectionPromptInput(promptBlocks);

    expect(promptInput.text).toBe("[Image #1]");
    expect(promptInput.images?.length ?? 0).toBe(1);
    expect(promptInput.images?.[0]?.source).toBe("nodex://assets/photo.png");
    expect(promptInput.images?.[0]?.caption).toBe(undefined);
  });

  test("creates a local send plan when no thread section exists", () => {
    const blocks = [
      createBlock({ id: "alpha", type: "paragraph" }),
      createBlock({ id: "beta", type: "paragraph" }),
      createBlock({ id: "section-1", type: "threadSection" }),
      createBlock({ id: "gamma", type: "paragraph" }),
    ];

    const sendPlan = resolveThreadSectionSendPlan(blocks, "beta");

    expect(sendPlan?.createMarkerBeforeBlockId).toBe("beta");
    expect(JSON.stringify(sendPlan?.section.bodyBlockIds)).toBe(JSON.stringify(["beta"]));
    expect(sendPlan?.section.markerBlockId).toBe("");
  });

  test("ascends nested blocks to their top-level ancestor", () => {
    const blocks = [
      createBlock({
        id: "section-1",
        type: "threadSection",
      }),
      createBlock({
        id: "parent-1",
        type: "toggleListItem",
        children: [createBlock({ id: "child-1", type: "paragraph" })],
      }),
    ];
    const editor = createEditor(blocks);

    expect(resolveTopLevelBlockId(editor, "child-1")).toBe("parent-1");
    expect(resolveShortcutBlockId(editor)).toBe("child-1");
  });
});
