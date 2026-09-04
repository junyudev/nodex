import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { LibraryCatalogEntry } from "../../../shared/library-module";
import { AUTHORIZED_READ_STAMP_EXAMPLE } from "../../../shared/testing/authorized-read-stamp-example";
import { PagesTabPicker, type PagesTabPickerDataSource } from "./pages-tab-picker";
import { WorkbenchPanelNewTabButton } from "./workbench-panel-new-tab-button";

const page: LibraryCatalogEntry = {
  target: { kind: "page", pageId: "page:one" },
  title: "Page One",
  kind: "page",
  lifecycle: "active",
  locationLabel: "Pages",
  updatedAt: "2026-08-04T00:00:00.000Z",
  locationRevision: 1,
  metadataRevision: 1,
};

const dataSource = {
  useCatalog: () => ({
    data: {
      pages: [
        {
          kind: "catalog" as const,
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          commitSeq: 1,
          authorization: AUTHORIZED_READ_STAMP_EXAMPLE,
          items: [page],
          nextCursor: null,
          hasMore: false,
          total: 1,
        },
      ],
      pageParams: [undefined],
    },
    isPending: false,
    isError: false,
    hasNextPage: false,
    refetch: async () => ({}) as never,
    fetchNextPage: async () => ({}) as never,
  }),
  useCreateCommands: () => ({
    isPending: false,
    createPage: async () => undefined,
    createDatabase: async () => undefined,
  }),
} satisfies PagesTabPickerDataSource;

describe("PagesTabPicker", () => {
  test("opens the plus picker and accepts a catalog resource by keyboard", async () => {
    const onOpenTarget = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PagesTabPicker dataSource={dataSource} onOpenTarget={onOpenTarget} />
      </QueryClientProvider>,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Open Page, Database, or Canvas",
        }),
      );
      await Promise.resolve();
    });
    const input = await screen.findByRole("combobox", { name: "Search Pages" });
    expect(screen.getByRole("option", { name: /Page One/ })).toBeDefined();
    expect(screen.getByRole("button", { name: "New Page" })).toBeDefined();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    expect(onOpenTarget).toHaveBeenCalledWith(page.target, "Page One");
  });

  test("closes with Escape and bounds pasted catalog queries", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PagesTabPicker dataSource={dataSource} onOpenTarget={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Open Page, Database, or Canvas",
        }),
      );
      await Promise.resolve();
    });
    const input = await screen.findByRole("combobox", { name: "Search Pages" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "x".repeat(300) } });
      await Promise.resolve();
    });
    expect((input as HTMLInputElement).value).toHaveLength(256);

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("dialog", {
        name: "Open Page, Database, or Canvas",
      }),
    ).toBeNull();
  });

  test("keeps the keyboard-active option visible while navigating", async () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const secondPage = {
      ...page,
      target: { kind: "page" as const, pageId: "page:two" },
      title: "Page Two",
    };
    const multiDataSource = {
      ...dataSource,
      useCatalog: () => ({
        ...dataSource.useCatalog(),
        data: {
          ...dataSource.useCatalog().data!,
          pages: [
            {
              ...dataSource.useCatalog().data!.pages[0]!,
              items: [page, secondPage],
              total: 2,
            },
          ],
        },
      }),
    } satisfies PagesTabPickerDataSource;

    try {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <PagesTabPicker dataSource={multiDataSource} onOpenTarget={() => undefined} />
        </QueryClientProvider>,
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Open Page, Database, or Canvas",
          }),
        );
        await Promise.resolve();
      });
      const input = await screen.findByRole("combobox", { name: "Search Pages" });
      scrollIntoView.mockClear();
      await act(async () => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({
          block: "nearest",
        }),
      );
      expect(input.getAttribute("aria-activedescendant")).toContain("option-1");
    } finally {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  test("does not render a generic plus trigger for an empty action set", () => {
    render(
      <WorkbenchPanelNewTabButton
        actions={[]}
        projects={[]}
        panelId="right"
        currentProjectId={null}
        currentProjectDbViewExists={false}
        isMac={false}
        onAction={() => undefined}
        onOpenDestination={() => undefined}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});
