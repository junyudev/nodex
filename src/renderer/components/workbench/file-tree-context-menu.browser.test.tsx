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
}));
vi.mock("@/lib/file-system-operations", () => ({
  listAvailableFileLinkOpeners: async () => ["vscode", "cursor"],
}));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: calls.open }),
}));
vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: calls.copy }));
vi.mock("@/lib/workspace-file-operations", () => ({ saveWorkspaceFileCopy: calls.save }));
vi.mock("@/features/local-conversation", () => ({
  setLocalConversationComposerIntent: calls.append,
}));

describe("file tree context actions", () => {
  test("resolves shadow rows to real paths for external opening, save, copy, and composer attachment", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: 320, height: 240 }}>
          <FileTreeContextMenu
            threadId="thread-1"
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
    await act(async () =>
      userEvent.click(await view.findByRole("menuitem", { name: "Open in VS Code" })),
    );
    expect(calls.open).toHaveBeenCalledWith(
      { path: "/workspace/src/file.ts" },
      { external: true, opener: "vscode" },
    );
    await openMenu();
    await act(async () => userEvent.click(view.getByRole("menuitem", { name: "Save as…" })));
    expect(calls.save).toHaveBeenCalledWith({ path: "/workspace/src/file.ts" });
    await openMenu();
    await act(async () => userEvent.click(view.getByRole("menuitem", { name: "Copy path" })));
    expect(calls.copy).toHaveBeenCalledWith("/workspace/src/file.ts");
    await openMenu();
    await act(async () => userEvent.click(view.getByRole("menuitem", { name: "Add to chat" })));
    expect(calls.append).toHaveBeenCalledWith(
      "thread-1",
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
});
