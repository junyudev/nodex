import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useSyncExternalStore, type ComponentProps } from "react";
import "../../globals.css";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createSurfaceHistory } from "@/lib/surface-history/owner";
import { createContentHistoryIssueSource } from "@/lib/content-history-issues";
import type { ContentEditIssueSource } from "@/lib/content-edit-issues";
import { parseDatabaseViewId } from "../../../shared/database-identities";
import { NodexModalHost } from "@/lib/modal-registry";
import { ContentIssuesControlView } from "./content-issues-control";
import { ContentSaveStatus } from "./content-save-status";

const scope = {
  libraryId: "library",
  accessContext: { kind: "project" as const, projectId: "project" },
  storeEpoch: "epoch",
};
function Issues({
  source,
  openLocation,
}: {
  readonly source: ContentEditIssueSource;
  readonly openLocation?: ComponentProps<typeof ContentIssuesControlView>["onOpenLocation"];
}) {
  const issues = useSyncExternalStore(source.subscribe, source.getIssues);
  return (
    <ContentIssuesControlView
      issues={issues}
      projects={[{ id: "project", name: "Research" }]}
      onOpenLocation={openLocation}
    />
  );
}
async function click(
  view: ReturnType<typeof renderWithAppMaitai>,
  name: string | RegExp,
  role: "button" | "menuitem" = "button",
) {
  await act(async () => {
    fireEvent.click(view.getByRole(role, { name }));
    await Promise.resolve();
  });
}
async function openClearConfirmation(view: ReturnType<typeof renderWithAppMaitai>) {
  await click(view, /^More actions for /);
  await click(view, "Clear undo history…", "menuitem");
}
function recoveringHistory(retryGate?: Promise<void>) {
  const requests: number[] = [];
  let content = 0;
  const history = createSurfaceHistory({
    scopeKey: "surface",
    adapter: {
      describe: () => "Move Pages",
      locate: () => ({
        target: { kind: "view", viewId: parseDatabaseViewId("tasks") },
        label: "Tasks",
      }),
      prepare: async (request: number) => ({ kind: "submit", request }),
      prepareInverse: async (request: number) => ({ kind: "submit", request }),
      submit: async (request: number) => {
        requests.push(request);
        if (requests.length === 1) {
          content++;
          return { kind: "unknown", reason: "The reply was lost." };
        }
        await retryGate;
        return { kind: "committed", receipt: request };
      },
      interpret: (receipt: number) => ({ kind: "reversible", inverse: -receipt }),
    },
  });
  return {
    history,
    source: createContentHistoryIssueSource(scope, history),
    requests,
    content: () => content,
  };
}

test("ordinary save progress stays local and never moves the content", async () => {
  let activity = { pending: 0, acknowledged: 0, unknown: 0 };
  const listeners = new Set<() => void>();
  const source = {
    getActivity: () => activity,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const view = renderWithAppMaitai(
    <>
      <ContentIssuesControlView issues={[]} />
      <main aria-label="Database view" style={{ position: "relative", height: 200 }}>
        <p>Pages</p>
        <ContentSaveStatus source={source} />
      </main>
    </>,
  );
  const content = view.getByRole("main");
  const original = content.getBoundingClientRect().toJSON();
  try {
    expect(view.queryByRole("button", { name: "Content issues" })).toBeNull();
    await act(async () => {
      activity = { pending: 1, acknowledged: 0, unknown: 0 };
      listeners.forEach((listener) => listener());
    });
    expect(view.queryByRole("status")).toBeNull();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Saving…"), {
      timeout: 2000,
    });
    await act(async () => {
      activity = { pending: 0, acknowledged: 1, unknown: 0 };
      listeners.forEach((listener) => listener());
    });
    expect(view.getByRole("status").textContent).toBe("Changes saved. Updating view…");
    expect(content.getBoundingClientRect().toJSON()).toEqual(original);
    await act(async () => {
      activity = { pending: 0, acknowledged: 0, unknown: 0 };
      listeners.forEach((listener) => listener());
    });
    expect(view.queryByRole("status")).toBeNull();
  } finally {
    view.unmount();
  }
});

test("an issue locates its original View and confirms the existing request exactly once", async () => {
  await page.viewport(560, 360);
  let completeRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    completeRetry = resolve;
  });
  const { history, source, requests, content } = recoveringHistory(retryGate);
  await history.execute(1).result;
  const openLocation = vi.fn();
  const view = renderWithAppMaitai(<Issues source={source} openLocation={openLocation} />);
  try {
    await click(view, "Content issues");
    await click(view, "Open Tasks in Research");
    expect(openLocation).toHaveBeenCalledExactlyOnceWith(scope, {
      target: { kind: "view", viewId: parseDatabaseViewId("tasks") },
      label: "Tasks",
    });
    await click(view, "Content issues");
    await page.screenshot({
      path: "../../../../runs.local/history-regression-artifacts/content-issues-recovery.png",
    });
    await click(view, "Check again");
    await waitFor(() => expect(view.getByRole("button", { name: "Check again" })).toBeDisabled());
    expect(view.getByRole("button", { name: "Check again" })).toHaveAttribute("aria-busy", "true");
    expect(requests).toEqual([1, 1]);
    await click(view, "Check again");
    expect(requests).toEqual([1, 1]);
    await act(async () => completeRetry());
    await waitFor(() => expect(view.queryByRole("button", { name: "Content issues" })).toBeNull());
    expect(requests).toEqual([1, 1]);
    expect(content()).toBe(1);
    expect(history.snapshot().undo.status).toBe("ready");
  } finally {
    view.unmount();
    history.close();
  }
});

test("clear confirmation survives its trigger and changes no content", async () => {
  const { history, source, content } = recoveringHistory();
  await history.execute(1).result;
  const parentPointer = vi.fn();
  const layout = (show: boolean) => (
    <>
      <section onPointerDown={parentPointer}>{show ? <Issues source={source} /> : null}</section>
      <NodexModalHost />
    </>
  );
  const view = renderWithAppMaitai(layout(true));
  try {
    await click(view, "Content issues");
    await openClearConfirmation(view);
    const title = await view.findByRole("heading", { name: "Clear undo history?" });
    await act(async () => {
      fireEvent.pointerDown(title);
      await Promise.resolve();
    });
    expect(parentPointer).not.toHaveBeenCalled();
    view.rerender(layout(false));
    expect(view.getByRole("dialog")).toBeTruthy();
    await page.screenshot({
      path: "../../../../runs.local/history-regression-artifacts/clear-history-confirmation.png",
    });
    await click(view, "Clear undo history");
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(history.snapshot().undo.status).toBe("empty");
    expect(content()).toBe(1);
  } finally {
    view.unmount();
    history.close();
  }
});

test("a late clear confirmation cannot discard newer edits", async () => {
  const { history, source } = recoveringHistory();
  await history.execute(1).result;
  const view = renderWithAppMaitai(
    <>
      <Issues source={source} />
      <NodexModalHost />
    </>,
  );
  try {
    await click(view, "Content issues");
    await openClearConfirmation(view);
    await view.findByRole("dialog");
    await act(async () => {
      await history.recover().result;
      await history.execute(2).result;
    });
    await click(view, "Clear undo history");
    expect(await view.findByRole("alert")).toHaveTextContent("The content history changed");
    expect(history.snapshot().undo.status).toBe("ready");
    await click(view, "Cancel");
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  } finally {
    view.unmount();
    history.close();
  }
});

test("permission-denied undo preserves content and offers no ineffective retry", async () => {
  let denied = false;
  let content = 0;
  const history = createSurfaceHistory({
    scopeKey: "permission",
    adapter: {
      describe: () => "Move Pages",
      prepare: async (request: number) => ({ kind: "submit", request }),
      prepareInverse: async (request: number) => ({ kind: "submit", request }),
      submit: async (request: number) => {
        if (denied)
          return {
            kind: "rejected",
            reason: "This Project no longer has permission to edit these Pages.",
            retryable: false,
          };
        content += request;
        return { kind: "committed", receipt: request };
      },
      interpret: (receipt: number) => ({ kind: "reversible", inverse: -receipt }),
    },
  });
  await history.execute(1).result;
  denied = true;
  await history.request("undo").result;
  const source = createContentHistoryIssueSource(scope, history);
  const view = renderWithAppMaitai(<Issues source={source} />);
  try {
    await click(view, "Content issues");
    expect(view.queryByRole("button", { name: /Retry|Check again/ })).toBeNull();
    expect(view.queryByRole("menuitem", { name: "Clear undo history…" })).toBeNull();
    await click(view, /^More actions for /);
    expect(view.getByRole("menuitem", { name: "Clear undo history…" })).toBeTruthy();
    await act(async () => {
      expect((await history.request("undo").result).status).toBe("blocked");
    });
    expect(content).toBe(1);
  } finally {
    view.unmount();
    history.close();
  }
});
