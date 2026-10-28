import { expect, test, vi } from "vite-plus/test";
import type { Actions } from "electron-context-menu";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { nativeContextImagePath, nativeImageContextMenuItems } from "./native-image-context-menu";

test("only app filesystem image URLs expose a native reveal path", () => {
  expect(nativeContextImagePath("app://fs/@fs/Users/test/a%20b.png?x=1")).toBe(
    "/Users/test/a b.png",
  );
  expect(nativeContextImagePath("app://fs/@fs/C:/work/a.png")).toBe("C:/work/a.png");
  for (const source of [
    "file:///tmp/a.png",
    "https://example.test/@fs/a.png",
    "app://fs/host/capability",
    "app://-/@fs/tmp/a.png",
    "app://fs/@fs/%ZZ",
  ])
    expect(nativeContextImagePath(source)).toBeNull();
});

test("native image fallback preserves edit accelerators and limits saving to the main frame", () => {
  const cut: MenuItemConstructorOptions = { id: "cut" };
  const copy: MenuItemConstructorOptions = { id: "copy" };
  const paste: MenuItemConstructorOptions = { id: "paste" };
  const actions = {
    cut: () => cut,
    copy: () => copy,
    paste: () => paste,
    copyImage: () => ({ id: "copyImage" }),
    saveImageAs: () => ({ id: "saveImageAs" }),
  } as unknown as Actions;
  const mainFrame = {};
  const window = { webContents: { mainFrame } } as unknown as BrowserWindow;
  const params = {
    mediaType: "image",
    srcURL: "app://fs/@fs/tmp/chart.png",
    frame: mainFrame,
  } as ContextMenuParams;
  const reveal = vi.fn();
  const items = nativeImageContextMenuItems(actions, params, window, "darwin", reveal);
  expect(items.map(({ id, label }) => id ?? label)).toEqual([
    "Reveal in Finder",
    "copyImage",
    "saveImageAs",
  ]);
  items[0]!.click?.({} as never, window, {} as never);
  expect(reveal).toHaveBeenCalledExactlyOnceWith("/tmp/chart.png");
  expect([cut.accelerator, copy.accelerator, paste.accelerator]).toEqual([
    "CmdOrCtrl+X",
    "CmdOrCtrl+C",
    "CmdOrCtrl+V",
  ]);
  expect(
    nativeImageContextMenuItems(
      actions,
      { ...params, frame: {} } as ContextMenuParams,
      window,
      "darwin",
      reveal,
    ).map(({ id, label }) => id ?? label),
  ).toEqual(["Reveal in Finder", "copyImage"]);
  expect(
    nativeImageContextMenuItems(
      actions,
      { ...params, mediaType: "none" },
      window,
      "darwin",
      reveal,
    ),
  ).toEqual([]);
});
