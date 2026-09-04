import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "../../globals.css";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createSurfaceHistory } from "@/lib/surface-history/owner";
import { NodexModalHost } from "@/lib/modal-registry";
import { SurfaceHistoryStatus } from "./surface-history-status";

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

test("Check again confirms the existing request and clears the waiting notice", async () => {
  await page.viewport(560, 300);
  const { history, requests, content } = recoveringHistory();
  await history.execute(1).result;
  const view = renderWithAppMaitai(<SurfaceHistoryStatus controls={history} />);
  try {
    await page.screenshot({
      element: view.container,
      path: "../../../../runs.local/history-regression-artifacts/recovery-notice.png",
    });
    expect(view.getByRole("status").textContent).toContain("Confirming the last action.");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Check again" }));
      await history.whenIdle();
    });
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
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
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset history" }));
      await Promise.resolve();
    });
    const title = await view.findByRole("heading", { name: "Reset this surface’s history?" });
    await page.viewport(560, 400);
    await page.screenshot({
      path: "../../../../runs.local/history-regression-artifacts/reset-history-confirmation.png",
    });
    await act(async () => {
      fireEvent.pointerDown(title);
      await Promise.resolve();
    });
    expect(parentPointer).not.toHaveBeenCalled();
    view.rerender(layout(false));
    expect(view.getByRole("heading", { name: "Reset this surface’s history?" })).toBeTruthy();
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
    expect(view.getByRole("status").textContent).toBe(
      "Move Pages · This Project no longer has permission to edit these Pages.",
    );
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.queryByRole("button", { name: "Check again" })).toBeNull();
    await page.screenshot({
      element: view.container,
      path: "../../../../runs.local/history-regression-artifacts/permission-denied-history.png",
    });
    await act(async () => {
      expect((await history.request("undo").result).status).toBe("blocked");
      fireEvent.click(view.getByRole("button", { name: "Reset history" }));
      await Promise.resolve();
    });
    await view.findByRole("heading", { name: "Reset this surface’s history?" });
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
