import { describe, expect, test } from "bun:test";
import {
  deriveThreadSectionPromptBlocks,
  isToggleShortcutBlock,
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
      createBlock({ id: "section-1", type: "threadSection", props: { label: "First", threadId: "thr-1" } }),
      createBlock({ id: "body-1", type: "paragraph", content: [{ type: "text", text: "alpha", styles: {} }] }),
      createBlock({ id: "body-2", type: "paragraph", content: [{ type: "text", text: "beta", styles: {} }] }),
      createBlock({ id: "section-2", type: "threadSection", props: { label: "", threadId: "" } }),
      createBlock({ id: "body-3", type: "paragraph", content: [{ type: "text", text: "gamma", styles: {} }] }),
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
      createBlock({ id: "body-1", type: "paragraph", content: [{ type: "text", text: "alpha", styles: {} }] }),
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
            children: [
              createBlock({ id: "body-1-child", type: "paragraph" }),
            ],
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

  test("includes marker direct children before following sibling blocks in the prompt", () => {
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
    const promptBlocks = section
      ? deriveThreadSectionPromptBlocks(section)
      : [];

    expect(JSON.stringify(promptBlocks.map((block) => block.id))).toBe(JSON.stringify([
      "child-1",
      "child-2",
      "lol",
      "lalala",
    ]));
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
    const promptBlocks = section
      ? deriveThreadSectionPromptBlocks(section)
      : [];
    const helloBlock = promptBlocks[0];

    expect(JSON.stringify(promptBlocks.map((block) => block.id))).toBe(JSON.stringify([
      "hello",
      "aaa",
      "asd",
      "asdasd",
    ]));
    expect(JSON.stringify((helloBlock?.children ?? []).map((block) => block.id))).toBe(JSON.stringify([]));
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
    const promptBlocks = section
      ? deriveThreadSectionPromptBlocks(section)
      : [];

    expect(serializeThreadSectionPrompt(promptBlocks)).toBe("before [Attachment: report.txt] after");
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
        children: [
          createBlock({ id: "child-1", type: "paragraph" }),
        ],
      }),
    ];
    const editor = createEditor(blocks);

    expect(resolveTopLevelBlockId(editor, "child-1")).toBe("parent-1");
    expect(resolveShortcutBlockId(editor)).toBe("child-1");
  });

  test("recognizes toggle shortcut targets", () => {
    expect(isToggleShortcutBlock({ type: "toggleListItem" })).toBeTrue();
    expect(isToggleShortcutBlock({ type: "heading", props: { isToggleable: true } })).toBeTrue();
    expect(isToggleShortcutBlock({ type: "paragraph" })).toBeFalse();
  });
});
