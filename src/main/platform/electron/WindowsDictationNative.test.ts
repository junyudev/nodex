/* @effect-diagnostics asyncFunction:off newPromise:off -- Exercises Electron Promise completion and lazy clipboard reads at the native adapter boundary. */
import { deferredRelease } from "../../dictation/dictation-release.test-fixtures";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Clipboard, ClipboardItem } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { terminateWindowsProcessTree } from "../../process-tree";
import {
  buildWindowsDictationReleaseScript,
  createWindowsDictationClipboardPort,
  createWindowsDictationNativeHelperClient,
  observeWindowsDictationRelease,
} from "./WindowsDictationNative";

vi.mock("electron", () => ({ clipboard: {}, ClipboardItem: class {}, globalShortcut: {} }));
vi.mock("../../process-tree", () => ({ terminateWindowsProcessTree: vi.fn(async () => {}) }));
beforeEach(() => {
  vi.mocked(terminateWindowsProcessTree).mockReset().mockResolvedValue(undefined);
});

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
  Object.assign(child, {
    stdout: new EventEmitter(),
    pid: 42_731,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
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

  it("parses split release lines and releases once on process termination", async () => {
    const child = childProcess();
    const released = vi.fn();
    const watcher = observeWindowsDictationRelease(child, released);
    child.stdout!.emit("data", Buffer.from("u"));
    child.stdout!.emit("data", Buffer.from("p\r\nnoise\nup\n"));
    expect(released).toHaveBeenCalledTimes(2);
    child.emit("error", new Error("PowerShell unavailable"));
    child.emit("exit", 1);
    child.emit("close", 1);
    child.stdout!.emit("data", Buffer.from("up\n"));
    expect(released).toHaveBeenCalledTimes(3);
    expect(watcher.isActive).toBe(false);
    await watcher.dispose();
    expect(terminateWindowsProcessTree).not.toHaveBeenCalled();
  });

  it("fences subsequent lines if released callback disposes during a chunk", async () => {
    const child = childProcess();
    const released = vi.fn(() => watcher.dispose());
    const watcher = observeWindowsDictationRelease(child, released);
    child.stdout!.emit("data", "up\nup\n");
    child.emit("exit", 0);
    child.emit("close", 0);
    await watcher.dispose();
    expect(released).toHaveBeenCalledOnce();
    expect(terminateWindowsProcessTree).not.toHaveBeenCalled();
  });

  it("fences callbacks while one native release remains awaited", async () => {
    const child = childProcess();
    const released = vi.fn();
    const nativeRelease = deferredRelease();
    vi.mocked(terminateWindowsProcessTree).mockReturnValueOnce(nativeRelease.promise);
    const watcher = observeWindowsDictationRelease(child, released);
    const disposal = watcher.dispose();
    expect(watcher.dispose()).toBe(disposal);
    let completed = false;
    const observed = disposal.then(() => {
      completed = true;
    });
    child.stdout!.emit("data", "up\nup\n");
    await Promise.resolve();
    expect(terminateWindowsProcessTree).toHaveBeenCalledExactlyOnceWith(42_731, "SIGKILL");
    expect(released).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    nativeRelease.resolve();
    await Promise.resolve();
    child.emit("exit", 0);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(child.listenerCount("error")).toBe(1);
    expect(child.stdout!.listenerCount("data")).toBe(1);
    child.emit("close", 0);
    await observed;
    expect(completed).toBe(true);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stdout!.listenerCount("data")).toBe(0);
  });

  it("joins native release even when the child stream closes first", async () => {
    const child = childProcess();
    const nativeRelease = deferredRelease();
    vi.mocked(terminateWindowsProcessTree).mockReturnValueOnce(nativeRelease.promise);
    const watcher = observeWindowsDictationRelease(child, () => {});
    const disposal = watcher.dispose();
    let completed = false;
    const observed = disposal.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(terminateWindowsProcessTree).toHaveBeenCalledOnce();
    child.emit("exit", 0);
    child.emit("close", 0);
    await Promise.resolve();
    expect(completed).toBe(false);
    nativeRelease.resolve();
    await observed;
    expect(completed).toBe(true);
  });

  it("retains native release failure while draining and owning the child until close", async () => {
    const child = childProcess();
    const failure = new Error("native handle did not exit");
    vi.mocked(terminateWindowsProcessTree).mockRejectedValueOnce(failure);
    const released = vi.fn();
    const watcher = observeWindowsDictationRelease(child, released);
    const disposal = watcher.dispose();
    await expect(disposal).rejects.toBe(failure);
    expect(watcher.dispose()).toBe(disposal);
    expect(child.listenerCount("error")).toBe(1);
    expect(child.listenerCount("close")).toBe(1);
    expect(child.stdout!.listenerCount("data")).toBe(1);
    child.stdout!.emit("data", "up\n");
    expect(() => child.emit("error", new Error("late child error"))).not.toThrow();
    expect(released).not.toHaveBeenCalled();
    child.emit("exit", 1);
    child.emit("close", 1);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stdout!.listenerCount("data")).toBe(0);
  });

  it("rejects invalid virtual-key groups before starting a process", () => {
    expect(() => buildWindowsDictationReleaseScript([])).toThrow("Invalid");
    expect(() => buildWindowsDictationReleaseScript([[17], []])).toThrow("Invalid");
    expect(() => buildWindowsDictationReleaseScript([[256]])).toThrow("Invalid");
    expect(() => buildWindowsDictationReleaseScript([[1.5]])).toThrow("Invalid");
  });

  it("does not claim Windows native availability on another OS", () => {
    expect(() => createWindowsDictationNativeHelperClient("darwin")).toThrow("requires Windows");
  });
});
