import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { render, waitFor, type RenderResult } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { nfmSchema } from "./nfm-schema";
import { NFM_INERT_PROMPT_RUNTIME, NfmPromptRuntimeProvider } from "./nfm-prompt-runtime";
import "@blocknote/shadcn/style.css";
import "../../../globals.css";

const SHORT_PROMPT = "Short prompt";

const editors: BlockNoteEditor<any, any, any>[] = [];
const views: RenderResult[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  for (const editor of editors.splice(0)) editor._tiptapEditor.destroy();
  document.body.replaceChildren();
});

/** A Prompt Block in a real Page editor, with a chat to send to. */
function mountPrompt(text: string, width: number) {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    initialContent: [
      {
        id: "prompt-1",
        type: "prompt",
        content: text ? [{ type: "text", text, styles: {} }] : [],
      },
    ],
  });
  editors.push(editor);
  const view = render(
    <NodexTooltipProvider>
      <NfmPromptRuntimeProvider
        value={{
          ...NFM_INERT_PROMPT_RUNTIME,
          destination: { kind: "new-chat" },
          send: async () => undefined,
        }}
      >
        <div className="nfm-editor" style={{ width }}>
          <BlockNoteViewRaw
            editor={editor}
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            tableHandles={false}
          />
        </div>
      </NfmPromptRuntimeProvider>
    </NodexTooltipProvider>,
  );
  views.push(view);
  return view;
}

function promptText(container: HTMLElement): HTMLElement {
  const text = container.querySelector<HTMLElement>("[data-nfm-prompt] .bn-inline-content");
  if (!text) throw new Error("Expected the Prompt's text");
  return text;
}

/** The box of the text's last character, the reference the send button follows. */
function lastCharacterBox(text: HTMLElement): DOMRect {
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).length > 0) last = node as Text;
  }
  if (!last) throw new Error("Expected text in the Prompt");
  const range = document.createRange();
  range.setStart(last, last.length - 1);
  range.setEnd(last, last.length);
  return range.getBoundingClientRect();
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("[data-nfm-prompt-send]");
  if (!button) throw new Error("Expected a send button");
  return button;
}

describe("Prompt send button in the Page editor", () => {
  test("sits right after the last character of a short Prompt", async () => {
    const view = mountPrompt(SHORT_PROMPT, 480);
    await waitFor(() =>
      expect(view.container.querySelector("[data-nfm-prompt-send]")).not.toBeNull(),
    );
    const button = sendButton(view.container);
    expect(button.dataset.placement).toBe("inline");
    const glyph = lastCharacterBox(promptText(view.container));
    const gap = button.getBoundingClientRect().left - glyph.right;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(8);
  });

  test("takes a row beneath a Prompt whose last line is full", async () => {
    const view = mountPrompt(SHORT_PROMPT, 480);
    await waitFor(() => expect(sendButton(view.container).dataset.placement).toBe("inline"));
    const column = view.container.querySelector<HTMLElement>(".nfm-editor");
    if (!column) throw new Error("Expected the editor column");
    // Narrow the column to the text's own end: no room is left beside its last character.
    const glyph = lastCharacterBox(promptText(view.container));
    await act(async () => {
      column.style.width = `${glyph.right - column.getBoundingClientRect().left + 8}px`;
      await Promise.resolve();
    });
    await waitFor(() => expect(sendButton(view.container).dataset.placement).toBe("below"));
    expect(sendButton(view.container).getBoundingClientRect().top).toBeGreaterThanOrEqual(
      glyph.bottom,
    );
  });

  test("shows no send button for an empty Prompt", async () => {
    const view = mountPrompt("", 480);
    await waitFor(() => expect(view.container.querySelector("[data-nfm-prompt]")).not.toBeNull());
    expect(view.container.querySelector("[data-nfm-prompt-send]")).toBeNull();
  });
});
