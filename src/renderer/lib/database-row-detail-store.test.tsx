import { useLayoutEffect } from "react";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import {
  getDatabaseRowDetail,
  fenceDatabaseRowDetailsForProject,
  resetDatabaseRowDetailStoreForTests,
  revokeDatabaseRowDetail,
  setDatabaseRowDetail,
  setDatabaseRowDetails,
  useDatabaseRowDetail,
} from "./database-row-detail-store";
import type { DatabasePage } from "./types";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";

function buildCard(overrides: Partial<DatabasePage> = {}): DatabasePage {
  const title = overrides.title ?? "Persisted title";
  return {
    id: "card-1",
    status: "doing",
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    description: "Persisted body",
    tags: [],
    created: new Date("2026-01-01T00:00:00.000Z"),
    order: 1,
    revision: 1,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
  };
}

function DetailHarness() {
  const detail = useDatabaseRowDetail("project-1", "card-1");
  return (
    <span data-testid="detail-state">
      {detail.loading ? "loading" : (detail.error ?? detail.card?.title ?? "empty")}
    </span>
  );
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("card detail store", () => {
  beforeEach(() => {
    resetDatabaseRowDetailStoreForTests();
  });

  test("isolates opaque Project and Page identities during a Project fence", () => {
    setDatabaseRowDetail("project:a", buildCard({ id: "page", title: "First" }));
    setDatabaseRowDetail("project", buildCard({ id: "a:page", title: "Second" }));

    fenceDatabaseRowDetailsForProject("project:a");

    expect(getDatabaseRowDetail("project:a", "page")).toBe(null);
    expect(getDatabaseRowDetail("project", "a:page")?.title).toBe("Second");
  });

  test("does not overwrite or emit for older single-card detail replies", async () => {
    const newerCard = buildCard({
      title: "Newer title",
      description: "Newer body",
      revision: 3,
    });
    const olderCard = buildCard({
      title: "Older title",
      description: "Older body",
      revision: 2,
    });
    setDatabaseRowDetail("project-1", newerCard);

    let renderCount = 0;
    function RenderCountHarness() {
      useLayoutEffect(() => {
        renderCount += 1;
      });
      const detail = useDatabaseRowDetail("project-1", "card-1");
      return <span data-testid="detail-title">{detail.card?.title ?? "empty"}</span>;
    }

    const view = render(<RenderCountHarness />);
    expect(view.getByTestId("detail-title").textContent).toBe("Newer title");
    expect(renderCount).toBe(1);

    await act(async () => {
      setDatabaseRowDetail("project-1", olderCard);
      await Promise.resolve();
    });

    expect(getDatabaseRowDetail("project-1", "card-1") === newerCard).toBe(true);
    expect(view.getByTestId("detail-title").textContent).toBe("Newer title");
    expect(renderCount).toBe(1);
    view.unmount();
  });

  test("does not overwrite or emit for same-revision batch hydration", async () => {
    const cachedCard = buildCard({
      title: "Cached title",
      description: "Cached body",
      revision: 5,
    });
    const sameRevisionReply = buildCard({
      title: "Reply title",
      description: "Reply body",
      revision: 5,
    });
    setDatabaseRowDetail("project-1", cachedCard);

    let renderCount = 0;
    function RenderCountHarness() {
      useLayoutEffect(() => {
        renderCount += 1;
      });
      const detail = useDatabaseRowDetail("project-1", "card-1");
      return <span data-testid="detail-title">{detail.card?.title ?? "empty"}</span>;
    }

    const view = render(<RenderCountHarness />);
    expect(view.getByTestId("detail-title").textContent).toBe("Cached title");
    expect(renderCount).toBe(1);

    await act(async () => {
      setDatabaseRowDetails("project-1", [sameRevisionReply]);
      await Promise.resolve();
    });

    expect(getDatabaseRowDetail("project-1", "card-1") === cachedCard).toBe(true);
    expect(view.getByTestId("detail-title").textContent).toBe("Cached title");
    expect(renderCount).toBe(1);
    view.unmount();
  });

  test("only notifies subscribers for the changed card detail key", async () => {
    setDatabaseRowDetail(
      "project-1",
      buildCard({
        id: "card-1",
        title: "First title",
        revision: 1,
      }),
    );
    setDatabaseRowDetail(
      "project-1",
      buildCard({
        id: "card-2",
        title: "Second title",
        revision: 1,
      }),
    );

    let firstRenderCount = 0;
    let secondRenderCount = 0;
    function FirstHarness() {
      useLayoutEffect(() => {
        firstRenderCount += 1;
      });
      const detail = useDatabaseRowDetail("project-1", "card-1");
      return <span data-testid="first-title">{detail.card?.title ?? "empty"}</span>;
    }
    function SecondHarness() {
      useLayoutEffect(() => {
        secondRenderCount += 1;
      });
      const detail = useDatabaseRowDetail("project-1", "card-2");
      return <span data-testid="second-title">{detail.card?.title ?? "empty"}</span>;
    }

    const view = render(
      <>
        <FirstHarness />
        <SecondHarness />
      </>,
    );
    expect(view.getByTestId("first-title").textContent).toBe("First title");
    expect(view.getByTestId("second-title").textContent).toBe("Second title");
    expect(firstRenderCount).toBe(1);
    expect(secondRenderCount).toBe(1);

    await act(async () => {
      setDatabaseRowDetail(
        "project-1",
        buildCard({
          id: "card-1",
          title: "Updated first title",
          revision: 2,
        }),
      );
      await Promise.resolve();
    });

    expect(view.getByTestId("first-title").textContent).toBe("Updated first title");
    expect(view.getByTestId("second-title").textContent).toBe("Second title");
    expect(firstRenderCount).toBe(2);
    expect(secondRenderCount).toBe(1);
    view.unmount();
  });

  test("refetches cached detail when the requested revision is newer", async () => {
    let calls = 0;
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel !== "database-row:get") {
          throw new Error(`Unexpected channel: ${channel}`);
        }
        calls += 1;
        return buildCard({
          title: "Fresh title",
          description: "Fresh body",
          revision: 2,
        });
      },
      on: () => () => {},
    });

    setDatabaseRowDetail(
      "project-1",
      buildCard({
        title: "Cached title",
        description: "Cached body",
        revision: 1,
      }),
    );

    function RevisionHarness() {
      const detail = useDatabaseRowDetail("project-1", "card-1", "doing", 2);
      return <span data-testid="detail-title">{detail.card?.title ?? "empty"}</span>;
    }

    const view = render(<RevisionHarness />);
    expect(view.getByTestId("detail-title").textContent).toBe("Cached title");

    await waitFor(() => {
      expect(view.getByTestId("detail-title").textContent).toBe("Fresh title");
    });

    expect(calls).toBe(1);
    expect(getDatabaseRowDetail("project-1", "card-1")?.revision).toBe(2);
    view.unmount();
  });

  test("does not retry continuously after a card detail miss", async () => {
    let calls = 0;
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel !== "database-row:get") {
          throw new Error(`Unexpected channel: ${channel}`);
        }
        calls += 1;
        return null;
      },
      on: () => () => {},
    });

    const view = render(<DetailHarness />);

    await waitFor(() => {
      expect(view.getByTestId("detail-state").textContent).toBe("Page not found");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(1);
  });

  test("evicts a revoked row immediately and fences an older in-flight read", async () => {
    const staleRead = deferred<DatabasePage>();
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel !== "database-row:get") {
          throw new Error(`Unexpected channel: ${channel}`);
        }
        return await staleRead.promise;
      },
      on: () => () => {},
    });
    const view = render(<DetailHarness />);
    await waitFor(() => {
      expect(view.getByTestId("detail-state").textContent).toBe("loading");
    });

    await act(async () => {
      revokeDatabaseRowDetail("project-1", "card-1");
      await Promise.resolve();
    });
    expect(view.getByTestId("detail-state").textContent).toBe("Page not found");

    await act(async () => {
      staleRead.resolve(buildCard({ title: "Stale title" }));
      await staleRead.promise;
    });
    expect(view.getByTestId("detail-state").textContent).toBe("Page not found");
  });
});
