import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import { AsyncQuestionPanel } from "./async-question-panel";
import { createAsyncQuestionRuntime } from "../../async-question-runtime";
import type { CodexCanonicalItem } from "../../../../../shared/codex-conversation-state/codex-conversation-state";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));

vi.mock("@/lib/use-reduced-motion", () => ({ useResolvedReducedMotion: () => true }));

function setup(questions = [{ title: "Which scope?", options: ["Local", "Global"] }]) {
  const runtime = createAsyncQuestionRuntime();
  const item: CodexCanonicalItem = {
    type: "agentMessage",
    id: "ask",
    delivery: "async",
    text: "Questions",
    phase: "final_answer",
    memoryCitation: null,
    questions,
  };
  runtime.reconcile({
    threadId: "thread",
    canonicalState: {
      turns: [
        {
          protocol: {
            id: "turn",
            status: "inProgress",
            error: null,
            durationMs: null,
            itemsView: "full",
          },
          items: [],
        },
      ],
    },
  });
  runtime.reconcile({
    threadId: "thread",
    canonicalState: {
      turns: [
        {
          protocol: {
            id: "turn",
            status: "inProgress",
            error: null,
            durationMs: null,
            itemsView: "full",
          },
          items: [item],
        },
      ],
    },
  });
  runtime.receive("thread", "ask");
  const send = vi.fn(async (turnId: string, _prompt: string) => ({ turnId }));
  function Harness() {
    const state = useSyncExternalStore(runtime.subscribe, () => runtime.read("thread"));
    return (
      <>
        <AsyncQuestionPanel
          threadId="thread"
          runtime={runtime}
          state={state}
          onSend={() => runtime.submit("thread", send)}
        />
        <textarea aria-label="Normal composer" />
      </>
    );
  }
  const view = render(<Harness />);
  return { ...view, runtime, send };
}
async function interact(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
async function paste(element: Element, text: string) {
  await interact(() =>
    fireEvent.paste(element, {
      clipboardData: {
        types: ["text/plain"],
        files: [],
        items: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    }),
  );
}

describe("async question panel", () => {
  test("does not send an initial choice and selecting an option sends after its activation feedback", async () => {
    const view = setup();
    expect((view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.send).not.toHaveBeenCalled();
    await interact(() => fireEvent.click(view.getByRole("radio", { name: "Local" })));
    expect(view.send).not.toHaveBeenCalled();
    await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("group", { name: "Agent question" })).toBeNull();
    expect(view.getByRole("textbox", { name: "Normal composer" })).toBeTruthy();
  });
  test("numbers typed in the normal composer never activate choices", async () => {
    const view = setup();
    await interact(() =>
      fireEvent.keyDown(view.getByRole("textbox", { name: "Normal composer" }), { key: "1" }),
    );
    expect(view.send).not.toHaveBeenCalled();
    expect(Object.values(view.runtime.read("thread").questions)[0]?.draft).toBe("");
    await interact(() =>
      fireEvent.keyDown(view.getByRole("group", { name: "Agent question" }), { key: "2" }),
    );
    await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
    expect(view.send.mock.calls[0]?.[1]).toContain('"answer":"Global"');
  });
  test("freeform uses the rich editor and IME Enter never submits", async () => {
    const view = setup([{ title: "What name?", options: [] }]);
    const editor = view.getByLabelText("Reply…");
    await paste(editor, "Nodex");
    await waitFor(() =>
      expect(Object.values(view.runtime.read("thread").questions)[0]?.draft).toBe("Nodex"),
    );
    await interact(() =>
      fireEvent.keyDown(editor, { key: "Enter", isComposing: true, keyCode: 229 }),
    );
    expect(view.send).not.toHaveBeenCalled();
    await interact(() => fireEvent.keyDown(editor, { key: "Enter" }));
    await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
  });
  test("multiple questions advance, preserve previous drafts, and skip the last question while sending earlier answers", async () => {
    const view = setup([
      { title: "Which scope?", options: ["Local", "Global"] },
      { title: "What name?", options: [] },
    ]);
    await interact(() => fireEvent.click(view.getByRole("radio", { name: "Local" })));
    await waitFor(() => expect(view.getByLabelText("Reply…")).toBeTruthy());
    expect(view.send).not.toHaveBeenCalled();
    await interact(() => fireEvent.click(view.getByRole("button", { name: "Previous question" })));
    await waitFor(() =>
      expect(view.getByRole("radio", { name: "Local" }).getAttribute("aria-checked")).toBe("true"),
    );
    await interact(() => fireEvent.click(view.getByRole("button", { name: "Next question" })));
    await waitFor(() => expect(view.getByLabelText("Reply…")).toBeTruthy());
    await interact(() => fireEvent.click(view.getByRole("button", { name: "Skip" })));
    await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
    expect(view.send.mock.calls[0]?.[1]).not.toContain('"question":"What name?"');
  });
  test("keeps a custom answer editable even when it matches an option and restores it after keyboard selection", async () => {
    const view = setup();
    const panel = view.getByRole("group", { name: "Agent question" });
    const editor = view.getByLabelText("Or write your own response");
    await interact(() => (editor as HTMLElement).focus());
    await paste(editor, "Local");
    expect(editor.textContent).toBe("Local");
    expect(view.getByRole("radio", { name: "Local" }).getAttribute("aria-checked")).toBe("false");
    await interact(() => fireEvent.keyDown(editor, { key: "ArrowUp" }));
    expect(view.getByRole("radio", { name: "Global" }).getAttribute("aria-checked")).toBe("true");
    await interact(() => fireEvent.keyDown(panel, { key: "ArrowDown" }));
    expect(document.activeElement).toBe(editor);
    expect(Object.values(view.runtime.read("thread").questions)[0]?.draft).toBe("Local");
    await interact(() => fireEvent.keyDown(editor, { key: "Enter" }));
    await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
    expect(view.send.mock.calls[0]?.[1]).toContain('"answer":"Local"');
  });
  test("shows the final countdown and cancels auto-dismiss when the user interacts", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const view = setup();
    try {
      expect(view.getByRole("button", { name: "Skip" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(view.getByRole("button", { name: "Skip, 20 seconds remaining" })).toBeTruthy();
      await interact(() =>
        fireEvent.keyDown(view.getByRole("group", { name: "Agent question" }), {
          key: "ArrowDown",
        }),
      );
      expect(view.getByRole("button", { name: "Skip" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(view.getByRole("group", { name: "Agent question" })).toBeTruthy();
      expect(view.send).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  test("keyboard confirmation waits for activation feedback and repeated Enter submits only once", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const view = setup();
    try {
      const panel = view.getByRole("group", { name: "Agent question" });
      await interact(() => fireEvent.keyDown(panel, { key: "ArrowUp" }));
      await interact(() => fireEvent.keyDown(panel, { key: "Enter" }));
      await interact(() => fireEvent.keyDown(panel, { key: "Enter" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(179);
      });
      expect(view.send).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(view.send).toHaveBeenCalledTimes(1);
      expect(view.send.mock.calls[0]?.[1]).toContain('"answer":"Global"');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  test("close preserves the draft for reopening and failures leave a retryable form", async () => {
    const view = setup([{ title: "What name?", options: [] }]);
    const id = view.runtime.read("thread").selectedId!;
    await paste(view.getByLabelText("Reply…"), "Nodex");
    await interact(() => fireEvent.click(view.getByRole("button", { name: "Close question" })));
    expect(view.runtime.read("thread").questions[id]?.draft).toBe("Nodex");
    await interact(() => view.runtime.open("thread", id));
    await waitFor(() => expect(view.getByLabelText("Reply…").textContent).toBe("Nodex"));
    view.send.mockRejectedValueOnce(new Error("offline"));
    await interact(() => fireEvent.click(view.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("Couldn’t send response"));
    expect(view.getByLabelText("Reply…").textContent).toBe("Nodex");
    await interact(() => fireEvent.click(view.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(view.send).toHaveBeenCalledTimes(2));
  });
});
