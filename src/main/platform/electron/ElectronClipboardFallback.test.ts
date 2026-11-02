import { expect, test } from "vite-plus/test";
import type { ClipboardItem } from "electron";
import { makeElectronClipboardFallback } from "./ElectronClipboardFallback";
import { NODEX_STRUCTURAL_CLIPBOARD_MIME } from "../../../shared/clipboard-paste";

const item = (formats: Record<string, Blob | string>): ClipboardItem =>
  ({
    types: Object.keys(formats),
    getType: async (type: string) =>
      typeof formats[type] === "string" ? new Blob([formats[type]]) : formats[type],
  }) as ClipboardItem;
const fixture = () => {
  let formats = {
    "text/plain": "Old",
    "text/html": "<p>Old</p>",
    [NODEX_STRUCTURAL_CLIPBOARD_MIME]: "private descriptor",
  };
  const clipboard = {
    read: async () => [item(formats)],
    write: async (items: ClipboardItem[]) => {
      formats = Object.fromEntries(
        await Promise.all(
          items[0]!.types.map(async (type) => [
            type,
            await ((await items[0]!.getType(type)) as Blob).text(),
          ]),
        ),
      );
    },
  };
  return {
    bridge: makeElectronClipboardFallback(clipboard, item),
    read: () => formats,
    replace: () => {
      formats = { ...formats, "text/plain": "Another application" };
    },
  };
};

test("enhances a claimed presentation while preserving its private MIME descriptor", async () => {
  const { bridge, read } = fixture();
  const snapshot = await bridge.read();
  expect(await bridge.update(snapshot.generation, "New", "<p>New</p>")).toBe("written");
  expect(read()).toEqual({
    "text/plain": "New",
    "text/html": "<p>New</p>",
    [NODEX_STRUCTURAL_CLIPBOARD_MIME]: "private descriptor",
  });
});
test("refuses an enhancement after another application changes the clipboard", async () => {
  const { bridge, read, replace } = fixture();
  const snapshot = await bridge.read();
  replace();
  expect(await bridge.update(snapshot.generation, "Stale")).toBe("superseded");
  expect(read()["text/plain"]).toBe("Another application");
});
