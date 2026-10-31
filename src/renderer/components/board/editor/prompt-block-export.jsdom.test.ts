import { BlockNoteEditor } from "@blocknote/core";
import { expect, test } from "vite-plus/test";
import { headlessBlockDocumentSchema } from "../../../../shared/block-documents/headless-blocknote-schema";

test("Prompt HTML export keeps rich first-line content followed by its children", () => {
  const editor = BlockNoteEditor.create({
    schema: headlessBlockDocumentSchema,
    initialContent: [
      {
        type: "prompt",
        props: {
          sentSessionId: "deleted-session",
          sentMessageId: "prompt-message",
          sentAt: "2026-10-31T08:30:00.000Z",
        },
        content: [{ type: "text", text: "Review this change", styles: { bold: true } }],
        children: [{ type: "paragraph", content: "Check boundaries" }],
      },
    ],
  });
  const container = document.createElement("div");
  container.innerHTML = editor.blocksToHTMLLossy();
  expect(container.querySelector("strong")?.textContent).toBe("Review this change");
  expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
    "Review this change",
    "Check boundaries",
  ]);
});
