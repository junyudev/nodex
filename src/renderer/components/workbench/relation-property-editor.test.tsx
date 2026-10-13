import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { act } from "react";
import { render } from "../../test/dom";
import { RelationPropertyEditor } from "../database/relation-property-editor";
import {
  readRelationValuePreview,
  type RelationCandidateWindow,
  type RelationTargetWindow,
} from "@/lib/data-source-relation-value";

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
    restricted_count: 1,
    has_more: true,
  },
};

describe("RelationPropertyEditor", () => {
  test("projects bounded visible and restricted targets without inventing identities", () => {
    expect(readRelationValuePreview(relationValue)).toEqual({
      valueRevision: 4,
      totalCount: 2,
      targets: [
        {
          kind: "visible",
          edgeId: "a".repeat(64),
          pageId: "page-visible",
          title: "Visible task",
          lifecycle: "active",
          membershipState: "active_in_target_source",
        },
      ],
      restrictedCount: 1,
      hasMore: true,
    });
    expect(
      readRelationValuePreview({
        kind: "relation",
        value: { ...relationValue.value, targets: [{ kind: "restricted", page_id: "leak" }] },
      }),
    ).toBeNull();
  });

  test("emits patch-set intent for visible removal and candidate addition", async () => {
    const onPatch = vi.fn();
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={relationValue}
        candidates={[
          { pageId: "page-visible", title: "Visible task" },
          { pageId: "page-candidate", title: "Candidate task" },
        ]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={onPatch}
        onClear={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Remove Visible task" }));
      fireEvent.click(view.getByRole("option", { name: "Candidate task" }));
      await Promise.resolve();
    });

    expect(onPatch).toHaveBeenNthCalledWith(1, {
      addPageIds: [],
      removeEdgeIds: ["a".repeat(64)],
    });
    expect(onPatch).toHaveBeenNthCalledWith(2, {
      addPageIds: ["page-candidate"],
      removeEdgeIds: [],
    });
    expect(view.getByText("1 restricted")).toBeTruthy();
  });

  test("replaces a cardinality-one Parent and excludes the source Page", async () => {
    const onReplace = vi.fn();
    const view = render(
      <RelationPropertyEditor
        label="Parent"
        value={null}
        candidates={[
          { pageId: "page:child", title: "Current task" },
          { pageId: "page:parent", title: "Parent task" },
        ]}
        cardinality="one"
        excludedPageId="page:child"
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onReplace={onReplace}
        onClear={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Parent relation" }));
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Current task" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Parent task" }));
      await Promise.resolve();
    });

    expect(onReplace).toHaveBeenCalledWith("page:parent");
    expect(view.queryByRole("option", { name: "Parent task" })).toBeNull();
  });

  test("removes a restricted target by its source-owned edge handle", async () => {
    const onPatch = vi.fn();
    const hiddenEdgeId = "b".repeat(64);
    const onLoadMore = vi.fn(async () => ({
      valueRevision: 4,
      totalCount: 2,
      targets: [
        {
          kind: "restricted" as const,
          edgeId: hiddenEdgeId,
        },
      ],
      nextCursor: null,
      projectionRevision: 8,
    }));
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
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
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText("Restricted page")).toBeTruthy());
    expect(view.queryByText("page-hidden")).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Remove restricted page 1" }));
      await Promise.resolve();
    });

    expect(onPatch).toHaveBeenCalledWith({
      addPageIds: [],
      removeEdgeIds: [hiddenEdgeId],
    });
  });

  test("requires explicit confirmation before clearing restricted targets", async () => {
    const onClear = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={onClear}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear all…" }));
      await Promise.resolve();
    });

    expect(
      view.getByText("Clear all 2 relations, including restricted or unloaded pages?"),
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
      label: "Blocked by",
      candidates: [],
      disabled: false,
      targetMatchesCurrentSource: true,
      onPatch: vi.fn(),
      onClear: vi.fn(),
      onLoadMore,
    } as const;
    const view = render(<RelationPropertyEditor {...props} value={relationValue} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
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
            restricted_count: 0,
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
        label="Blocked by"
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
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    const search = view.getByRole("combobox", { name: "Search Blocked by target pages" });
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

  test("hides previous results as soon as the user changes the query", async () => {
    const onPatch = vi.fn();
    const onSearchCandidates = vi.fn(async (query: string) => {
      if (query === "old") {
        return {
          candidates: [{ pageId: "old", title: "Old result" }],
          nextCursor: null,
          projectionRevision: 1,
        };
      }
      return await new Promise<never>(() => undefined);
    });
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={null}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource={false}
        onPatch={onPatch}
        onClear={vi.fn()}
        onSearchCandidates={onSearchCandidates}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    const search = view.getByRole("combobox", { name: "Search Blocked by target pages" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "old" } });
      await Promise.resolve();
    });
    expect(await view.findByRole("option", { name: "Old result" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(search, { target: { value: "new" } });
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Old result" })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onPatch).not.toHaveBeenCalled();
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
        label="Blocked by"
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
        fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
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

  test("retains selected pages after a failed window read and retries the same authority", async () => {
    const expectedReadError = new Error("databaseModuleReadV2.read selected transport detail");
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (args[0] === "[relation-property:selected]" && args[1] === expectedReadError) return;
      originalConsoleError(...args);
    });
    const onLoadMore = vi
      .fn<(after: string | null) => Promise<RelationTargetWindow>>()
      .mockRejectedValueOnce(expectedReadError)
      .mockResolvedValueOnce({
        valueRevision: 4,
        totalCount: 2,
        targets: [
          {
            kind: "visible",
            edgeId: "a".repeat(64),
            pageId: "page-visible",
            title: "Visible task",
            lifecycle: "active",
            membershipState: "active_in_target_source",
          },
          {
            kind: "visible",
            edgeId: "b".repeat(64),
            pageId: "page-recovered",
            title: "Recovered selected page",
            lifecycle: "active",
            membershipState: "active_in_target_source",
          },
        ],
        nextCursor: null,
        projectionRevision: 2,
      });
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={relationValue}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource={true}
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onLoadMore={onLoadMore}
      />,
    );

    try {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Load more selected" }));
        await Promise.resolve();
      });
      const retry = await view.findByRole("button", {
        name: "Couldn’t load selected pages. Retry",
      });
      expect(view.getByRole("button", { name: "Remove Visible task" })).toBeTruthy();
      expect(view.queryByText(/databaseModuleReadV2/)).toBeNull();

      await act(async () => {
        fireEvent.click(retry);
        await Promise.resolve();
      });
      await view.findByRole("button", { name: "Remove Recovered selected page" });
      expect(
        view.queryByRole("button", { name: "Couldn’t load selected pages. Retry" }),
      ).toBeNull();
      expect(onLoadMore.mock.calls).toEqual([[null], [null]]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("treats an absent sparse value as Empty instead of corrupt", async () => {
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={undefined}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const trigger = view.getByRole("button", { name: "Edit Blocked by relation" });
    expect(trigger.textContent).toBe("Empty");
    expect(trigger.querySelector("svg")).toBeNull();
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    expect(view.getByRole("combobox", { name: "Search Blocked by target pages" })).toBeTruthy();
  });

  test("rejects a target window from another value revision and requests authority refresh", async () => {
    const onValueStale = vi.fn();
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
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
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
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
        label="Blocked by"
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
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
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

  test("silently replaces an expired candidate cursor from a fresh first window", async () => {
    let request = 0;
    const onSearchCandidates = vi.fn(async (_query: string, after?: string | null) => {
      request += 1;
      if (request === 2) throw new Error(`opaque cursor rejected: ${after}`);
      return {
        candidates: [
          {
            pageId: request === 1 ? "page-first" : "page-refreshed",
            title: request === 1 ? "First candidate" : "Refreshed candidate",
          },
        ],
        nextCursor: request === 1 ? "next" : null,
        projectionRevision: request === 1 ? 1 : 2,
      };
    });
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={null}
        candidates={[]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={vi.fn()}
        onClear={vi.fn()}
        onSearchCandidates={onSearchCandidates}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("option", { name: "First candidate" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByRole("option", { name: "Refreshed candidate" })).toBeTruthy(),
    );
    expect(view.queryByRole("option", { name: "First candidate" })).toBeNull();
    expect(view.queryByText(/opaque cursor rejected/)).toBeNull();
    expect(onSearchCandidates.mock.calls.map(([, after]) => after)).toEqual([null, "next", null]);
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
        label="Blocked by"
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
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
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
      label: "Blocked by",
      value: null,
      candidates: [{ pageId: "candidate", title: "Candidate" }],
      disabled: false,
      targetMatchesCurrentSource: true,
      onPatch,
      onClear: vi.fn(),
    } as const;
    const view = render(<RelationPropertyEditor {...props} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Candidate" }));
      await Promise.resolve();
    });
    view.rerender(<RelationPropertyEditor {...props} pending />);
    expect(view.getByRole("combobox", { name: "Search Blocked by target pages" })).toBeTruthy();
    expect((view.getByRole("option", { name: "Candidate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onPatch).toHaveBeenCalledOnce();
  });

  test("adds the active candidate from the search combobox keyboard", async () => {
    const onPatch = vi.fn();
    const view = render(
      <RelationPropertyEditor
        label="Blocked by"
        value={null}
        candidates={[
          { pageId: "first", title: "First" },
          { pageId: "second", title: "Second" },
        ]}
        disabled={false}
        targetMatchesCurrentSource
        onPatch={onPatch}
        onClear={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Blocked by relation" }));
      await Promise.resolve();
    });
    const search = view.getByRole("combobox", { name: "Search Blocked by target pages" });
    await act(async () => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onPatch).toHaveBeenCalledWith({
      addPageIds: ["second"],
      removeEdgeIds: [],
    });
  });
});
