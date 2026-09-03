import { describe, expect, test } from "vite-plus/test";
import {
  admitBrowserPipResource,
  emptyBrowserPipResourceState,
  releaseBrowserPipResources,
  validateBrowserPipImage,
  type BrowserPipResourceLease,
} from "./browser-pip-image-resource-governor";

const pngDataUrl = (width: number, height: number): string => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};

const jpegDataUrl = (width: number, height: number): string => {
  const bytes = Buffer.alloc(13);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x09, 0x08]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes.set([0xff, 0xd9], 11);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
};

const lease = (
  presentationId: string,
  sessionKey: string,
  taskId: string,
  updatedAt: number,
): BrowserPipResourceLease => ({
  compressedBytes: 24,
  estimatedDecodedBytes: 16,
  presentationId,
  sessionKey,
  taskId,
  updatedAt,
});

describe("Browser PiP image resource governor", () => {
  test("accepts canonical PNG headers and rejects disguised or oversized raster payloads", () => {
    expect(validateBrowserPipImage(pngDataUrl(10, 20))).toMatchObject({
      accepted: true,
      image: { estimatedDecodedBytes: 800, height: 20, mime: "image/png", width: 10 },
    });
    expect(validateBrowserPipImage(jpegDataUrl(12, 21))).toMatchObject({
      accepted: true,
      image: { estimatedDecodedBytes: 1_008, height: 21, mime: "image/jpeg", width: 12 },
    });
    expect(validateBrowserPipImage("data:image/png;base64,YQ==")).toEqual({
      accepted: false,
      reason: "header-mismatch",
    });
    expect(validateBrowserPipImage(pngDataUrl(8_193, 1))).toEqual({
      accepted: false,
      reason: "dimensions-too-large",
    });
    expect(validateBrowserPipImage("data:image/svg+xml;base64,PHN2Zz4=")).toEqual({
      accepted: false,
      reason: "unsupported-mime",
    });
  });

  test("evicts the oldest unrelated lease and releases each selected identity once", () => {
    const limits = {
      maximumDecodedBytesPerProcess: 32,
      maximumDecodedBytesPerSession: 32,
      maximumDecodedBytesPerThread: 32,
      maximumPresentationsPerProcess: 2,
      maximumPresentationsPerSession: 2,
      maximumPresentationsPerThread: 2,
    };
    const first = admitBrowserPipResource(
      emptyBrowserPipResourceState(),
      lease("one", "session-a", "thread-a", 1),
      limits,
    );
    const second = admitBrowserPipResource(
      first.state,
      lease("two", "session-b", "thread-b", 2),
      limits,
    );
    const third = admitBrowserPipResource(
      second.state,
      lease("three", "session-c", "thread-c", 3),
      limits,
    );

    expect(third.reason).toBeNull();
    expect(third.evicted.map((entry) => entry.presentationId)).toEqual(["one"]);
    expect([...third.state.leases.keys()]).toEqual(["two", "three"]);
    const released = releaseBrowserPipResources(
      third.state,
      (entry) => entry.taskId === "thread-b",
    );
    expect(released.released.map((entry) => entry.presentationId)).toEqual(["two"]);
    expect([...released.state.leases.keys()]).toEqual(["three"]);
  });

  test("keeps retained state constant across replacement and task-lifecycle pressure", () => {
    let state = emptyBrowserPipResourceState();

    for (let update = 1; update <= 1_000; update += 1) {
      const admission = admitBrowserPipResource(
        state,
        lease("current-tab", "current-session", "current-thread", update),
      );
      expect(admission.reason).toBeNull();
      expect(admission.evicted).toEqual([]);
      state = admission.state;
      expect(state.leases.size).toBe(1);
    }

    expect(state.leases.get("current-tab")?.updatedAt).toBe(1_000);
    state = releaseBrowserPipResources(state, (entry) => entry.taskId === "current-thread").state;
    expect(state.leases.size).toBe(0);

    for (let cycle = 1; cycle <= 100; cycle += 1) {
      const taskId = `task-${cycle}`;
      const admission = admitBrowserPipResource(
        state,
        lease(`presentation-${cycle}`, `session-${cycle}`, taskId, cycle),
      );
      expect(admission.reason).toBeNull();
      state = releaseBrowserPipResources(admission.state, (entry) => entry.taskId === taskId).state;
      expect(state.leases.size).toBe(0);
    }
  });
});
