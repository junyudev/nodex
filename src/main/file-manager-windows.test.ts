/* @effect-diagnostics asyncFunction:off -- Tests the filesystem and Electron shell boundary. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { openFileLinkTarget } from "./file-link-opener";

test("Windows opens directories and reveals files through the existing file-manager command", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex explorer 汉字 "));
  const shell = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() };
  const options = { platform: "win32", shell };
  try {
    const file = join(root, "note.txt");
    await writeFile(file, "content");
    await expect(openFileLinkTarget({ path: root }, "fileManager", options)).resolves.toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith(root);
    await expect(openFileLinkTarget({ path: file }, "fileManager", options)).resolves.toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
    shell.openPath.mockResolvedValueOnce("Access denied");
    await expect(openFileLinkTarget({ path: root }, "fileManager", options)).resolves.toBe(false);
    shell.openPath.mockClear();
    shell.showItemInFolder.mockClear();
    await expect(
      openFileLinkTarget({ path: "relative" }, "fileManager", options),
    ).rejects.toThrow();
    await expect(
      openFileLinkTarget({ path: join(root, "missing") }, "fileManager", options),
    ).rejects.toThrow();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
