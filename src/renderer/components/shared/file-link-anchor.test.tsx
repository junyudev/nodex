import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { renderWithMaitai as render, settleAsyncRender } from "../../test/dom";
import { FileLinkAnchor } from "./file-link-anchor";
import { FileReferenceRouterProvider } from "@/lib/file-reference-router";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "../../test/browser-globals";

const invoke = vi.fn(async () => true);

describe("FileLinkAnchor", () => {
  beforeEach(() => {
    installWindowApi({ invoke, on: () => () => undefined });
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
