import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
} from "@/components/ui/toast";
import { render } from "@/test/dom";
import { DatabaseViewPageContextMenu } from "./database-view-page-context-menu";
import { dataSourcePagePropertyMenuSourceFromBindings } from "@/components/database/data-source-page-property-menu-source";
import { DevelopmentFeaturesProvider } from "@/lib/development-features-context";

const mocks = vi.hoisted(() => ({
  loadPageDocumentMaterialization: vi.fn(),
  writeTextToClipboard: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  writeTextToClipboard: mocks.writeTextToClipboard,
}));

vi.mock("@/lib/page-prompt-context", () => ({
  loadPageDocumentMaterialization: mocks.loadPageDocumentMaterialization,
}));

vi.mock("@/components/board/editor/nfm-send-to-thread-menu", () => ({
  NfmSendToThreadMenu: ({
    onAccept,
  }: {
    readonly onAccept: (request: {
      readonly target: { readonly kind: "thread"; readonly threadId: string };
      readonly mode: "send";
    }) => Promise<void> | void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onAccept({
          target: { kind: "thread", threadId: "thread-1" },
          mode: "send",
        })
      }
    >
      Choose chat
    </button>
  ),
}));

const page = {
  libraryId: "library-1",
  accessContext: { kind: "project", projectId: "project-1" },
  projectId: "project-1",
  pageId: "page-1",
  pageKey: "LAB-13",
  titleSnapshot: "Release plan",
} as const;

function renderMenu(
  actionPort: Parameters<typeof DatabaseViewPageContextMenu>[0]["actionPort"] = {},
  pageTarget: Parameters<typeof DatabaseViewPageContextMenu>[0]["page"] = page,
  showReorder = false,
) {
  return render(
    <DevelopmentFeaturesProvider
      capabilities={{
        enabledDevelopmentFeatures: showReorder ? ["database-page-reorder-menu"] : [],
      }}
    >
      <DatabaseViewPageContextMenu
        page={pageTarget}
        canMoveUp
        canMoveDown
        propertySource={dataSourcePagePropertyMenuSourceFromBindings([])}
        actionPort={actionPort}
        onReorder={() => undefined}
      >
        <button type="button">Page target</button>
      </DatabaseViewPageContextMenu>
    </DevelopmentFeaturesProvider>,
  );
}

async function openMenu(screen: ReturnType<typeof renderMenu>): Promise<void> {
  await act(async () => {
    fireEvent.contextMenu(screen.getByRole("button", { name: "Page target" }), {
      clientX: 80,
      clientY: 60,
    });
    await Promise.resolve();
  });
  const search = await screen.findByRole("textbox", {
    name: "Search Page actions and properties",
  });
  await waitFor(() => expect(search).toBe(document.activeElement));
}

async function openSubmenu(
  screen: ReturnType<typeof renderMenu>,
  name: "Copy" | "Move" | "Open in",
): Promise<void> {
  await act(async () => {
    fireEvent.pointerMove(screen.getByRole("menuitem", { name }), {
      pointerType: "mouse",
    });
    await Promise.resolve();
  });
}

describe("DatabaseViewPageContextMenu", () => {
  beforeEach(() => {
    __resetNodexToastStoreForTests();
    mocks.writeTextToClipboard.mockReset().mockResolvedValue(true);
    mocks.loadPageDocumentMaterialization.mockReset().mockResolvedValue({
      title: "Release plan",
      nfm: "# Release\n\nShip it",
    });
  });

  test("wires direct and materialized Page copy requests", async () => {
    const screen = renderMenu();

    await openMenu(screen);
    await openSubmenu(screen, "Copy");
    const copyDeeplink = await screen.findByRole("menuitem", { name: "Copy deeplink" });
    await act(async () => {
      fireEvent.click(copyDeeplink);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.writeTextToClipboard).toHaveBeenLastCalledWith("nodex://pages/page-1"),
    );

    await openMenu(screen);
    await openSubmenu(screen, "Copy");
    const copyMarkdown = await screen.findByRole("menuitem", {
      name: "Copy content as Markdown",
    });
    await act(async () => {
      fireEvent.click(copyMarkdown);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.loadPageDocumentMaterialization).toHaveBeenCalledWith({
        accessContext: { kind: "project", projectId: "project-1" },
        pageId: "page-1",
      }),
    );
    await waitFor(() =>
      expect(mocks.writeTextToClipboard).toHaveBeenLastCalledWith("# Release\n\nShip it"),
    );
  });

  test("copies canonical Markdown through library access", async () => {
    const screen = renderMenu(
      {},
      {
        ...page,
        accessContext: { kind: "library" },
        projectId: null,
      },
    );

    await openMenu(screen);
    await openSubmenu(screen, "Copy");
    const copyMarkdown = await screen.findByRole("menuitem", {
      name: "Copy content as Markdown",
    });
    expect(copyMarkdown.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      fireEvent.click(copyMarkdown);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mocks.loadPageDocumentMaterialization).toHaveBeenCalledWith({
        accessContext: { kind: "library" },
        pageId: "page-1",
      }),
    );
    await waitFor(() =>
      expect(mocks.writeTextToClipboard).toHaveBeenLastCalledWith("# Release\n\nShip it"),
    );
  });

  test("reports clipboard failure through the shared toast surface", async () => {
    mocks.writeTextToClipboard.mockResolvedValue(false);
    const screen = renderMenu();

    await openMenu(screen);
    await openSubmenu(screen, "Copy");
    const copyTitle = await screen.findByRole("menuitem", { name: "Copy title" });
    await act(async () => {
      fireEvent.click(copyTitle);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        __getNodexToastSnapshotForTests().some(
          (item) => item.kind === "plain" && item.title === "Failed to copy title",
        ),
      ).toBe(true),
    );
  });

  test("hands Send to chat off after the context menu closes", async () => {
    const sendToChat = vi.fn(async () => undefined);
    const screen = renderMenu({ sendToChat });

    await openMenu(screen);
    await openSubmenu(screen, "Open in");
    const sendToChatItem = await screen.findByRole("menuitem", { name: "Send to chat…" });
    await act(async () => {
      fireEvent.click(sendToChatItem);
      await Promise.resolve();
    });
    const chooseChat = await screen.findByRole("button", { name: "Choose chat" });
    await act(async () => {
      fireEvent.click(chooseChat);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(sendToChat).toHaveBeenCalledWith({
        projectId: "project-1",
        pageId: "page-1",
        pageKey: "LAB-13",
        titleSnapshot: "Release plan",
        target: { kind: "thread", threadId: "thread-1" },
      }),
    );
  });

  test("reports failure when opening a Page in a new chat fails", async () => {
    const openInNewChat = vi.fn().mockRejectedValue(new Error("chat unavailable"));
    const screen = renderMenu({ openInNewChat });

    await openMenu(screen);
    await openSubmenu(screen, "Open in");
    const openInNewChatItem = await screen.findByRole("menuitem", {
      name: "Open in new chat",
    });
    await act(async () => {
      fireEvent.click(openInNewChatItem);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        __getNodexToastSnapshotForTests().some(
          (item) => item.kind === "plain" && item.title === "Failed to open Page in a new chat",
        ),
      ).toBe(true),
    );
  });

  test("keeps keyboard navigation across the submenu boundary", async () => {
    const screen = renderMenu({}, page, true);
    await openMenu(screen);
    const search = await screen.findByRole("textbox", {
      name: "Search Page actions and properties",
    });

    await act(async () => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(screen.getByRole("menuitem", { name: "Open in" })).toBe(document.activeElement);
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? search, { key: "ArrowDown" });
    });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Copy" })).toBe(document.activeElement),
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? search, { key: "ArrowDown" });
    });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Move to" })).toBe(document.activeElement),
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? search, { key: "ArrowDown" });
    });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Reorder" })).toBe(document.activeElement),
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? search, { key: "ArrowRight" });
      await Promise.resolve();
    });

    const reorderToTop = await screen.findByRole("menuitem", { name: "Reorder to top" });
    await waitFor(() => expect(reorderToTop).toBe(document.activeElement));
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? search, { key: "ArrowLeft" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Reorder to top" })).toBeNull(),
    );
    expect(screen.getByRole("menuitem", { name: "Reorder" })).toBe(document.activeElement);

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? search, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", {
          name: "Search Page actions and properties",
        }),
      ).toBeNull(),
    );
  });
});
