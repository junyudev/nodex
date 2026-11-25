import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { act } from "react";
import { render } from "../../test/dom";
import { RelationPropertyEditor } from "../database/relation-property-editor";
import { type RelationCandidateWindow } from "@/lib/data-source-relation-value";

const relationValue = {
  kind: "relation",
  value: {
    value_revision: 4,
    total_count: 2,
    targets: [
      {
        kind: "visible",
        edge_id: "a".repeat(64),
        page_id: "page-visible",
        title: "Visible task",
        lifecycle: "active",
        membership_state: "active_in_target_source",
      },
    ],
    unavailable_count: 1,
    has_more: true,
  },
};

describe("RelationPropertyEditor", () => {
  test("removes a unavailable target by its source-owned edge handle", async () => {
    const onPatch = vi.fn();
    const hiddenEdgeId = "b".repeat(64);
    const onLoadMore = vi.fn(async () => ({
      valueRevision: 4,
      totalCount: 2,
      targets: [
        {
          kind: "unavailable" as const,
          edgeId: hiddenEdgeId,
        },
      ],
      nextCursor: null,
      projectionRevision: 8,
    }));
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={onPatch}
        onClear={vi.fn()}
        onLoadMore={onLoadMore}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText("Unavailable page")).toBeTruthy());
    expect(view.queryByText("page-hidden")).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Remove unavailable page 1" }));
      await Promise.resolve();
    });

    expect(onPatch).toHaveBeenCalledWith({
      addPageIds: [],
      removeEdgeIds: [hiddenEdgeId],
    });
  });

  test("requires explicit confirmation before clearing unavailable targets", async () => {
    const onClear = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={onClear}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear all…" }));
      await Promise.resolve();
    });

    expect(
      view.getByText("Clear all 2 relations, including unavailable or unloaded pages?"),
    ).toBeTruthy();
    expect(onClear).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear all" }));
      await Promise.resolve();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(onClear).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  test("drops stale continuation results when the value revision changes", async () => {
    let resolveLoad:
      | ((value: {
          readonly targets: readonly [
            {
              readonly kind: "visible";
              readonly edgeId: string;
              readonly pageId: string;
              readonly title: string;
              readonly lifecycle: string;
              readonly membershipState: string;
            },
          ];
          readonly nextCursor: null;
          readonly valueRevision: 4;
          readonly totalCount: 2;
          readonly projectionRevision: 1;
        }) => void)
      | undefined;
    const onLoadMore = vi.fn(
      () =>
        new Promise<{
          readonly targets: readonly [
            {
              readonly kind: "visible";
              readonly edgeId: string;
              readonly pageId: string;
              readonly title: string;
              readonly lifecycle: string;
              readonly membershipState: string;
            },
          ];
          readonly nextCursor: null;
          readonly valueRevision: 4;
          readonly totalCount: 2;
          readonly projectionRevision: 1;
        }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const props = {
      label: "Waits for",
      candidates: [],
      disabled: false,
      targetMatchesCurrentSource: true,
      onPatch: vi.fn(),
      onClear: vi.fn(),
      onLoadMore,
    } as const;
    const view = render(<RelationPropertyEditor {...props} value={relationValue} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    view.rerender(
      <RelationPropertyEditor
        {...props}
        value={{
          kind: "relation",
          value: {
            value_revision: 5,
            total_count: 1,
            targets: [],
            unavailable_count: 0,
            has_more: true,
          },
        }}
      />,
    );
    expect(view.getByRole("button", { name: "Load more selected" })).toBeTruthy();
    await act(async () => {
      resolveLoad?.({
        valueRevision: 4,
        totalCount: 2,
        targets: [
          {
            kind: "visible",
            edgeId: "b".repeat(64),
            pageId: "page-stale",
            title: "Stale target",
            lifecycle: "active",
            membershipState: "active_in_target_source",
          },
        ],
        nextCursor: null,
        projectionRevision: 1,
      });
      await Promise.resolve();
    });

    expect(view.queryByText("Stale target")).toBeNull();
  });

  test("does not let a slower old search replace the latest query", async () => {
    const resolvers = new Map<
      string,
      (value: {
        candidates: readonly { readonly pageId: string; readonly title: string }[];
        nextCursor: null;
        projectionRevision: number;
      }) => void
    >();
    const onSearchCandidates = vi.fn((query: string) => {
      if (!query) {
        return Promise.resolve({ candidates: [], nextCursor: null, projectionRevision: 1 });
      }
      return new Promise<{
        candidates: readonly { readonly pageId: string; readonly title: string }[];
        nextCursor: null;
        projectionRevision: number;
      }>((resolve) => resolvers.set(query, resolve));
    });
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={null}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource={false}
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onSearchCandidates={onSearchCandidates}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    const search = view.getByRole("combobox", { name: "Search Waits for target pages" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "old" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(onSearchCandidates).toHaveBeenCalledWith("old", null));
    await act(async () => {
      fireEvent.change(search, { target: { value: "latest" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(onSearchCandidates).toHaveBeenCalledWith("latest", null));
    await act(async () => {
      resolvers.get("latest")?.({
        candidates: [{ pageId: "latest", title: "Latest result" }],
        nextCursor: null,
        projectionRevision: 3,
      });
      await Promise.resolve();
    });
    expect(view.getByRole("option", { name: "Latest result" })).toBeTruthy();
    await act(async () => {
      resolvers.get("old")?.({
        candidates: [{ pageId: "old", title: "Old result" }],
        nextCursor: null,
        projectionRevision: 2,
      });
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Old result" })).toBeNull();
    expect(view.getByRole("option", { name: "Latest result" })).toBeTruthy();
  });

  test("keeps candidate failures local, hides transport details, and retries", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const onSearchCandidates = vi.fn<
      (query: string, after?: string | null) => Promise<RelationCandidateWindow>
    >(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("databaseModuleReadV2.read.query leaked transport detail");
      }
      return {
        candidates: [{ pageId: "page-recovered", title: "Recovered page" }],
        nextCursor: null,
        projectionRevision: 2,
      };
    });
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={null}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource={false}
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onSearchCandidates={onSearchCandidates}
      />,
    );

    try {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
        await Promise.resolve();
      });
      const retry = await view.findByRole("button", { name: "Couldn’t load pages. Retry" });
      expect(view.queryByText(/databaseModuleReadV2/)).toBeNull();
      expect(view.queryByText("No pages found")).toBeNull();
      await act(async () => {
        fireEvent.click(retry);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(view.getByRole("option", { name: "Recovered page" })).toBeTruthy();
      });
      expect(onSearchCandidates.mock.calls.map(([query, after]) => [query, after])).toEqual([
        ["", null],
        ["", null],
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("rejects a target window from another value revision and requests authority refresh", async () => {
    const onValueStale = vi.fn();
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onValueStale={onValueStale}
        onLoadMore={async () => ({
          valueRevision: 5,
          totalCount: 1,
          targets: [
            {
              kind: "visible",
              edgeId: "b".repeat(64),
              pageId: "page-newer",
              title: "Newer target",
              lifecycle: "active",
              membershipState: "active_in_target_source",
            },
          ],
          nextCursor: null,
          projectionRevision: 2,
        })}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(onValueStale).toHaveBeenCalledOnce());
    expect(view.queryByText("Newer target")).toBeNull();
  });

  test("silently replaces an expired selected cursor from a fresh first window", async () => {
    let request = 0;
    const onLoadMore = vi.fn(async (after: string | null) => {
      request += 1;
      if (request === 2) throw new Error(`opaque cursor rejected: ${after}`);
      return {
        valueRevision: 4,
        totalCount: 2,
        targets: [
          {
            kind: "visible" as const,
            edgeId: `${request}`.padStart(64, "0"),
            pageId: request === 1 ? "page-first" : "page-refreshed",
            title: request === 1 ? "First page" : "Refreshed page",
            lifecycle: "active",
            membershipState: "active_in_target_source",
          },
        ],
        nextCursor: request === 1 ? "next" : null,
        projectionRevision: 3,
      };
    });
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onLoadMore={onLoadMore}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getAllByText("First page").length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getAllByText("Refreshed page").length).toBeGreaterThan(0));
    expect(view.queryByText(/opaque cursor rejected/)).toBeNull();
    expect(onLoadMore.mock.calls.map(([after]) => after)).toEqual([null, "next", null]);
  });

  test("never merges selected titles across privacy projection revisions", async () => {
    let request = 0;
    const onLoadMore = vi.fn(async () => {
      request += 1;
      const title =
        request === 1 ? "Old projection" : request === 2 ? "Must not leak" : "Refreshed projection";
      return {
        valueRevision: 4,
        totalCount: 1,
        targets: [
          {
            kind: "visible" as const,
            edgeId: `${request}`.padStart(64, "0"),
            pageId: `page-${request}`,
            title,
            lifecycle: "active",
            membershipState: "active_in_target_source",
          },
        ],
        nextCursor: request === 1 ? "next" : null,
        projectionRevision: request === 1 ? 1 : 2,
      };
    });
    const view = render(
      <RelationPropertyEditor
        label="Waits for"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onLoadMore={onLoadMore}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getAllByText("Old projection").length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getAllByText("Refreshed projection").length).toBeGreaterThan(0),
    );
    expect(view.queryByText("Old projection")).toBeNull();
    expect(view.queryByText("Must not leak")).toBeNull();
  });

  test("keeps the picker open while a Relation patch is pending", async () => {
    const onPatch = vi.fn();
    const props = {
      label: "Waits for",
      value: null,
      candidates: [{ pageId: "candidate", title: "Candidate" }],
      disabled: false,
      targetMatchesCurrentSource: true,
      onPatch,
      onClear: vi.fn(),
    } as const;
    const view = render(<RelationPropertyEditor {...props} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Candidate" }));
      await Promise.resolve();
    });
    view.rerender(<RelationPropertyEditor {...props} pending />);
    expect(view.getByRole("combobox", { name: "Search Waits for target pages" })).toBeTruthy();
    expect((view.getByRole("option", { name: "Candidate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onPatch).toHaveBeenCalledOnce();
  });
});
