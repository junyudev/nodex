import { describe, expect, test, vi } from "vite-plus/test";
import { createFileReferenceRouter, openFileReferenceExternally } from "./file-reference-router";

describe("file reference router", () => {
  test("uses the panel port for an ordinary file reference", async () => {
    const openWorkspaceFileTab = vi.fn(async () => true);
    const router = createFileReferenceRouter({
      opener: "vscode",
      port: { openWorkspaceFileTab },
    });

    await expect(
      router.open(
        {
          path: "/workspace/project/src/index.ts",
          line: 19,
          column: 4,
        },
        {
          cwd: "/workspace/project",
          workspaceRoot: "/workspace/project",
          title: "index.ts",
        },
      ),
    ).resolves.toBe(true);

    expect(openWorkspaceFileTab).toHaveBeenCalledWith({
      cwd: "/workspace/project",
      hostId: "local",
      path: "/workspace/project/src/index.ts",
      title: "index.ts",
      panelId: "right",
      mode: "preview",
      workspaceRoot: "/workspace/project",
      location: { line: 19, column: 4 },
    });
  });

  test("falls back to Finder when the selected external opener cannot open", async () => {
    const openExternal = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      openFileReferenceExternally(
        { path: "/workspace/project/src/index.ts", line: 19 },
        "vscode",
        openExternal,
      ),
    ).resolves.toBe(true);

    expect(openExternal).toHaveBeenNthCalledWith(
      2,
      { path: "/workspace/project/src/index.ts", line: 19 },
      "fileManager",
    );
  });
});
