import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, test } from "vite-plus/test";

import { headlessBlockDocumentSchema } from "../../shared/block-documents/headless-blocknote-schema";
import {
  applyLocalNfmTurnInto,
  NFM_TURN_INTO_DEFINITIONS,
  resolvePageMentionEmbedTarget,
} from "./nfm-turn-into-targets";

const pageId = "roadmap/2026";
const pageMention = { type: "pageMention" as const, props: { targetPageId: pageId } };
const pageDeepLinkText = {
  type: "text",
  text: "nodex://pages/roadmap%2F2026",
  styles: {},
};

describe("resolvePageMentionEmbedTarget", () => {
  const paragraph = { type: "paragraph", content: [pageMention] };
  const space = { type: "text", text: " " };

  test.each([
    { name: "one mention", block: paragraph },
    {
      name: "a pasted mention followed by a space",
      block: { ...paragraph, children: [], content: [pageMention, space] },
    },
    {
      name: "whitespace on both sides and a trimmed Page ID",
      block: {
        ...paragraph,
        content: [
          { type: "text", text: "\t " },
          { type: "pageMention", props: { targetPageId: ` ${pageId} ` } },
          space,
        ],
      },
    },
  ])("accepts $name", ({ block }) => {
    expect(resolvePageMentionEmbedTarget(block)).toBe(pageId);
  });

  test.each([
    { name: "a heading", block: { ...paragraph, type: "heading" } },
    { name: "a child Block", block: { ...paragraph, children: [{ type: "paragraph" }] } },
    { name: "no content", block: { type: "paragraph" } },
    { name: "non-array content", block: { ...paragraph, content: pageMention } },
    { name: "whitespace without a mention", block: { ...paragraph, content: [space] } },
    {
      name: "non-whitespace text beside a mention",
      block: { ...paragraph, content: [pageMention, { type: "text", text: "hello" }] },
    },
    {
      name: "two mentions of the same Page",
      block: { ...paragraph, content: [pageMention, space, pageMention] },
    },
    {
      name: "a blank target ID",
      block: { ...paragraph, content: [{ type: "pageMention", props: { targetPageId: " " } }] },
    },
    { name: "missing mention props", block: { ...paragraph, content: [{ type: "pageMention" }] } },
    ...["link", "threadMention", "attachment"].map((type) => ({
      name: `a ${type} beside a mention`,
      block: { ...paragraph, content: [pageMention, { type }] },
    })),
    { name: "a raw string beside a mention", block: { ...paragraph, content: [pageMention, " "] } },
  ])("rejects $name", ({ block }) => {
    expect(resolvePageMentionEmbedTarget(block)).toBeNull();
  });
});

describe("NFM Turn into target catalog", () => {
  test("exposes the complete lossless target matrix with one typed intent per menu item", () => {
    expect(NFM_TURN_INTO_DEFINITIONS).toHaveLength(16);
    expect(new Set(NFM_TURN_INTO_DEFINITIONS.map((item) => item.key)).size).toBe(16);
    expect(
      NFM_TURN_INTO_DEFINITIONS.filter((item) => item.target.kind === "heading").map((item) => ({
        level: item.target.kind === "heading" ? item.target.level : null,
        toggleable: item.target.kind === "heading" ? item.target.toggleable : null,
      })),
    ).toEqual([
      { level: "one", toggleable: false },
      { level: "two", toggleable: false },
      { level: "three", toggleable: false },
      { level: "one", toggleable: true },
      { level: "two", toggleable: true },
      { level: "three", toggleable: true },
    ]);
    expect(
      NFM_TURN_INTO_DEFINITIONS.map((item) => item.target.kind).filter(
        (kind) => kind !== "heading",
      ),
    ).toEqual([
      "paragraph",
      "bulleted_list",
      "numbered_list",
      "todo_list",
      "toggle_list",
      "quote",
      "callout",
      "prompt",
      "code",
      "equation",
    ]);
  });

  test("turns an ordinary selection inside one editor transaction", () => {
    const calls: string[] = [];
    const editor = {
      schema: { blockSchema: { toggleListItem: { content: "inline" as const } } },
      transact: (callback: () => void) => {
        calls.push("begin");
        callback();
        calls.push("commit");
      },
      updateBlock: (block: unknown) => {
        calls.push(`update:${String(block)}`);
      },
    };

    applyLocalNfmTurnInto(editor, ["one", "two"], { type: "toggleListItem" });

    expect(calls).toEqual(["begin", "update:one", "update:two", "commit"]);
  });
});

describe("applyLocalNfmTurnInto", () => {
  test.each([
    { key: "paragraph", type: "paragraph", content: [pageMention] },
    { key: "heading-2", type: "heading", content: [pageMention] },
    { key: "code", type: "codeBlock", content: [pageDeepLinkText] },
    { key: "equation", type: "mathBlock", content: [pageDeepLinkText] },
  ])("preserves a Page Reference target when turning it into $key", ({ key, type, content }) => {
    const editor = BlockNoteEditor.create({
      schema: headlessBlockDocumentSchema,
      initialContent: [{ id: "reference", type: "pageRef", props: { targetBlockId: pageId } }],
    });
    const definition = NFM_TURN_INTO_DEFINITIONS.find((target) => target.key === key);
    if (!definition) throw new Error(`Missing Turn into definition for ${key}`);

    applyLocalNfmTurnInto(editor, editor.document, definition.localPatch);

    expect(editor.getBlock("reference")).toMatchObject({ type, content });
  });

  test("retains an ordinary paragraph's rich text when turning it into a heading", () => {
    const content = [{ type: "text" as const, text: "Heading text", styles: { bold: true } }];
    const editor = BlockNoteEditor.create({
      schema: headlessBlockDocumentSchema,
      initialContent: [{ id: "text", type: "paragraph", content }],
    });

    applyLocalNfmTurnInto(editor, editor.document, { type: "heading", props: { level: 2 } });

    expect(editor.getBlock("text")).toMatchObject({
      type: "heading",
      props: { level: 2 },
      content,
    });
  });
});
