import { useState } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { createMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { LocalConversationSelectedTextActions } from "./local-conversation-selected-text-actions";
import { ThreadTextSelectionAttachments } from "./thread-text-selection-attachments";
import { useThreadTextSelectionDraft } from "../thread-text-selection-draft";
import "../../../globals.css";

installRendererThemeFixture();

vi.mock("./composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({ isDictating: false, isStarting: false, isTranscribing: false }),
}));

function Surface({ onSide }: { onSide: (input: unknown) => Promise<void> }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const controller = useThreadTextSelectionDraft("local", "thread");
  return (
    <>
      <div
        ref={setRoot}
        style={{ marginLeft: 12, marginTop: 120, width: 320, height: 180, overflow: "auto" }}
      >
        <div
          data-thread-selected-text-target="true"
          data-response-annotation-target="response"
          data-response-annotation-thread="thread"
          style={{ fontSize: 16, lineHeight: "24px" }}
        >
          <p>First passage wraps naturally when the conversation becomes narrow.</p>
          <p>Second passage keeps its own source.</p>
        </div>
        <div style={{ height: 300 }} />
        <LocalConversationSelectedTextActions
          enabled
          hostId="local"
          threadId="thread"
          scrollElement={root}
          onOpenSideChat={onSide}
        />
      </div>
      <ThreadTextSelectionAttachments
        context={controller.draft}
        onEditAnnotation={controller.editAnnotation}
        onRemoveAnnotation={controller.removeAnnotation}
        onRemoveSelection={controller.removeSelection}
      />
    </>
  );
}

async function select(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  await act(async () => {
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise(requestAnimationFrame);
  });
  return range;
}

test("positions above the first visible line, preserves selection on press, and manages annotation notes", async () => {
  const onSide = vi.fn(async () => {});
  const view = render(
    <MaitaiProvider store={createMaitaiStore()}>
      <Surface onSide={onSide} />
    </MaitaiProvider>,
  );
  const target = view.container.querySelector("[data-response-annotation-target] p")!;
  const range = await select(target);
  const add = await view.findByRole("button", { name: "Add to chat" });
  const toolbar = document.querySelector("[data-selected-text-actions]")!;
  const first = range.getClientRects()[0]!;
  expect(toolbar.getBoundingClientRect().bottom).toBeCloseTo(first.top - 8, 0);
  expect(toolbar.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);
  await act(async () => {
    fireEvent.pointerDown(target);
    await Promise.resolve();
  });
  expect(view.queryByRole("button", { name: "Add to chat" })).toBeNull();
  await act(async () => {
    fireEvent.pointerUp(target);
    await new Promise(requestAnimationFrame);
  });
  await view.findByRole("button", { name: "Add to chat" });
  await act(async () => {
    await userEvent.click(
      add.isConnected ? add : view.getByRole("button", { name: "Add to chat" }),
    );
  });
  const note = await view.findByRole("textbox", { name: "Note" });
  expect(document.activeElement).toBe(note);
  expect(document.getSelection()?.isCollapsed).toBe(true);
  expect(CSS.highlights.size).toBeGreaterThan(0);
  await act(async () => {
    await userEvent.fill(note, "Explain the wrapping");
    await userEvent.click(target);
  });
  await waitFor(() => expect(document.activeElement).toBe(note));
  expect((note as HTMLTextAreaElement).value).toBe("Explain the wrapping");
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Comment" }));
  });
  await view.findByRole("button", { name: "Response annotation 1" });
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "1 annotation" }));
  });
  await view.findByText("Explain the wrapping");
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Edit annotation 1" }));
  });
  const edit = await view.findByRole("textbox", { name: "Note" });
  expect((edit as HTMLTextAreaElement).value).toBe("Explain the wrapping");
  await act(async () => {
    await userEvent.fill(edit, "Unsaved edit");
    await userEvent.keyboard("{Escape}");
  });
  await waitFor(() => expect(view.queryByRole("textbox", { name: "Note" })).toBeNull());
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Response annotation 1" }));
  });
  expect(((await view.findByRole("textbox", { name: "Note" })) as HTMLTextAreaElement).value).toBe(
    "Explain the wrapping",
  );
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Delete annotation" }));
  });
  await waitFor(() => expect(view.queryByRole("button", { name: "1 annotation" })).toBeNull());
  expect(onSide).not.toHaveBeenCalled();
});

test("clips at scrolling boundaries and hands the selected paragraphs to side chat without sending", async () => {
  const onSide = vi.fn(async (_input: unknown) => {});
  const view = render(
    <MaitaiProvider store={createMaitaiStore()}>
      <Surface onSide={onSide} />
    </MaitaiProvider>,
  );
  const target = view.container.querySelector("[data-response-annotation-target]")!;
  await select(target);
  const askInSideChat = await view.findByRole("button", { name: "Ask in side chat" });
  await act(async () => {
    await userEvent.click(askInSideChat);
  });
  expect(onSide).toHaveBeenCalledExactlyOnceWith({
    kind: "selection",
    text: "First passage wraps naturally when the conversation becomes narrow.\n\nSecond passage keeps its own source.",
  });
  await select(target);
  await view.findByRole("button", { name: "Add to chat" });
  await act(async () => {
    target.parentElement!.scrollTop = 250;
    fireEvent.scroll(target.parentElement!);
    await new Promise(requestAnimationFrame);
  });
  await waitFor(() => expect(view.queryByRole("button", { name: "Add to chat" })).toBeNull());
});

test("an annotation stays editable after its source leaves resident history", async () => {
  const view = render(
    <MaitaiProvider store={createMaitaiStore()}>
      <Surface onSide={async () => {}} />
    </MaitaiProvider>,
  );
  const target = view.container.querySelector("[data-response-annotation-target]")!;
  await select(target.querySelector("p")!);
  const addToChat = await view.findByRole("button", { name: "Add to chat" });
  await act(async () => {
    await userEvent.click(addToChat);
  });
  const comment = await view.findByRole("button", { name: "Comment" });
  await act(async () => {
    await userEvent.click(comment);
  });
  await act(async () => {
    target.remove();
    await new Promise(requestAnimationFrame);
  });
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Response annotation 1" })).toBeNull(),
  );
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "1 annotation" }));
  });
  const editAnnotation = await view.findByRole("button", { name: "Edit annotation 1" });
  await act(async () => {
    await userEvent.click(editAnnotation);
  });
  const note = await view.findByRole("textbox", { name: "Note" });
  await act(async () => {
    await userEvent.fill(note, "Preserve this reference");
    await userEvent.click(view.getByRole("button", { name: "Comment" }));
  });
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "1 annotation" }));
  });
  await view.findByText("Preserve this reference");
});
