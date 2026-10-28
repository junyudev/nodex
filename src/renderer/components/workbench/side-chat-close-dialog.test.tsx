import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { NodexModalHost, openModal } from "@/lib/modal-registry";
import { SideChatCloseDialog } from "./side-chat-close-dialog";

test("keeps side-chat confirmation outside its tab trigger and alive after the trigger leaves", async () => {
  const parentPointer = vi.fn();
  const confirm = vi.fn();
  function Trigger() {
    const app = useScopeHandle(appScope);
    return (
      <button onClick={() => openModal(app, SideChatCloseDialog, { onConfirm: confirm })}>
        Close tab
      </button>
    );
  }
  function Subject() {
    const [mounted, setMounted] = useState(true);
    return (
      <>
        <div onPointerDown={parentPointer}>{mounted ? <Trigger /> : null}</div>
        <button onClick={() => setMounted(false)}>Remove trigger</button>
        <NodexModalHost />
      </>
    );
  }
  const screen = renderWithAppMaitai(<Subject />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await Promise.resolve();
  });
  const title = await screen.findByText("Close side chat?");
  await act(async () => {
    fireEvent.pointerDown(title);
    await Promise.resolve();
  });
  expect(parentPointer).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Remove trigger", hidden: true }));
    await Promise.resolve();
  });
  expect(screen.queryByRole("button", { name: "Close tab", hidden: true })).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("checkbox", { name: "Don’t ask again" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close side chat" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(confirm).toHaveBeenCalledExactlyOnceWith(true);
});
