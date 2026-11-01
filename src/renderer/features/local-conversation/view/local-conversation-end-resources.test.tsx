import { fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { openNodexMenu, render, settleAsyncRender } from "@/test/dom";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";
import { LocalConversationEndResources } from "./local-conversation-end-resources";
import type { ThreadOutputOpenInItem } from "./use-thread-output-opener";

const ports = vi.hoisted(() => ({
  openFromEvent: vi.fn(async (..._args: unknown[]) => true),
  openContextMenu: vi.fn(),
  menuItems: [] as ThreadOutputOpenInItem[],
  load: vi.fn(async () => undefined),
  browserAvailable: true,
  openLinkInTarget: "external-browser" as "in-app-browser" | "external-browser",
}));

vi.mock("./use-thread-output-opener", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-thread-output-opener")>()),
  useThreadOutputOpener: () => ({
    open: vi.fn(),
    openFromEvent: ports.openFromEvent,
    openContextMenu: ports.openContextMenu,
    getOpenInMenu: vi.fn(),
    preview: null,
  }),
  useThreadOutputOpenInMenu: () => ({
    items: ports.menuItems,
    isLoading: false,
    error: null,
    load: ports.load,
  }),
}));
vi.mock("@/lib/web-link-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-link-navigation")>()),
  useLinkOpening: () => ({ browserAvailable: ports.browserAvailable, openLink: vi.fn() }),
}));
vi.mock("@/lib/link-opening-settings", () => ({
  useLinkOpeningSettings: () => ({
    settings: {
      openLinkInTarget: ports.openLinkInTarget,
      openLocalUrlInTarget: "in-app-browser",
      externalBrowserLinkShortcut: "primary",
    },
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings: vi.fn(),
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  ports.menuItems = [];
  ports.openLinkInTarget = "external-browser";
});

function file(path: string): ThreadSummaryPanelOutputRow {
  const label = path.slice(path.lastIndexOf("/") + 1);
  return { id: `file:${path}`, kind: "file", path, label, title: path };
}

const website: ThreadSummaryPanelOutputRow = {
  id: "website:https://example.com/launch",
  kind: "website",
  target: "https://example.com/launch",
  label: "example.com/launch",
  title: "https://example.com/launch",
};

const pdfs = (count: number) =>
  Array.from({ length: count }, (_, index) => file(`/workspace/out/result-${index}.pdf`));

describe("turn output cards", () => {
  test("show four outputs without an expansion control", () => {
    render(<LocalConversationEndResources resources={pdfs(4)} hostId="local" cwd="/workspace" />);
    expect(screen.getAllByRole("button", { name: /^Open result-\d\.pdf$/u })).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /^Show/u })).toBeNull();
  });

  test("show three of five and reveal the rest once", async () => {
    render(<LocalConversationEndResources resources={pdfs(5)} hostId="local" cwd="/workspace" />);
    expect(screen.getAllByRole("button", { name: /^Open result-\d\.pdf$/u })).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
      await settleAsyncRender();
    });
    expect(screen.getAllByRole("button", { name: /^Open result-\d\.pdf$/u })).toHaveLength(5);
  });

  test("name a generic entry file by its folder and say a file opens as a preview", () => {
    const view = render(
      <LocalConversationEndResources
        resources={[file("/workspace/notes.local/artifacts/new-tab-page/report/index.html")]}
        hostId="local"
        cwd="/workspace"
      />,
    );
    expect(screen.getByRole("button", { name: "Open report/index.html" })).toBeTruthy();
    const rest = view.container.querySelector("[data-card-detail=rest]");
    const hover = view.container.querySelector("[data-card-detail=hover]");
    expect(rest?.textContent).toBe("HTML·notes.local/artifacts/new-tab-page");
    expect(hover?.textContent).toBe("Open preview");
  });

  test("say where a web output goes under the current destination", () => {
    const external = render(<LocalConversationEndResources resources={[website]} hostId="local" />);
    expect(external.container.querySelector("[data-card-detail=hover]")?.textContent).toBe(
      "Open in default browser",
    );
    external.unmount();
    ports.openLinkInTarget = "in-app-browser";
    const internal = render(<LocalConversationEndResources resources={[website]} hostId="local" />);
    expect(internal.container.querySelector("[data-card-detail=hover]")?.textContent).toBe("Open");
  });

  test("hand the click with its modifiers to the output's opener", async () => {
    render(<LocalConversationEndResources resources={[website]} hostId="local" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open example.com/launch" }), {
        metaKey: true,
      });
      await settleAsyncRender();
    });
    expect(ports.openFromEvent).toHaveBeenCalledTimes(1);
    const [row, event] = ports.openFromEvent.mock.calls[0] ?? [];
    expect(row).toEqual(website);
    expect((event as { metaKey?: boolean }).metaKey).toBe(true);
  });

  test("list every destination when Open in opens, marking the system default", async () => {
    const openPreview = vi.fn(async () => true);
    const openPreviewApp = vi.fn(async () => true);
    ports.menuItems = [
      { id: "preview", kind: "preview", label: "Nodex", open: openPreview },
      {
        id: "application:/Applications/Preview.app",
        kind: "native",
        label: "Preview",
        isSystemDefault: true,
        open: openPreviewApp,
      },
      { id: "reveal", kind: "reveal", label: "Show in Finder", open: vi.fn(async () => true) },
      { id: "download", kind: "download", label: "Download a copy", open: vi.fn(async () => true) },
    ];
    render(
      <LocalConversationEndResources
        resources={[file("/workspace/out/brief.pdf")]}
        hostId="local"
        cwd="/workspace"
      />,
    );
    await openNodexMenu(screen.getByRole("button", { name: "Open brief.pdf in" }));
    expect(ports.load).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Nodex",
      "Preview (Default)",
      "Show in Finder",
      "Download a copy",
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Preview (Default)" }));
      await settleAsyncRender();
    });
    expect(openPreviewApp).toHaveBeenCalledTimes(1);
    expect(ports.openFromEvent).not.toHaveBeenCalled();
  });

  test("offer the file or link menu on right-click and from the keyboard", async () => {
    render(
      <LocalConversationEndResources
        resources={[file("/workspace/notes.md")]}
        hostId="local"
        cwd="/workspace"
      />,
    );
    const card = screen.getByRole("button", { name: "Open notes.md" });
    await act(async () => {
      fireEvent.contextMenu(card);
      fireEvent.keyDown(card, { key: "F10", shiftKey: true });
      await settleAsyncRender();
    });
    expect(ports.openContextMenu).toHaveBeenCalledTimes(2);
  });
});
