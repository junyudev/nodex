import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useSyncExternalStore } from "react";
import "../../globals.css";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createSurfaceHistory } from "@/lib/surface-history/owner";
import { NodexModalHost } from "@/lib/modal-registry";
import { ContentHistoryControl, ContentHistoryControlView } from "./surface-history-status";
import { acquireContentInteractionHistory } from "@/lib/content-interaction-history";
import type { SurfaceHistoryControls } from "@/lib/surface-history/controls";

function SurfaceHistoryStatus({ controls }: { readonly controls: SurfaceHistoryControls }) {
  const snapshot = useSyncExternalStore(controls.subscribe, controls.snapshot);
  return (
    <ContentHistoryControlView
      entries={[
        {
          controls,
          snapshot,
          scope: {
            libraryId: "library",
            accessContext: { kind: "library" },
            storeEpoch: "epoch",
          },
        },
      ]}
    />
  );
}

async function openDetails(view: ReturnType<typeof renderWithAppMaitai>) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Content edits" }));
    await Promise.resolve();
  });
}

function recoveringHistory() {
  const requests: number[] = [];
  let content = 0;
  const history = createSurfaceHistory({
    scopeKey: "surface",
    adapter: {
      describe: () => "Move Pages",
      prepare: async (intent: number) => ({ kind: "submit", request: intent }),
      prepareInverse: async (inverse: number) => ({ kind: "submit", request: inverse }),
      submit: async (request: number) => {
        requests.push(request);
        if (requests.length === 1) {
          content++;
          return { kind: "unknown" as const, reason: "Confirming the last action." };
        }
        return { kind: "committed" as const, receipt: request };
      },
      interpret: (receipt: number) => ({ kind: "reversible", inverse: -receipt }),
    },
  });
  return { history, requests, content: () => content };
}

test("a shared window entry stays silent for short actions and never moves content during long waits", async () => {
  let finish: ((value: { kind: "committed"; receipt: number }) => void) | undefined;
  const history = createSurfaceHistory({
    scopeKey: "layout",
    adapter: {
      describe: () => "Move Pages",
      prepare: async (request: number) => ({ kind: "submit", request }),
      prepareInverse: async (request: number) => ({ kind: "submit", request }),
      submit: () =>
        new Promise<{ kind: "committed"; receipt: number }>((resolve) => {
          finish = resolve;
        }),
      interpret: (receipt: number) => ({ kind: "reversible", inverse: -receipt }),
    },
  });
  const view = renderWithAppMaitai(
    <>
      <header>
        <SurfaceHistoryStatus controls={history} />
      </header>
      <main aria-label="Database view">Pages</main>
    </>,
  );
  const trigger = view.getByRole("button", { name: "Content edits" });
  const content = view.getByRole("main", { name: "Database view" });
  const original = content.getBoundingClientRect().toJSON();
  const triggerBounds = trigger.getBoundingClientRect().toJSON();
  try {
    await act(async () => {
      history.execute(1);
      await Promise.resolve();
    });
    expect(view.getByRole("status").textContent).toBe("");
    expect(history.snapshot().undo.recoveryActions).toEqual([]);
    await act(async () => {
      finish?.({ kind: "committed", receipt: 1 });
      await history.whenIdle();
    });
    expect(view.getByRole("status").textContent).toBe("");
    await act(async () => {
      history.execute(2);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Saving content edits"), {
      timeout: 2000,
    });
    expect(content.getBoundingClientRect().toJSON()).toEqual(original);
    expect(trigger.getBoundingClientRect().toJSON()).toEqual(triggerBounds);
    await openDetails(view);
    expect(view.queryByRole("button", { name: "Reset history" })).toBeNull();
    await act(async () => {
      finish?.({ kind: "committed", receipt: 2 });
      await history.whenIdle();
    });
    expect(content.getBoundingClientRect().toJSON()).toEqual(original);
  } finally {
    view.unmount();
    history.close();
  }
});

test("multiple retained Page and Database participants share one observed entry", async () => {
  const scope = {
    libraryId: "window-library",
    accessContext: { kind: "library" as const },
    storeEpoch: "epoch",
  };
  const pageLease = acquireContentInteractionHistory(scope);
  const databaseLease = acquireContentInteractionHistory(scope);
  const view = renderWithAppMaitai(<ContentHistoryControl />);
  try {
    expect(pageLease.history).toBe(databaseLease.history);
    expect(view.getAllByRole("button", { name: "Content edits" })).toHaveLength(1);
    await act(async () => {
      pageLease.release();
      databaseLease.release();
    });
    expect(view.getAllByRole("button", { name: "Content edits" })).toHaveLength(1);
    await openDetails(view);
    expect(view.getByText("No actions need attention.")).toBeTruthy();
  } finally {
    view.unmount();
    pageLease.release();
    databaseLease.release();
  }
});

test("acknowledged projection work reports view catch-up without implying an uncommitted edit", async () => {
  const view = renderWithAppMaitai(
    <ContentHistoryControlView
      entries={[]}
      projections={[
        {
          scope: { libraryId: "library", accessContext: { kind: "library" }, storeEpoch: "epoch" },
          id: "tasks",
          label: "Tasks",
          activity: { pending: 0, acknowledged: 1, unknown: 0 },
        },
      ]}
    />,
  );
  try {
    expect(view.getByRole("status").textContent).toBe("");
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Updating views"), {
      timeout: 2000,
    });
    await openDetails(view);
    expect(view.getByText("Tasks · Changes saved. Updating the view.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Reset history" })).toBeNull();
    expect(view.queryByRole("button", { name: "Check again" })).toBeNull();
  } finally {
    view.unmount();
  }
});

test("Check again confirms the existing request and clears the waiting notice", async () => {
  await page.viewport(560, 300);
  const { history, requests, content } = recoveringHistory();
  await history.execute(1).result;
  const view = renderWithAppMaitai(<SurfaceHistoryStatus controls={history} />);
  try {
    expect(view.getByRole("status").textContent).toBe("Content edits need attention");
    await openDetails(view);
    expect(view.getByText("Move Pages · Confirming the last action.")).toBeTruthy();
    await act(async () => {
      await page.screenshot({
        path: "../../../../runs.local/history-regression-artifacts/content-edits-recovery.png",
      });
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Check again" }));
      await history.whenIdle();
    });
    await waitFor(() => expect(view.getByRole("status").textContent).toBe(""));
    expect(requests).toEqual([1, 1]);
    expect(content()).toBe(1);
    expect(history.snapshot().undo.status).toBe("ready");
  } finally {
    view.unmount();
    history.close();
  }
});

test("reset confirmation escapes its trigger and clears history without changing content", async () => {
  const { history, content } = recoveringHistory();
  await history.execute(1).result;
  const parentPointer = vi.fn();
  const layout = (show: boolean) => (
    <>
      <section onPointerDown={parentPointer}>
        {show ? <SurfaceHistoryStatus controls={history} /> : null}
      </section>
      <NodexModalHost />
    </>
  );
  const view = renderWithAppMaitai(layout(true));
  try {
    await openDetails(view);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset history" }));
      await Promise.resolve();
    });
    const title = await view.findByRole("heading", { name: "Reset content history?" });
    await act(async () => {
      await page.viewport(560, 400);
      await page.screenshot({
        path: "../../../../runs.local/history-regression-artifacts/reset-history-confirmation.png",
      });
    });
    await act(async () => {
      fireEvent.pointerDown(title);
      await Promise.resolve();
    });
    expect(parentPointer).not.toHaveBeenCalled();
    view.rerender(layout(false));
    expect(view.getByRole("heading", { name: "Reset content history?" })).toBeTruthy();
    expect(history.snapshot().undo.status).toBe("waiting");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset history" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(history.snapshot().undo.status).toBe("empty");
    expect(history.snapshot().redo.status).toBe("empty");
    expect(content()).toBe(1);
  } finally {
    view.unmount();
    history.close();
  }
});

test("denied history offers reset without retrying or revealing an older edit", async () => {
  await page.viewport(560, 300);
  let content = 0;
  let denied = false;
  const history = createSurfaceHistory({
    scopeKey: "permission-boundary",
    adapter: {
      describe: () => "Move Pages",
      prepare: async (intent: number) => ({ kind: "submit", request: intent }),
      prepareInverse: async (inverse: number) => ({ kind: "submit", request: inverse }),
      submit: async (request: number) => {
        if (denied)
          return {
            kind: "rejected" as const,
            reason: "This Project no longer has permission to edit these Pages.",
            retryable: false,
          };
        content += request;
        return { kind: "committed" as const, receipt: request };
      },
      interpret: (receipt: number) => ({ kind: "reversible", inverse: -receipt }),
    },
  });
  await history.execute(1).result;
  await history.execute(2).result;
  denied = true;
  await history.request("undo").result;
  const view = renderWithAppMaitai(
    <>
      <SurfaceHistoryStatus controls={history} />
      <NodexModalHost />
    </>,
  );
  try {
    await openDetails(view);
    expect(
      view.getByText("Move Pages · This Project no longer has permission to edit these Pages."),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.queryByRole("button", { name: "Check again" })).toBeNull();
    await act(async () => {
      await page.screenshot({
        element: view.container,
        path: "../../../../runs.local/history-regression-artifacts/permission-denied-history.png",
      });
    });
    await act(async () => {
      expect((await history.request("undo").result).status).toBe("blocked");
      fireEvent.click(view.getByRole("button", { name: "Reset history" }));
      await Promise.resolve();
    });
    await view.findByRole("heading", { name: "Reset content history?" });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(content).toBe(3);
    expect(history.snapshot().undo.status).toBe("blocked");
  } finally {
    view.unmount();
    history.close();
  }
});
