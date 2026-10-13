import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createInlineVisualizationFrameOwner,
  type InlineVisualizationFrameInput,
} from "./inline-visualization-frame-owner";
import type { InlineVisualizationRuntime } from "./inline-visualization-runtime";
import { createInlineVisualizationAnnotations } from "./inline-visualization-annotations";

const roots: HTMLElement[] = [];
afterEach(() => roots.splice(0).forEach((root) => root.remove()));
function element() {
  const value = document.createElement("div");
  document.body.append(value);
  roots.push(value);
  return value;
}
function harness() {
  const jobs: (() => void)[] = [];
  const owner = createInlineVisualizationFrameOwner({
    createContainer: () => document.createElement("div"),
    createId: () => crypto.randomUUID(),
    move: (child, parent) => parent.append(child),
    schedule: (job) => jobs.push(job),
  });
  const parking = element();
  owner.setParking(parking);
  return { owner, parking, flush: () => jobs.splice(0).forEach((job) => job()) };
}
function input(
  threadId = "a",
  changes: Partial<InlineVisualizationFrameInput> = {},
): InlineVisualizationFrameInput {
  return {
    identity: {
      surfaceId: "main",
      hostId: "local",
      readHostId: "remote-source",
      threadId,
      sourceThreadId: "source",
      file: "report.html",
      occurrence: "native-receipt",
    },
    fragment: { contents: "<button>Counter</button>", path: "/source/report.html" },
    stateIdentity: { hostId: "local", threadId, path: "/source/report.html" },
    attempt: 0,
    canExpand: true,
    retry: vi.fn(),
    followUp: vi.fn(async () => {}),
    submitAnnotations: vi.fn(async () => {}),
    ...changes,
  };
}
function runtime(): InlineVisualizationRuntime {
  return {
    element: document.createElement("div"),
    getSnapshot: () => ({
      status: "ready",
      height: 240,
      fullscreenHeight: null,
      displayMode: "inline",
      error: null,
    }),
    subscribe: () => () => {},
    setDisplayMode: vi.fn(),
    captureImage: vi.fn(async () => new Uint8Array()),
    copyAsImage: vi.fn(async () => {}),
    setActive: vi.fn(),
    dispose: vi.fn(async () => {}),
    annotations: createInlineVisualizationAnnotations({ allowed: true, globals: () => {} }),
  };
}

describe("window-owned interactive response occurrences", () => {
  test("same-commit rebind preserves one runtime and stale cleanup cannot release its new anchor", () => {
    const { owner, flush } = harness();
    owner.setSurface("main", "local", "a");
    const first = owner.bind(input(), element());
    const guest = runtime();
    owner.attachRuntime(first.frameId, guest);
    owner.unbind(first);
    const anchor = element();
    const second = owner.bind(input(), anchor);
    owner.unbind(first);
    flush();
    expect(second.frameId).toBe(first.frameId);
    expect(owner.readFrame(second.frameId)?.container.parentElement).toBe(anchor);
    expect(owner.isActive(second.frameId)).toBe(true);
    expect(guest.dispose).not.toHaveBeenCalled();
    owner.dispose();
  });
  test("two connected consumers of one occurrence isolate runtime lifetime", () => {
    const { owner, flush } = harness();
    owner.setSurface("main", "local", "a");
    const first = owner.bind(input(), element());
    const second = owner.bind(input(), element());
    const one = runtime();
    const two = runtime();
    owner.attachRuntime(first.frameId, one);
    owner.attachRuntime(second.frameId, two);
    expect(first.frameId).not.toBe(second.frameId);
    owner.unbind(first);
    flush();
    expect(one.dispose).toHaveBeenCalledOnce();
    expect(two.dispose).not.toHaveBeenCalled();
    expect(owner.readIds()).toEqual([second.frameId]);
    owner.dispose();
  });
  test("A-B-A parks the document, denies inactive actions, then binds the original frame and current callback", async () => {
    const { owner, parking, flush } = harness();
    owner.reportResumeState("local", "a", "resumed");
    owner.setSurface("main", "local", "a");
    const first = owner.bind(input(), element());
    const guest = runtime();
    owner.attachRuntime(first.frameId, guest);
    owner.acceptHeight(first.frameId, 0, 430.2);
    owner.setSurface("main", "local", "b");
    owner.unbind(first);
    flush();
    expect(owner.readFrame(first.frameId)?.container.parentElement).toBe(parking);
    expect(owner.readFrame(first.frameId)?.container.inert).toBe(true);
    expect(() => owner.followUp(first.frameId, { sourceId: "test", prompt: "Late" })).toThrow(
      "unavailable",
    );
    const send = vi.fn(async () => {});
    owner.setSurface("main", "local", "a");
    const second = owner.bind(input("a", { followUp: send }), element());
    await owner.followUp(second.frameId, { sourceId: "test", prompt: "Current" });
    expect(second.frameId).toBe(first.frameId);
    expect(send).toHaveBeenCalledOnce();
    expect(owner.readFrame(second.frameId)?.initialHeight).toBe(431);
    expect(guest.dispose).not.toHaveBeenCalled();
    owner.dispose();
  });
  test("true unmount in the current Thread retires the frame after its rebind window", () => {
    const { owner, flush } = harness();
    owner.setSurface("main", "local", "a");
    const binding = owner.bind(input(), element());
    const guest = runtime();
    owner.attachRuntime(binding.frameId, guest);
    owner.unbind(binding);
    expect(guest.dispose).not.toHaveBeenCalled();
    flush();
    expect(guest.dispose).toHaveBeenCalledOnce();
    expect(owner.readIds()).toEqual([]);
    owner.dispose();
  });
  test.each([null, "needs_resume"] as const)(
    "leaving an unbound selected Thread retires its already invalidated %s history",
    (state) => {
      const { owner, flush } = harness();
      owner.reportResumeState("local", "a", "resumed");
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(binding.frameId, guest);
      owner.setSurface("main", "local", "b");
      owner.unbind(binding);
      flush();
      owner.setSurface("main", "local", "a");
      owner.reportResumeState("local", "a", state);
      flush();
      expect(guest.dispose).not.toHaveBeenCalled();
      owner.setSurface("main", "local", "b");
      expect(guest.dispose).toHaveBeenCalledOnce();
      expect(owner.readIds()).toEqual([]);
      owner.dispose();
    },
  );
  test.each([null, "needs_resume"] as const)(
    "inactive detached frame is released when Thread metadata becomes %s",
    (state) => {
      const { owner, flush } = harness();
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(binding.frameId, guest);
      owner.setSurface("main", "local", "b");
      owner.reportResumeState("local", "a", state);
      expect(guest.dispose).not.toHaveBeenCalled();
      owner.unbind(binding);
      flush();
      expect(guest.dispose).toHaveBeenCalledOnce();
      owner.dispose();
    },
  );
  test("height is tied weakly to body contents and rejects stale document generations", () => {
    const { owner } = harness();
    owner.setSurface("main", "local", "a");
    const binding = owner.bind(input(), element());
    const original = owner.readFrame(binding.frameId)!.fragment;
    owner.acceptHeight(binding.frameId, 0, 300.1);
    owner.updateBinding(binding, input());
    expect(owner.readFrame(binding.frameId)?.fragment).toBe(original);
    expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(301);
    owner.updateBinding(
      binding,
      input("a", { fragment: { contents: "<p>New body</p>", path: "/source/report.html" } }),
    );
    expect(owner.readFrame(binding.frameId)?.documentRevision).toBe(1);
    expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(240);
    owner.acceptHeight(binding.frameId, 0, 999);
    owner.acceptHeight(binding.frameId, 1, Number.NaN);
    expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(240);
    owner.acceptHeight(binding.frameId, 1, 100_000);
    expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(10_000);
    owner.dispose();
  });
  test("an explicit retry replaces its runtime and stays distinct from a first standby claim", () => {
    const { owner } = harness();
    owner.setSurface("main", "local", "a");
    const binding = owner.bind(input(), element());
    const guest = runtime();
    owner.attachRuntime(binding.frameId, guest);
    owner.acceptHeight(binding.frameId, 0, 320);
    owner.updateBinding(binding, input("a", { attempt: 1 }));
    expect(guest.dispose).toHaveBeenCalledOnce();
    expect(owner.readFrame(binding.frameId)).toMatchObject({
      attempt: 1,
      documentRevision: 1,
      initialHeight: 320,
    });
    owner.updateBinding(binding, input("a", { attempt: 1 }));
    expect(guest.dispose).toHaveBeenCalledOnce();
    expect(owner.readFrame(binding.frameId)?.documentRevision).toBe(1);
    owner.dispose();
  });
  test("accepted deletion is host-scoped and disposal cannot be undone by queued cleanup", () => {
    const { owner, flush } = harness();
    const local = input();
    const remote = input("a", { identity: { ...local.identity, hostId: "remote" } });
    const first = owner.bind(local, element());
    const second = owner.bind(remote, element());
    owner.unbind(first);
    owner.releaseThread("local", "a");
    expect(owner.readIds()).toEqual([second.frameId]);
    expect(owner.readPlaceholder(local.identity)).toBeUndefined();
    owner.dispose();
    flush();
    expect(owner.readIds()).toEqual([]);
    expect(() => owner.bind(local, element())).toThrow("closed");
  });
});
