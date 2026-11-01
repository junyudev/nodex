import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { PageFileHtmlAdmissionResult } from "../../../shared/page-file-html";
import { PageFileHtmlView, type PageFileHtmlViewProps } from "./page-file-html-view";

const adapter = vi.hoisted(() => ({ admit: vi.fn(), release: vi.fn(async () => true) }));
vi.mock("./page-file-html-adapter", () => ({ pageFileHtmlAdapter: adapter }));
const props: PageFileHtmlViewProps = {
  routingContext: { kind: "library" },
  pageId: "page",
  fileId: "file",
  logicalPath: "profile/report.html",
  colorScheme: "light",
  reloadKey: "1",
};
const admitted = (grant: string): PageFileHtmlAdmissionResult => ({
  status: "admitted",
  admission: {
    grant,
    url: `nodex-page-file://${grant}/profile/report.html`,
    partition: `nodex-page-file:${grant}`,
  },
});
beforeEach(() => {
  adapter.admit.mockReset();
  adapter.release.mockClear();
});
afterEach(cleanup);

test("admits, reports ready, and releases the exact guest on reload and unmount", async () => {
  adapter.admit.mockResolvedValueOnce(admitted("first")).mockResolvedValueOnce(admitted("next"));
  const state = vi.fn();
  const view = render(<PageFileHtmlView {...props} onStateChange={state} />);
  await waitFor(() => expect(view.container.querySelector("webview")).not.toBeNull());
  const first = view.container.querySelector("webview")!;
  expect(first.getAttribute("src")).toBe("nodex-page-file://first/profile/report.html");
  expect(state).toHaveBeenLastCalledWith({ status: "loading" });
  await act(async () => {
    first.dispatchEvent(new Event("did-finish-load"));
    await Promise.resolve();
  });
  expect(state).toHaveBeenLastCalledWith({ status: "ready" });
  view.rerender(<PageFileHtmlView {...props} reloadKey="2" onStateChange={state} />);
  await waitFor(() =>
    expect(view.container.querySelector("webview")?.getAttribute("src")).toContain("//next/"),
  );
  expect(adapter.release).toHaveBeenCalledWith("first");
  view.unmount();
  expect(adapter.release).toHaveBeenCalledWith("next");
  expect(adapter.admit).toHaveBeenCalledTimes(2);
});

test("releases a stale admission without mounting it or reporting ready", async () => {
  let complete!: (result: PageFileHtmlAdmissionResult) => void;
  adapter.admit
    .mockReturnValueOnce(
      new Promise<PageFileHtmlAdmissionResult>((resolve) => {
        complete = resolve;
      }),
    )
    .mockResolvedValueOnce(admitted("current"));
  const state = vi.fn();
  const view = render(<PageFileHtmlView {...props} onStateChange={state} />);
  view.rerender(<PageFileHtmlView {...props} reloadKey="2" onStateChange={state} />);
  await waitFor(() => expect(view.container.querySelectorAll("webview")).toHaveLength(1));
  await act(async () => {
    complete(admitted("stale"));
    await Promise.resolve();
  });
  expect(adapter.release).toHaveBeenCalledWith("stale");
  expect(view.container.querySelectorAll("webview")).toHaveLength(1);
  expect(view.container.querySelector("webview")?.getAttribute("src")).toContain("//current/");
  expect(state).not.toHaveBeenCalledWith({ status: "ready" });
});

test("reports refused admission and load failures through the wrapper's state callback", async () => {
  const state = vi.fn();
  adapter.admit
    .mockResolvedValueOnce({ status: "refused", message: "The File is gone" })
    .mockResolvedValueOnce(admitted("second"));
  const view = render(<PageFileHtmlView {...props} onStateChange={state} />);
  await waitFor(() =>
    expect(state).toHaveBeenLastCalledWith({ status: "error", message: "The File is gone" }),
  );
  expect(view.container.querySelector("webview")).toBeNull();
  view.rerender(<PageFileHtmlView {...props} reloadKey="2" onStateChange={state} />);
  await waitFor(() => expect(view.container.querySelector("webview")).not.toBeNull());
  await act(async () => {
    view.container.querySelector("webview")!.dispatchEvent(
      Object.assign(new Event("did-fail-load"), {
        isMainFrame: true,
        errorDescription: "File unavailable",
      }),
    );
    await Promise.resolve();
  });
  expect(state).toHaveBeenLastCalledWith({ status: "error", message: "File unavailable" });
});
