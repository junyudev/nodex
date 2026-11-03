import { act, useSyncExternalStore } from "react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { useNfmPageMentionCreateFlow } from "./nfm-page-mention-create-flow";

const state = vi.hoisted(() => {
  let pending: string | null = "suggestion-1";
  const listeners = new Set<() => void>();
  const lease = {
    sessionId: "suggestion-1",
    blockId: "block-1",
    expectedContent: [{ type: "text", text: "child", styles: {} }],
    replacementContent: [{ type: "text", text: "replacement", styles: {} }],
    rollback: vi.fn(),
    commit: vi.fn(() => true),
  };
  return {
    lease,
    host: { hostPageId: "page-1", createPageMention: vi.fn(async () => ({ pageId: "new-page" })) },
    editor: { focus: vi.fn(), getExtension: () => ({ beginDeferredAcceptance: () => lease }) },
    getSnapshot: () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPending: (next: string | null) => {
      pending = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@blocknote/react", () => ({
  useBlockNoteEditor: () => state.editor,
  useExtensionState: () => useSyncExternalStore(state.subscribe, state.getSnapshot),
}));
vi.mock("@/components/block-documents/block-reference-runtime-context", () => ({
  useBlockReferenceHostRuntime: () => state.host,
}));
vi.mock("./nfm-move-to-menu", () => ({
  NfmMoveToMenu: () => <div role="dialog" aria-label="Destination" />,
}));

function Probe() {
  const flow = useNfmPageMentionCreateFlow({ activeProjectId: "project-1" });
  return (
    <>
      <button onClick={() => flow.buildCreateItems("child")[1]?.onItemClick()}>
        Choose parent
      </button>
      <button onClick={() => flow.buildCreateItems("child")[0]?.onItemClick()}>Create here</button>
      {flow.destinationMenu}
    </>
  );
}

describe("Page mention creation flow", () => {
  test("revokes an orphaned destination without replaying its rollback on rerender", async () => {
    state.setPending("suggestion-1");
    state.lease.rollback.mockClear();
    const view = render(<Probe />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose parent" }));
    });
    expect(view.getByRole("dialog", { name: "Destination" })).toBeTruthy();
    await act(async () => {
      state.setPending(null);
    });
    expect(view.queryByRole("dialog", { name: "Destination" })).toBeNull();
    expect(state.lease.rollback).toHaveBeenCalledExactlyOnceWith("parent-suggestion-ended");
    await act(async () => {
      view.rerender(<Probe />);
    });
    expect(state.lease.rollback).toHaveBeenCalledTimes(1);
  });
  test("rolls back when a created Page cannot commit its exact suggestion lease", async () => {
    state.setPending("suggestion-1");
    state.lease.rollback.mockClear();
    state.lease.commit.mockReturnValueOnce(false);
    const view = render(<Probe />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create here" }));
      await Promise.resolve();
    });
    expect(state.lease.rollback).toHaveBeenCalledExactlyOnceWith("create-page-failed");
    expect(state.editor.focus).toHaveBeenCalled();
  });
});
