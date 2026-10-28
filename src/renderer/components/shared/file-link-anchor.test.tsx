import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { settleAsyncRender } from "../../test/dom";
import { FileLinkAnchor, openFileReferenceContextMenu } from "./file-link-anchor";
import { FileReferenceRouterProvider } from "@/lib/file-reference-router";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "../../test/browser-globals";

const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => true);
const menu = vi.hoisted(() => ({
  show: vi.fn<() => Promise<string | null>>(),
  copy: vi.fn(async (_text: string) => true),
}));
vi.mock("@/lib/native-context-menu", () => ({ showNativeContextMenu: menu.show }));
vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: menu.copy }));

describe("FileLinkAnchor", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel) => {
      if (channel === "workspace-file:github-url") return null;
      if (channel === "shell:file-link-openers:list-available") return ["vscode", "fileManager"];
      if (channel === "file-open-applications")
        return { defaultApplication: null, applications: [] };
      return true;
    });
    menu.show.mockReset();
    menu.copy.mockClear();
    installWindowApi({ invoke, on: () => () => undefined });
  });

  test("copies remote file contents using its host and rejects disabled Finder/editor actions", async () => {
    const hostId = "remote-ssh-discovered:win";
    const path = "C:/repo/file.md";
    const open = vi.fn(async () => true);
    const request = { hostId, target: { path }, label: "File", open, x: 1, y: 2 };
    invoke.mockResolvedValue({ contents: "remote content" });
    menu.show.mockResolvedValue("file-reference:copy-contents");
    await openFileReferenceContextMenu(request);
    expect(invoke).toHaveBeenCalledWith("read-file", { hostId, path, maxBytes: 2 * 1024 * 1024 });
    expect(menu.copy).toHaveBeenCalledWith("remote content");
    for (const selection of ["file-reference:reveal", "file-reference:open-with:vscode"]) {
      menu.show.mockResolvedValue(selection);
      await openFileReferenceContextMenu(request);
    }
    expect(open).not.toHaveBeenCalled();
  });

  test("opens a local reference in the Files panel and carries its location", async () => {
    const openWorkspaceFileTab = vi.fn(async () => true);
    const { container } = render(
      <NodexTooltipProvider>
        <FileReferenceRouterProvider openWorkspaceFileTab={openWorkspaceFileTab}>
          <FileLinkAnchor href="/workspace/project/src/index.ts#L19C4" showLocalFileTooltip>
            src/index.ts:19
          </FileLinkAnchor>
        </FileReferenceRouterProvider>
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    const reference = container.querySelector<HTMLButtonElement>(
      "button[data-file-reference='true']",
    );
    expect(reference).not.toBeNull();

    await act(async () => {
      fireEvent.click(reference!);
      await Promise.resolve();
    });

    expect(openWorkspaceFileTab).toHaveBeenCalledWith({
      cwd: null,
      hostId: "local",
      path: "/workspace/project/src/index.ts",
      title: "src/index.ts:19",
      panelId: "right",
      mode: "preview",
      workspaceRoot: null,
      location: { line: 19, column: 4 },
    });
  });

  test("offers remote Save as without sending the path to a local application", async () => {
    menu.show.mockResolvedValue("file-reference:save");
    await openFileReferenceContextMenu({
      hostId: "ssh:build",
      target: { path: "/repo/output.png" },
      label: "Output",
      open: vi.fn(),
      x: 1,
      y: 2,
    });
    expect(invoke).toHaveBeenCalledWith("workspace-file:save-copy", {
      hostId: "ssh:build",
      path: "/repo/output.png",
    });
    expect(invoke).not.toHaveBeenCalledWith("file-open-applications", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(
      "shell:open-file-link",
      expect.anything(),
      expect.anything(),
    );
  });

  test("does not publish a native menu after its reference has retired during preparation", async () => {
    let current = true;
    invoke.mockImplementation(async () => {
      current = false;
      return null;
    });
    await openFileReferenceContextMenu({
      hostId: "ssh:build",
      target: { path: "/repo/output.png" },
      label: "Output",
      open: vi.fn(),
      x: 1,
      y: 2,
      isCurrent: () => current,
    });
    expect(menu.show).not.toHaveBeenCalled();
  });

  test("uses durable mode for a double click", async () => {
    const openWorkspaceFileTab = vi.fn(async () => true);
    const { container } = render(
      <NodexTooltipProvider>
        <FileReferenceRouterProvider openWorkspaceFileTab={openWorkspaceFileTab}>
          <FileLinkAnchor href="/workspace/project/src/index.ts#L19">index.ts</FileLinkAnchor>
        </FileReferenceRouterProvider>
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.doubleClick(container.querySelector("button[data-file-reference='true']")!);
      await Promise.resolve();
    });

    expect(openWorkspaceFileTab).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "durable",
        location: { line: 19 },
      }),
    );
  });

  test("routes modified and middle clicks to the configured external opener", async () => {
    const openWorkspaceFileTab = vi.fn(async () => true);
    const { container } = render(
      <NodexTooltipProvider>
        <FileReferenceRouterProvider openWorkspaceFileTab={openWorkspaceFileTab}>
          <FileLinkAnchor href="/workspace/project/src/index.ts">index.ts</FileLinkAnchor>
        </FileReferenceRouterProvider>
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();
    const reference = container.querySelector<HTMLButtonElement>(
      "button[data-file-reference='true']",
    );
    expect(reference).not.toBeNull();

    await act(async () => {
      fireEvent.click(reference!, { altKey: true });
      await Promise.resolve();
    });
    expect(openWorkspaceFileTab).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      "shell:open-file-link",
      { path: "/workspace/project/src/index.ts" },
      "vscode",
    );

    vi.mocked(invoke).mockClear();
    await act(async () => {
      fireEvent(reference!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      await Promise.resolve();
    });
    expect(openWorkspaceFileTab).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      "shell:open-file-link",
      { path: "/workspace/project/src/index.ts" },
      "vscode",
    );
  });
});
