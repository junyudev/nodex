import { createCodexCanonicalHydratedConversationState } from "../../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexHoverCard } from "@/components/ui/hover-card";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "@/components/ui/dialog";
import { describe, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import { AsyncQuestionPanel } from "./async-question-panel";
import { createAsyncQuestionRuntime } from "../../async-question-runtime";
import type { CodexCanonicalItem } from "../../../../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexAsyncQuestionReply } from "../../../../../shared/codex-async-user-input";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));

vi.mock("@/lib/use-reduced-motion", () => ({ useResolvedReducedMotion: () => true }));

function setup(
  questions = [{ title: "Which scope?", options: ["Local", "Global"] }],
  overlay?: ReactNode,
) {
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
  const base = createCodexCanonicalHydratedConversationState(
    { ...buildAgentActivityV2CorpusThread([]), id: "thread" },
    {
      hostId: "local",
      model: "test",
      reasoningEffort: null,
      cwd: "/repo",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/repo"],
    },
  );
  runtime.reconcile({
    threadId: "thread",
    canonicalState: {
      ...base,
      turns: [
        {
          rootTurnId: null,
          ...base.turns[0]!,
          turnId: "turn",
          status: "inProgress",
          error: null,
          durationMs: null,
          itemsView: "full",
          items: [],
        },
      ],
    },
  });
  runtime.reconcile({
    threadId: "thread",
    canonicalState: {
      ...base,
      turns: [
        {
          rootTurnId: null,
          ...base.turns[0]!,
          turnId: "turn",
          status: "inProgress",
          error: null,
          durationMs: null,
          itemsView: "full",
          items: [item],
        },
      ],
    },
  });
  runtime.receive("thread", "ask");
  const send = vi.fn(async (turnId: string, _replies: readonly CodexAsyncQuestionReply[]) => ({
    turnId,
  }));
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
        {overlay}
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
    expect(view.send.mock.calls[0]?.[1]).toContainEqual(
      expect.objectContaining({ answer: "Global" }),
    );
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
    await interact(() =>
      fireEvent.keyDown(editor, { key: "Escape", isComposing: true, keyCode: 229 }),
    );
    expect(view.getByRole("group", { name: "Agent question" })).toBeTruthy();
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
    expect(view.send.mock.calls[0]?.[1]).not.toContainEqual(
      expect.objectContaining({ question: "What name?" }),
    );
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
    expect(view.send.mock.calls[0]?.[1]).toContainEqual(
      expect.objectContaining({ answer: "Local" }),
    );
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
      expect(view.send.mock.calls[0]?.[1]).toContainEqual(
        expect.objectContaining({ answer: "Global" }),
      );
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  test.each(["tooltip", "hover card"] as const)(
    "Escape dismisses an active %s before the question",
    async (kind) => {
      const overlay =
        kind === "tooltip" ? (
          <NodexTooltip defaultOpen tooltipContent="Question help">
            <button type="button">Help</button>
          </NodexTooltip>
        ) : (
          <NodexHoverCard defaultOpen ariaLabel="Question help" hoverCardContent="Question help">
            <button type="button">Help</button>
          </NodexHoverCard>
        );
      const view = setup(undefined, overlay);
      const panel = view.getByRole("group", { name: "Agent question" });
      await view.findByText("Question help");
      await interact(() => {
        panel.focus();
        fireEvent.keyDown(panel, { key: "Escape" });
      });
      await waitFor(() => expect(view.queryByText("Question help")).toBeNull());
      expect(view.getByRole("group", { name: "Agent question" })).toBe(panel);
      await interact(() => fireEvent.keyDown(panel, { key: "Escape" }));
      await waitFor(() => expect(view.queryByRole("group", { name: "Agent question" })).toBeNull());
      expect(view.send).not.toHaveBeenCalled();
    },
  );

  test.each(["hidden", "inert"] as const)(
    "a %s background popup cannot intercept question shortcuts",
    async (attribute) => {
      const view = setup(
        undefined,
        <div {...{ [attribute]: true }}>
          <div role="listbox" data-state="open" data-slot="popover-content" data-open="">
            Background options
          </div>
        </div>,
      );
      const panel = view.getByRole("group", { name: "Agent question" });
      await interact(() => fireEvent.keyDown(panel, { key: "ArrowUp" }));
      expect(view.getByRole("radio", { name: "Global" }).getAttribute("aria-checked")).toBe("true");
      await interact(() => fireEvent.keyDown(panel, { key: "Escape" }));
      expect(view.queryByRole("group", { name: "Agent question" })).toBeNull();
      expect(view.send).not.toHaveBeenCalled();
    },
  );

  test("an active dialog retains keyboard ownership before the question resumes", async () => {
    const view = setup(
      undefined,
      <NodexDialog defaultOpen>
        <NodexDialogContent>
          <NodexDialogTitle>Question details</NodexDialogTitle>
          <input aria-label="Dialog input" />
        </NodexDialogContent>
      </NodexDialog>,
    );
    const panel = view.getByRole("group", { name: "Agent question", hidden: true });
    const input = await view.findByRole("textbox", { name: "Dialog input" });
    await interact(() => fireEvent.keyDown(panel, { key: "ArrowUp" }));
    expect(Object.values(view.runtime.read("thread").questions)[0]?.draft).toBe("");
    await interact(() => fireEvent.keyDown(input, { key: "Escape" }));
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Question details" })).toBeNull(),
    );
    expect(view.getByRole("group", { name: "Agent question" })).toBe(panel);
    await interact(() => fireEvent.keyDown(panel, { key: "Escape" }));
    expect(view.queryByRole("group", { name: "Agent question" })).toBeNull();
  });

  test("the rich editor dismisses its mention suggestions before Escape closes the question", async () => {
    const view = setup([{ title: "What name?", options: [] }]);
    const editor = view.getByLabelText("Reply…");
    await paste(editor, "@");
    await view.findByLabelText("Files");
    await interact(() => fireEvent.keyDown(editor, { key: "Escape" }));
    await waitFor(() => expect(view.queryByLabelText("Files")).toBeNull());
    expect(view.getByRole("group", { name: "Agent question" })).toBeTruthy();
    expect(editor.textContent).toBe("@");
    await interact(() => fireEvent.keyDown(editor, { key: "Escape" }));
    expect(view.queryByRole("group", { name: "Agent question" })).toBeNull();
    expect(view.send).not.toHaveBeenCalled();
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
