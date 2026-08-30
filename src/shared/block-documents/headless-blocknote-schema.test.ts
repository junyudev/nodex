import { describe, expect, test } from "vite-plus/test";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc, yDocToBlocks } from "@blocknote/core/yjs";
import {
  headlessBlockDocumentSchema,
  type HeadlessBlockDocumentPartialBlock,
} from "./headless-blocknote-schema";

describe("headless Block Document schema", () => {
  test("imports and converts Yjs content in a DOM-free process", () => {
    expect(Reflect.has(globalThis, "document")).toBe(false);
    expect(Reflect.has(globalThis, "window")).toBe(false);

    const editor = BlockNoteEditor.create({
      schema: headlessBlockDocumentSchema,
      initialContent: [
        {
          id: "headless-probe",
          type: "pageRef",
          props: { sourceProjectId: "project-1", cardId: "card-1" },
        },
      ],
    });
    const document = blocksToYDoc(editor, editor.document, "body");
    const decoded = yDocToBlocks(editor, document, "body");

    expect(editor.headless).toBe(true);
    expect(decoded[0]?.id).toBe("headless-probe");
  });

  test("round-trips all custom block and inline shapes through Yjs", () => {
    const initialContent: HeadlessBlockDocumentPartialBlock[] = [
      {
        id: "callout-block",
        type: "callout",
        props: { icon: "📌" },
        content: [
          { type: "text", text: "Before ", styles: { bold: true } },
          {
            type: "attachment",
            props: {
              kind: "file",
              mode: "materialized",
              source: "nodex://assets/example.txt",
              name: "example.txt",
              mimeType: "text/plain",
              bytes: 12,
              origin: "paste",
            },
          },
          {
            type: "agentConfig",
            props: {
              mode: "agent",
              provider: "openai",
              model: "gpt-5",
              reasoning: "high",
              speed: "fast",
              permission: "auto",
              unknownAttributes: "",
              rawAttributes: "mode=agent",
            },
          },
          {
            type: "dateMention",
            props: {
              start: "2026-07-11",
              end: "",
              tz: "Asia/Shanghai",
              format: "date",
              timeFormat: "",
              reminder: "",
            },
          },
          {
            type: "threadMention",
            props: { uuid: "thread-1" },
          },
          { type: "math", content: "x^2" },
          { type: "text", text: " after", styles: { italic: true } },
        ],
      },
      {
        id: "math-block",
        type: "mathBlock",
        content: "\\sum_i x_i",
      },
      {
        id: "thread-section-block",
        type: "threadSection",
        props: { label: "Implementation", threadId: "thread-1" },
      },
      {
        id: "page-block",
        type: "page",
      },
      {
        id: "database-block",
        type: "database",
      },
      {
        id: "canonical-page-ref-block",
        type: "pageRef",
        props: {
          targetBlockId: "card-3",
        },
      },
      {
        id: "database-view-ref-block",
        type: "databaseViewRef",
        props: {
          databaseViewId: "view-1",
          displayHint: "Planning",
        },
      },
      {
        id: "synced-block-ref-block",
        type: "syncedBlockRef",
        props: { sourceBlockId: "synced-source-1" },
      },
      {
        id: "template-ref-block",
        type: "templateRef",
        props: {
          sourceBlockId: "template-source-1",
          displayHint: "Incident review",
        },
      },
    ];
    const editor = BlockNoteEditor.create({
      schema: headlessBlockDocumentSchema,
      initialContent,
    });

    expect(editor.headless).toBe(true);
    const document = blocksToYDoc(editor, editor.document, "body");
    const decoded = yDocToBlocks(editor, document, "body");

    expect(JSON.stringify(decoded)).toBe(JSON.stringify(editor.document));
    expect(decoded.map((block) => block.id).join(",")).toBe(
      "callout-block,math-block,thread-section-block,page-block,database-block,canonical-page-ref-block,database-view-ref-block,synced-block-ref-block,template-ref-block",
    );
  });
});
