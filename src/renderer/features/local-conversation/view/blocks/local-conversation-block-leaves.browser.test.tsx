import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { TestQueryProvider } from "@/test/query";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { renderWithMaitai } from "@/test/thread-maitai";
import type { ThreadTranscriptBlockModel } from "../../thread-stage-types";
import { UserMessageBubble } from "./local-conversation-block-leaves";

installRendererThemeFixture();

const block: ThreadTranscriptBlockModel = {
  id: "message",
  turnId: "turn",
  createdAt: 1,
  updatedAt: 1,
  searchableText: "Original request",
  type: "userMessage",
  userMessageActions: { canEdit: true, sentAtMs: null },
  entry: {
    threadId: "thread",
    turnId: "turn",
    itemId: "message",
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: "Original request",
    createdAt: 1,
    updatedAt: 1,
  },
};

test("editing focuses at the end, grows between two and six lines, and retains programmatic input", async () => {
  const onEditUserTurn = vi.fn(async () => {});
  const view = renderWithMaitai(
    <NodexTooltipProvider>
      <div style={{ width: 640 }}>
        <UserMessageBubble
          block={block}
          isLatestTurn
          isStreamingTurn={false}
          onEditUserTurn={onEditUserTurn}
        />
      </div>
    </NodexTooltipProvider>,
    { wrapper: TestQueryProvider },
  );
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Edit message" }));
  });
  const textarea = (await view.findByRole("textbox", {
    name: "Edit message",
  })) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe(textarea.value.length);
  expect(textarea.selectionEnd).toBe(textarea.value.length);
  expect(textarea.getBoundingClientRect().height).toBe(40);

  // Dictation writes the value directly before dispatching an input event.
  const writeInput = async (value: string) => {
    await act(async () => {
      textarea.value = value;
      fireEvent.input(textarea);
      await Promise.resolve();
    });
  };

  await writeInput("First\nSecond\nThird\nFourth");
  expect(textarea.getBoundingClientRect().height).toBe(80);
  expect(textarea.scrollHeight).toBe(textarea.clientHeight);

  await writeInput(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
  expect(textarea.getBoundingClientRect().height).toBe(120);
  expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  expect(getComputedStyle(textarea).overflowY).toBe("auto");
  textarea.scrollTop = textarea.scrollHeight;
  expect(textarea.scrollTop).toBeGreaterThan(0);

  await writeInput("Revised request");
  expect(textarea.getBoundingClientRect().height).toBe(40);
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Send" }));
  });
  await waitFor(() => expect(view.queryByRole("textbox", { name: "Edit message" })).toBeNull());
  expect(onEditUserTurn).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread",
    turnId: "turn",
    message: "Revised request",
    images: [],
  });
});
