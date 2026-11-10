import { act, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { SkillBodyEditor } from "./skill-body-editor";
import { createSkillEditorSession, type SkillEditorCandidate } from "./skill-editor-session";

installRendererThemeFixture();

test("types into the detached NFM draft and adopts a save without losing a later keystroke", async () => {
  const text =
    "\uFEFF---\r\nname: inspect\r\ndescription: Check output.\r\n---\r\n" +
    "# Inspect 🧪\r\n\r\nReview output\r\n\r\n* Retain this  \r\n";
  const session = createSkillEditorSession(text, { debounceMs: 10 });
  const original = session.getSnapshot().source.blocks;
  const view = renderWithAppMaitai(<SkillBodyEditor session={session} />);
  const type = async (keys: string) =>
    act(async () => {
      await userEvent.keyboard(keys);
    });
  const candidate = async (): Promise<SkillEditorCandidate> =>
    waitFor(() => {
      const draft = session.getSnapshot().draft;
      if (draft.kind !== "candidate") throw new Error(JSON.stringify(draft));
      return draft.candidate;
    });

  try {
    expect(session.getSnapshot().draft.kind).toBe("clean");
    const paragraph = await view.findByText("Review output");
    await act(async () => {
      await userEvent.click(paragraph);
    });
    await type("{End}x{Backspace}");
    await act(async () => {
      expect(session.flush()).toEqual({ kind: "clean" });
    });
    expect(session.getSnapshot().source.text).toBe(text);

    await type("!");
    const first = await candidate();
    expect(first).toEqual({
      baseText: text,
      text: text.replace("Review output", "Review output!"),
    });

    await type("?");
    await act(async () => {
      expect(session.reseed(text.replace("Retain this", "External"))).toBe(false);
    });
    await act(async () => {
      expect(session.acceptSaved(first)).toBe(true);
    });
    const second = await candidate();
    expect(second).toEqual({
      baseText: first.text,
      text: text.replace("Review output", "Review output!?"),
    });
    await act(async () => {
      expect(session.acceptSaved(second)).toBe(true);
    });
    expect(session.getSnapshot().source.blocks.map(({ id }) => id)).toEqual(
      original.map(({ id }) => id),
    );
    expect(session.getSnapshot().draft.kind).toBe("clean");

    const changed = second.text.replace("Retain this", "Updated outside Nodex");
    await act(async () => {
      expect(session.reseed(changed)).toBe(true);
    });
    expect(await view.findByText("Updated outside Nodex")).toBeTruthy();
    await type(".");
    expect((await candidate()).text).toBe(changed.replace("Review output!?", "Review output!?."));

    view.rerender(<SkillBodyEditor session={session} readOnly />);
    expect(view.container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe(
      "false",
    );
  } finally {
    view.unmount();
    session.dispose();
  }
});
