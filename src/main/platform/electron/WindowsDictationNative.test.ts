/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Exercises Electron Promise completion and lazy clipboard reads at the native adapter boundary. */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Clipboard, ClipboardItem } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsDictationReleaseScript,
  createWindowsDictationClipboardPort,
  createWindowsDictationNativeHelperClient,
  observeWindowsDictationRelease,
} from "./WindowsDictationNative";

vi.mock("electron", () => ({ clipboard: {}, ClipboardItem: class {}, globalShortcut: {} }));

class MemoryItem {
  readonly types: string[];
  constructor(
    readonly values: Record<
      string,
      string | Blob | { title: string; url: string } | Promise<Blob | string>
    >,
  ) {
    this.types = Object.keys(values);
  }
  getType(type: string): Promise<Blob | { title: string; url: string }> {
    return Promise.resolve(this.values[type]!).then((value) =>
      typeof value === "string" ? new Blob([value], { type }) : value,
    );
  }
}

function childProcess() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), kill: vi.fn() });
  return child;
}

describe("Windows native boundary", () => {
  it("materializes raw formats, images, bookmarks and multiple items before restoring atomically", async () => {
    const original = [
      new MemoryItem({
        "text/plain": "original",
        "text/html": "<b>original</b>",
        "text/rtf": "{\\rtf1 original}",
        "image/png": new Blob([Uint8Array.of(1, 2, 255)]),
        'electron application/osclipboard;format="private"': new Blob([Uint8Array.of(0, 128, 255)]),
        "electron application/bookmark": { title: "bookmark", url: "https://example.test" },
      }),
      new MemoryItem({ "text/uri-list": "file:///C:/sample.txt\r\n" }),
    ];
    let items = original;
    const target = {
      read: vi.fn(async () => items),
      write: vi.fn(async (next: MemoryItem[]) => {
        items = next;
      }),
      writeText: vi.fn(async (text: string) => {
        items = [new MemoryItem({ "text/plain": text })];
      }),
    };
    const port = createWindowsDictationClipboardPort(
      target as unknown as Clipboard,
      MemoryItem as unknown as typeof ClipboardItem,
    );
    const saved = await port.read();
    expect(saved.text).toBe("original");
    await port.writeText("temporary");
    await port.write(saved);
    expect(target.write).toHaveBeenCalledOnce();
    expect(await port.read()).toEqual(saved);
    expect(items).toHaveLength(2);
    expect(await items[0]!.getType("electron application/bookmark")).toEqual({
      title: "bookmark",
      url: "https://example.test",
    });
  });

  it("awaits lazy data and rejects an unreadable format instead of taking a partial snapshot", async () => {
    let resolve!: (blob: Blob) => void;
    const pending = new Promise<Blob>((done) => {
      resolve = done;
    });
    const item = new MemoryItem({ "text/plain": "original", "application/custom": pending });
    const port = createWindowsDictationClipboardPort({
      read: async () => [item],
    } as unknown as Clipboard);
    let complete = false;
    const reading = port.read().then((result) => {
      complete = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toBe(false);
    resolve(new Blob([Uint8Array.of(42)]));
    expect((await reading).items[0]![1]!.bytes).toEqual(Uint8Array.of(42));
    const broken = createWindowsDictationClipboardPort({
      read: async () => [
        {
          types: ["custom"],
          getType: async () => {
            throw new Error("clipboard changed");
          },
        },
      ],
    } as unknown as Clipboard);
    await expect(broken.read()).rejects.toThrow("clipboard changed");
  });

  it("parses split release lines and releases once on process termination", () => {
    const child = childProcess();
    const released = vi.fn();
    const watcher = observeWindowsDictationRelease(child, released);
    child.stdout!.emit("data", Buffer.from("u"));
    child.stdout!.emit("data", Buffer.from("p\r\nnoise\nup\n"));
    expect(released).toHaveBeenCalledTimes(2);
    child.emit("error", new Error("PowerShell unavailable"));
    child.emit("exit", 1);
    child.stdout!.emit("data", Buffer.from("up\n"));
    expect(released).toHaveBeenCalledTimes(3);
    expect(watcher.isActive).toBe(false);
    watcher.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("fences subsequent lines if released callback disposes during a chunk", () => {
    const child = childProcess();
    const released = vi.fn(() => watcher.dispose());
    const watcher = observeWindowsDictationRelease(child, released);
    child.stdout!.emit("data", "up\nup\n");
    child.emit("exit", 0);
    expect(released).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects invalid virtual-key groups before starting a process", () => {
    expect(() => buildWindowsDictationReleaseScript([])).toThrow("Invalid");
    expect(() => buildWindowsDictationReleaseScript([[17], []])).toThrow("Invalid");
    expect(() => buildWindowsDictationReleaseScript([[256]])).toThrow("Invalid");
    expect(() => buildWindowsDictationReleaseScript([[1.5]])).toThrow("Invalid");
  });

  it.skipIf(process.platform === "win32")(
    "does not claim Windows native availability on another OS",
    () => {
      expect(createWindowsDictationNativeHelperClient).toThrow("requires Windows");
    },
  );
});
