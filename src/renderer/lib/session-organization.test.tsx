import { act, waitFor, renderHook } from "@testing-library/react";
import { expect, test, vi, describe, afterEach } from "vite-plus/test";
import { render } from "../test/dom";
import {
  useSessionLinkedPage,
  type SessionLinkedPage,
  type SessionLinkedPageStore,
} from "./session-linked-page";
import { useCanonicalOrderHandoff } from "./use-canonical-order-handoff";
import type { Project } from "./types";
import { useTabs } from "./use-tabs";

describe("session linked page", () => {
  test("works without a Query provider, skips null IDs, and observes an injected keyed store", async () => {
    let value: SessionLinkedPage | null = null;
    const listeners = new Set<() => void>();
    const subscribeSession = vi.fn((_sessionId: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const read = vi.fn(() => value);
    const store: SessionLinkedPageStore = { read, subscribeSession };
    function Row({ sessionId }: { sessionId: string | null }) {
      const page = useSessionLinkedPage(sessionId, store);
      return <span>{page?.status?.label ?? "No Page"}</span>;
    }
    const view = render(<Row sessionId={null} />);
    expect(subscribeSession).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    view.rerender(<Row sessionId="session:a" />);
    expect(subscribeSession).toHaveBeenCalledWith("session:a", expect.any(Function));
    await act(async () => {
      value = {
        pageId: "page:a",
        pageKey: null,
        title: "A",
        status: { optionId: "doing", label: "In progress" },
      };
      for (const listener of listeners) listener();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText("In progress")).toBeTruthy());
    view.rerender(<Row sessionId={null} />);
    expect(listeners.size).toBe(0);
  });
});

describe("use canonical order handoff", () => {
  test("keeps an acknowledged order until canonical input changes and drops obsolete overlays", async () => {
    const reportError = vi.fn();
    const { result, rerender } = renderHook(
      ({ canonicalIds }) => useCanonicalOrderHandoff({ canonicalIds, reportError }),
      { initialProps: { canonicalIds: ["a", "b"] } },
    );
    await act(async () => result.current.submit(["b", "a"], () => Promise.resolve()));
    expect(result.current.displayedIds).toEqual(["b", "a"]);
    rerender({ canonicalIds: ["a", "b"] });
    expect(result.current.displayedIds).toEqual(["b", "a"]);
    rerender({ canonicalIds: ["b", "a"] });
    rerender({ canonicalIds: ["a", "b"] });
    expect(result.current.displayedIds).toEqual(["a", "b"]);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("use tabs", () => {
  const project = (id: string) => ({ id }) as Project;
  afterEach(() => {
    localStorage.removeItem("nodex-tabs");
    localStorage.removeItem("nodex-project");
    window.history.replaceState(null, "", "/");
  });

  test("initializes loaded Projects and selects a surviving tab when its active Project is removed", async () => {
    const { result, rerender } = renderHook(({ projects }) => useTabs(projects), {
      initialProps: { projects: [] as Project[] },
    });
    const first = project("first");
    const second = project("second");
    rerender({ projects: [first, second] });
    expect(result.current.activeTab?.projectId).toBe("first");
    await act(async () => result.current.openTab(second.id));
    expect(result.current.activeTab?.projectId).toBe("second");
    rerender({ projects: [first] });
    expect(result.current.tabs.map((tab) => tab.projectId)).toEqual([first.id]);
    expect(result.current.activeTab?.projectId).toBe(first.id);
    rerender({ projects: [second] });
    expect(result.current.tabs.map((tab) => tab.projectId)).toEqual([second.id]);
    expect(result.current.activeTab?.projectId).toBe(second.id);
  });
});
