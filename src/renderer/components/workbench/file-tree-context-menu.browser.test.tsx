import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { FileTree } from "@/components/ui/file-tree";
import { FileTreeContextMenu } from "./file-tree-context-menu";
import "../../globals.css";

const calls = vi.hoisted(() => ({
  open: vi.fn(async () => true),
  copy: vi.fn(async () => true),
  save: vi.fn(async () => ({ path: "/copy.ts" })),
  append: vi.fn(),
  listOpeners: vi.fn(async (): Promise<string[]> => ["vscode", "cursor"]),
}));
vi.mock("@/lib/file-system-operations", () => ({
  listAvailableFileLinkOpeners: calls.listOpeners,
}));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: calls.open }),
}));
vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: calls.copy }));
vi.mock("@/lib/workspace-file-operations", () => ({ saveWorkspaceFileCopy: calls.save }));
vi.mock("@/lib/composer-draft-intents", () => ({
  composerDraftIntents: { set: calls.append },
}));

describe("file tree context actions", () => {
  test("resolves shadow rows to real paths for external opening, save, copy, and composer attachment", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: 320, height: 240 }}>
          <FileTreeContextMenu
            composerChatKey={{ kind: "session", sessionId: "session-1" }}
            resolvePath={(path) => (path === "src/file.ts" ? "/workspace/src/file.ts" : null)}
          >
            <FileTree
              ariaLabel="Files"
              appearance="workspace"
              paths={["src/file.ts"]}
              expandedPaths={["src"]}
              selectedPath={null}
            />
          </FileTreeContextMenu>
        </div>
      </QueryClientProvider>,
    );
    const row = (path: string) => {
      const node = view.container
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector<HTMLElement>(`[role="treeitem"][data-item-path="${path}"]`);
      if (!node) throw new Error(`Missing ${path}`);
      return node;
    };
    await waitFor(() => expect(row("src/file.ts")).toBeDefined());
    await act(async () => userEvent.click(row("src/"), { button: "right" }));
    expect(view.queryByRole("menu")).toBeNull();
    const openMenu = async () => {
      await act(async () => userEvent.click(row("src/file.ts"), { button: "right" }));
      await view.findByRole("menuitem", { name: "Copy path" });
    };
    await openMenu();
    const openInCode = await view.findByRole("menuitem", { name: "Open in VS Code" });
    await act(async () => userEvent.click(openInCode));
    expect(calls.open).toHaveBeenCalledWith(
      { path: "/workspace/src/file.ts" },
      { external: true, opener: "vscode" },
    );
    await openMenu();
    const openWith = await view.findByRole("menuitem", { name: "Open with" });
    await act(async () => userEvent.hover(openWith));
    const openInCursor = await view.findByRole("menuitem", { name: "Cursor" });
    expect(view.queryByRole("menuitem", { name: /^VS Code$/u })).toBeNull();
    await act(async () => userEvent.click(openInCursor));
    expect(calls.open).toHaveBeenLastCalledWith(
      { path: "/workspace/src/file.ts" },
      { external: true, opener: "cursor" },
    );
    await openMenu();
    await act(async () => userEvent.click(view.getByRole("menuitem", { name: "Save a copy" })));
    expect(calls.save).toHaveBeenCalledWith({ path: "/workspace/src/file.ts" });
    await openMenu();
    await act(async () => userEvent.click(view.getByRole("menuitem", { name: "Copy path" })));
    expect(calls.copy).toHaveBeenCalledWith("/workspace/src/file.ts");
    await openMenu();
    await act(async () => userEvent.click(view.getByRole("menuitem", { name: "Add to chat" })));
    expect(calls.append).toHaveBeenCalledWith(
      { kind: "session", sessionId: "session-1" },
      expect.objectContaining({
        prompt: "",
        attachmentMode: "append",
        promptInput: {
          text: "",
          addedFiles: [
            {
              label: "file.ts",
              path: "/workspace/src/file.ts",
              fsPath: "/workspace/src/file.ts",
              hostId: "local",
            },
          ],
        },
      }),
    );
    queryClient.clear();
  });

  test("keeps file actions usable during opener discovery and omits unavailable actions", async () => {
    let finishDiscovery!: (openers: string[]) => void;
    const discovery = new Promise<string[]>((resolve) => {
      finishDiscovery = resolve;
    });
    calls.listOpeners.mockReturnValueOnce(discovery);
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <FileTreeContextMenu resolvePath={() => "/workspace/file.ts"}>
          <button type="button" data-item-type="file" data-item-path="file.ts">
            File
          </button>
        </FileTreeContextMenu>
      </QueryClientProvider>,
    );
    try {
      const row = view.getByRole("button", { name: "File" });
      await act(async () => userEvent.click(row, { button: "right" }));
      await view.findByRole("menuitem", { name: "Copy path" });
      expect(view.queryByRole("menuitem", { name: /^Open/u })).toBeNull();
      expect(view.queryByRole("menuitem", { name: "Add to chat" })).toBeNull();

      finishDiscovery(["vscode"]);
      await view.findByRole("menuitem", { name: "Open in VS Code" });
      expect(view.queryByRole("menuitem", { name: "Open with" })).toBeNull();
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
