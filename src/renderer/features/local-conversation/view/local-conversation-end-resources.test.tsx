import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { LocalConversationEndResources } from "./local-conversation-end-resources";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";

const ports = vi.hoisted(() => ({
  openFile: vi.fn(),
  openDefault: vi.fn(),
  fileMenu: vi.fn(async (_request: unknown) => undefined),
  webMenu: vi.fn(async (_request: unknown) => undefined),
}));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: ports.openFile }),
}));
vi.mock("@/lib/file-system-operations", () => ({
  openPathWithDefaultApplication: ports.openDefault,
}));
vi.mock("@/lib/file-reference-context-menu", () => ({
  openFileReferenceContextMenu: ports.fileMenu,
}));
vi.mock("@/lib/web-link-context-menu", () => ({ openWebLinkContextMenu: ports.webMenu }));
vi.mock("@/features/user-attachment-image-editor", () => ({
  ImagePreviewDialog: ({ alt }: { alt: string }) => <div role="dialog" aria-label={alt} />,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function file(path: string): ThreadSummaryPanelOutputRow {
  const label = path.slice(path.lastIndexOf("/") + 1);
  return { id: `file:${path}`, kind: "file", path, label, title: path };
}

const pdfs = (count: number) =>
  Array.from({ length: count }, (_, index) => file(`/workspace/out/result-${index}.pdf`));

describe("turn output cards", () => {
  test("show four outputs without an expansion control", () => {
    render(<LocalConversationEndResources resources={pdfs(4)} hostId="local" cwd="/workspace" />);
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });

  test("show three of five and reveal the rest once", async () => {
    render(<LocalConversationEndResources resources={pdfs(5)} hostId="local" cwd="/workspace" />);
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    });
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /Show|Collapse/ })).toBeNull();
  });

  test("names a generic entry file by its folder and states its kind and location", () => {
    render(
      <LocalConversationEndResources
        resources={[file("/workspace/notes.local/artifacts/new-tab-page/report/index.html")]}
        hostId="local"
        cwd="/workspace"
      />,
    );
    const card = screen.getByRole("button", { name: "Open report/index.html" });
    expect(card.textContent).toBe("report/index.htmlHTML·notes.local/artifacts/new-tab-page");
  });

  test("opens a document in Files on the output's own host", async () => {
    ports.openFile.mockResolvedValue(true);
    render(
      <LocalConversationEndResources
        resources={[file("/srv/app/report/index.html")]}
        hostId="ssh:remote"
        cwd="/srv/app"
        workspaceRoot="/srv/app"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open report/index.html" }));
    });
    await waitFor(() =>
      expect(ports.openFile).toHaveBeenCalledWith(
        { path: "/srv/app/report/index.html" },
        {
          hostId: "ssh:remote",
          cwd: "/srv/app",
          workspaceRoot: "/srv/app",
          title: "report/index.html",
        },
      ),
    );
    expect(ports.openDefault).not.toHaveBeenCalled();
  });

  test("renders local HTML in the default browser and falls back to Files", async () => {
    ports.openDefault.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    ports.openFile.mockResolvedValue(true);
    render(
      <LocalConversationEndResources
        resources={[file("/workspace/report.html")]}
        hostId="local"
        cwd="/workspace"
      />,
    );
    const card = screen.getByRole("button", { name: "Open report.html" });
    await act(async () => {
      fireEvent.click(card);
    });
    await waitFor(() => expect(ports.openDefault).toHaveBeenCalledWith("/workspace/report.html"));
    expect(ports.openFile).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(card);
    });
    await waitFor(() => expect(ports.openFile).toHaveBeenCalledTimes(1));
  });

  test("previews a local image in place", async () => {
    render(
      <LocalConversationEndResources
        resources={[file("/workspace/shots/after.png")]}
        hostId="local"
        cwd="/workspace"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open after.png" }));
    });
    expect(await screen.findByRole("dialog", { name: "after.png" })).toBeTruthy();
    expect(ports.openFile).not.toHaveBeenCalled();
  });

  test("offers file destinations from the context menu and opens them on the output's host", async () => {
    render(
      <LocalConversationEndResources
        resources={[file("/srv/app/notes.md")]}
        hostId="ssh:remote"
        cwd="/srv/app"
      />,
    );
    await act(async () => {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Open notes.md" }), {
        clientX: 12,
        clientY: 34,
      });
      await Promise.resolve();
    });
    expect(ports.fileMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "ssh:remote",
        target: { path: "/srv/app/notes.md" },
        label: "notes.md",
        x: 12,
        y: 34,
      }),
    );
    const request = ports.fileMenu.mock.calls[0]?.[0] as {
      open: (target: { path: string }, options?: object) => Promise<boolean>;
    };
    await act(async () => {
      await request.open({ path: "/srv/app/notes.md" }, { mode: "preview" });
    });
    expect(ports.openFile).toHaveBeenCalledWith(
      { path: "/srv/app/notes.md" },
      { hostId: "ssh:remote", cwd: "/srv/app", workspaceRoot: undefined, mode: "preview" },
    );
  });

  test("offers link actions for a web output from the keyboard", async () => {
    render(
      <LocalConversationEndResources
        resources={[
          {
            id: "website:http://localhost:5173/",
            kind: "website",
            target: "http://localhost:5173/",
            label: "localhost:5173",
            title: "http://localhost:5173/",
          },
        ]}
        hostId="local"
      />,
    );
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Open localhost:5173" }), {
        key: "F10",
        shiftKey: true,
      });
      await Promise.resolve();
    });
    expect(ports.webMenu).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:5173/" }),
    );
    expect(ports.fileMenu).not.toHaveBeenCalled();
  });
});
