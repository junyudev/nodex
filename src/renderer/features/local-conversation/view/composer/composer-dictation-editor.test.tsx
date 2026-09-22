import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { history, undo, redo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { buildPromptDoc, readPromptDocText } from "./composer-prompt-editor";
import {
  composerDictationPlugin,
  createComposerDictationEditor,
  mapDictationConsumedPrefix,
} from "./composer-dictation-editor";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function createEditor(text = "", selection?: { from: number; to?: number }) {
  const doc = buildPromptDoc(text);
  const mount = document.createElement("div");
  document.body.append(mount);
  const view = new EditorView(mount, {
    state: EditorState.create({
      doc,
      selection: selection
        ? TextSelection.create(doc, selection.from, selection.to)
        : TextSelection.atEnd(doc),
      plugins: [composerDictationPlugin, history()],
    }),
  });
  const dictation = createComposerDictationEditor(view);
  disposers.push(() => {
    dictation.dispose();
    view.destroy();
    mount.remove();
  });
  return { view, dictation, text: () => readPromptDocText(dictation.document) };
}

describe("Composer dictation ranges", () => {
  test("revises the active segment and finalizes without appending a second transcript", async () => {
    const { dictation, text } = createEditor("Plan:");
    dictation.start(() => null);
    dictation.update("first", { id: 0, text: "first" });
    expect(text()).toBe("Plan: first");
    dictation.update("first draft", { id: 0, text: "first draft" });
    expect(text()).toBe("Plan: first draft");
    expect(await dictation.finish("First draft.")).toBe("finished");
    expect(text()).toBe("Plan: First draft.");
    expect(await dictation.finish("ignored")).toBe("not-active");
  });

  test("restores selected mention content when cancelling the untouched transcript", () => {
    const original = "Open [repo](/tmp/repo)";
    const { view, dictation, text } = createEditor(original);
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end - 1, end)));
    dictation.start(() => null);
    dictation.update("the project", { id: 0, text: "the project" });
    expect(text()).toBe("Open the project");
    dictation.cancel();
    expect(text()).toBe(original);
    expect(view.state.doc.lastChild?.lastChild?.type.name).toBe("mention");
  });

  test("splits at a moved caret, revises the old segment in place, and keeps the new caret", async () => {
    const { view, dictation, text } = createEditor("Finish");
    let id = 0;
    const split = vi.fn(() => ++id);
    dictation.start(split);
    dictation.update("later", { id: 0, text: "later" });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(split).toHaveBeenCalledOnce();
    dictation.update("before later", { id: 1, text: "before" });
    expect(text()).toBe("before Finish later");
    const caret = view.state.selection.head;
    dictation.update("before later today", { id: 0, text: "later today" });
    expect(text()).toBe("before Finish later today");
    expect(view.state.selection.head).toBe(caret);
    await dictation.finish("later today before");
    expect(text()).toBe("before Finish later today");
  });

  test("preserves an edited prefix while subsequent revisions only update its untouched suffix", () => {
    const { view, dictation, text } = createEditor();
    let id = 0;
    dictation.start(() => ++id);
    dictation.update("alpha beta", { id: 0, text: "alpha beta" });
    view.dispatch(view.state.tr.insertText("manual", 1, 6));
    dictation.update("alpha beta gamma", { id: 0, text: "alpha beta gamma" });
    expect(text()).toBe("manual beta gamma");
    dictation.cancel();
    expect(text()).toBe("manual");
  });

  test("clearing the composer never lets late transcript revisions resurrect the cleared segment", () => {
    const { view, dictation, text } = createEditor();
    let id = 0;
    dictation.start(() => ++id);
    dictation.update("clear me", { id: 0, text: "clear me" });
    view.dispatch(view.state.tr.delete(1, view.state.doc.content.size - 1));
    dictation.update("clear me please", { id: 0, text: "clear me please" });
    expect(text()).toBe("");
    dictation.update("clear me please new words", { id: 1, text: "new words" });
    expect(text()).toBe("new words");
  });

  test("buffers revisions during IME composition and waits before final delivery", async () => {
    const { view, dictation, text } = createEditor();
    const composing = vi.spyOn(view, "composing", "get").mockReturnValue(true);
    dictation.start();
    dictation.update("你好");
    const finish = dictation.finish("你好世界");
    expect(text()).toBe("");
    composing.mockReturnValue(false);
    view.dom.dispatchEvent(new CompositionEvent("compositionend"));
    expect(await finish).toBe("finished");
    expect(text()).toBe("你好世界");
  });

  test("cancelling while finish waits for composition cannot reinsert the cancelled text", async () => {
    const { view, dictation, text } = createEditor("existing");
    vi.spyOn(view, "composing", "get").mockReturnValue(true);
    dictation.start();
    const finish = dictation.finish("cancelled");
    dictation.cancel();
    expect(await finish).toBe("cancelled");
    expect(text()).toBe("existing");
  });

  test("finalizes into detached editor state after its surface unmounts", async () => {
    const { view, dictation, text } = createEditor("Draft");
    dictation.start();
    dictation.update("in progress");
    dictation.dispose();
    view.destroy();
    await dictation.finish("complete");
    expect(text()).toBe("Draft complete");
  });

  test("protects newer persisted content when finishing a detached segmented editor", async () => {
    const { view, dictation, text } = createEditor("Draft");
    dictation.start(() => null);
    dictation.update("old speech", { id: 0, text: "old speech" });
    dictation.dispose();
    view.destroy();
    await dictation.finish("old speech completed", () => buildPromptDoc("newer draft"));
    expect(text()).toBe("newer draft");
  });

  test("preserves interrupted transcript text without letting cancellation or late updates remove it", () => {
    const { dictation, text } = createEditor("Draft");
    dictation.start();
    dictation.update("partial");
    dictation.preserve();
    dictation.update("late overwrite");
    dictation.cancel();
    expect(text()).toBe("Draft partial");
  });

  test("groups all revisions into a single undo step separate from existing edits", async () => {
    const { view, dictation, text } = createEditor("Draft");
    view.dispatch(view.state.tr.insertText(" typed"));
    dictation.start();
    dictation.update("first");
    dictation.update("first revision");
    await dictation.finish("final words");
    expect(text()).toBe("Draft typed final words");
    expect(undo(view.state, view.dispatch.bind(view))).toBe(true);
    expect(text()).toBe("Draft typed");
    expect(redo(view.state, view.dispatch.bind(view))).toBe(true);
    expect(text()).toBe("Draft typed final words");
  });

  test.each([
    ["hello world", "Hello world!", 6, 6],
    ["a b c", "a longer b c", 4, 11],
    ["wrong words suffix", "right suffix", 12, 6],
    ["你好 世界", "您好 世界", 3, 3],
  ])(
    "maps consumed words through recognition revisions: %s",
    (before, after, consumed, expected) => {
      expect(mapDictationConsumedPrefix(before, after, consumed)).toBe(expected);
    },
  );
});
