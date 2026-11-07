import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { installAsyncRequestAnimationFrame } from "@/test/browser-globals";
import { render, settleAsyncRender } from "@/test/dom";
import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
  NodexToastProvider,
  toast,
  useToaster,
} from "./toast";

function ToastHarness() {
  return (
    <NodexToastProvider>
      <div>Harness</div>
    </NodexToastProvider>
  );
}

async function show(emit: () => void) {
  await act(async () => {
    emit();
    await settleAsyncRender();
  });
}

describe("Nodex toast system", () => {
  beforeEach(() => {
    installAsyncRequestAnimationFrame();
    __resetNodexToastStoreForTests();
  });

  test("orders open toasts newest first", async () => {
    render(<ToastHarness />);

    await show(() => {
      toast.info("First toast", { duration: 0 });
      toast.success("Second toast", { duration: 0 });
    });

    expect(__getNodexToastSnapshotForTests().map((record) => record.title)).toEqual([
      "Second toast",
      "First toast",
    ]);
  });

  test("presents toasts raised before the viewport mounts", async () => {
    toast.info("Raised during startup", { duration: 0 });

    const view = render(<ToastHarness />);
    await settleAsyncRender();

    expect(await view.findByText("Raised during startup")).toBeTruthy();
  });

  test("returns working close handles and removes the toast after its exit", async () => {
    const view = render(<ToastHarness />);
    let handle!: { close: () => void };

    await show(() => {
      handle = toast.info("Closable toast", { duration: 0 });
    });
    expect(view.getByText("Closable toast")).toBeTruthy();

    await show(() => handle.close());

    expect(__getNodexToastSnapshotForTests()).toEqual([]);
    await waitFor(() => expect(view.queryByText("Closable toast")).toBeNull());
  });

  test("keeps sticky toasts open until they are explicitly closed", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.info("Sticky toast", { duration: 0 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(view.getByText("Sticky toast")).toBeTruthy();
  });

  test("closes a toast by itself after its duration", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.info("Short toast", { duration: 20 });
    });
    expect(view.getByText("Short toast")).toBeTruthy();

    await waitFor(() => expect(__getNodexToastSnapshotForTests()).toEqual([]));
    await waitFor(() => expect(view.queryByText("Short toast")).toBeNull());
  });

  test("replaces older toasts with the same logical id", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.info("Old sync state", { id: "sync", duration: 0 });
      toast.success("New sync state", { id: "sync", duration: 0 });
    });

    await waitFor(() => expect(view.queryByText("Old sync state")).toBeNull());
    expect(view.getByText("New sync state")).toBeTruthy();
    expect(__getNodexToastSnapshotForTests().map((record) => record.title)).toEqual([
      "New sync state",
    ]);
  });

  test("closes all open toasts", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.info("Toast A", { duration: 0 });
      toast.warning("Toast B", { duration: 0 });
    });
    await show(() => toast.closeAll());

    await waitFor(() => {
      expect(view.queryByText("Toast A")).toBeNull();
      expect(view.queryByText("Toast B")).toBeNull();
    });
  });

  test("announces title and description as an alert with a dismiss button", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.warning("Workspace warning", {
        description: "The checkout is behind origin/main.",
        duration: 0,
      });
    });

    const alert = view.getByRole("alert");
    expect(alert.textContent).toContain("Workspace warning");
    expect(alert.textContent).toContain("The checkout is behind origin/main.");

    fireEvent.click(view.getByRole("button", { name: "Dismiss notification" }));
    expect(__getNodexToastSnapshotForTests()).toEqual([]);
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  });

  test("shows a caller's leading content in place of the level icon", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.info("Archived chat", {
        duration: 0,
        leading: <span data-testid="leading" />,
      });
    });

    const alert = view.getByRole("alert");
    expect(view.getByTestId("leading")).toBeTruthy();
    // The only remaining glyph belongs to the dismiss button.
    expect(alert.querySelectorAll("svg").length).toBe(1);
  });

  test("dismisses the toast after an action succeeds", async () => {
    const view = render(<ToastHarness />);
    let restoreCalls = 0;

    await show(() => {
      toast.info("Page draft closed", {
        duration: 0,
        action: {
          label: "Restore",
          onClick: () => {
            restoreCalls += 1;
          },
        },
      });
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore" }));
      await settleAsyncRender();
    });

    expect(restoreCalls).toBe(1);
    await waitFor(() => expect(view.queryByText("Page draft closed")).toBeNull());
  });

  test("places the secondary action before the primary one", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.danger("Unable to transcribe audio", {
        duration: 0,
        action: { label: "Retry", onClick: () => undefined },
        secondaryAction: { label: "View recording", onClick: () => undefined },
      });
    });

    const labels = Array.from(view.getByRole("alert").querySelectorAll("button"))
      .map((button) => button.textContent)
      .filter(Boolean);
    expect(labels).toEqual(["View recording", "Retry"]);
  });

  test("lets an action keep its toast open when it returns false", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.info("Page draft closed", {
        duration: 0,
        action: { label: "Restore", onClick: () => false },
      });
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore" }));
      await settleAsyncRender();
    });

    expect(view.getByText("Page draft closed")).toBeTruthy();
    expect(__getNodexToastSnapshotForTests().length).toBe(1);
  });

  test("runs the newest open toast action from the keyboard command", async () => {
    const view = render(<ToastHarness />);
    const calls: string[] = [];

    await show(() => {
      toast.info("Older action", {
        duration: 0,
        action: { label: "Older", onClick: () => void calls.push("older") },
      });
      toast.info("Latest action", {
        duration: 0,
        action: { label: "Latest", onClick: () => void calls.push("latest") },
      });
    });

    await act(async () => {
      expect(toast.runLatestAction()).toBe(true);
      await settleAsyncRender();
    });

    expect(calls).toEqual(["latest"]);
    await waitFor(() => expect(view.queryByRole("button", { name: "Latest" })).toBeNull());
    expect(view.getByRole("button", { name: "Older" })).toBeTruthy();
  });

  test("hovering the stack holds a toast with actions but not a bare confirmation", async () => {
    const view = render(<ToastHarness />);

    await show(() => {
      toast.success("Saved", { duration: 30 });
      toast.info("Archived chat", {
        duration: 30,
        action: { label: "Undo", onClick: () => undefined },
      });
    });

    const stack = view.baseElement.querySelector("[data-sonner-toaster]");
    if (!stack) throw new Error("Expected the toast stack.");
    await act(async () => {
      fireEvent.mouseEnter(stack);
      fireEvent.mouseMove(stack);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(__getNodexToastSnapshotForTests().map((record) => record.title)).toEqual([
        "Archived chat",
      ]),
    );
  });

  test("exposes the shared controller through useToaster", async () => {
    function HookProbe() {
      const toaster = useToaster();
      return (
        <button type="button" onClick={() => void toaster.success("Hook toast", { duration: 0 })}>
          Emit hook toast
        </button>
      );
    }

    const view = render(
      <NodexToastProvider>
        <HookProbe />
      </NodexToastProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Emit hook toast" }));
      await settleAsyncRender();
    });

    expect(view.getByText("Hook toast")).toBeTruthy();
    expect(view.baseElement.querySelector('[data-slot="toast-viewport"]')).not.toBeNull();
  });
});
