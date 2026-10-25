import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { WorkspaceTextSearchEvent } from "../../shared/workspace-text-search";
const mocks = vi.hoisted(() => ({ control: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/renderer-command", () => ({ invokeRendererControl: mocks.control }));
vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeWorkspaceTextSearchEvents: mocks.subscribe }),
}));
import { createWorkspaceTextSearch } from "./workspace-text-search-operations";

beforeEach(() => vi.resetAllMocks());

test("subscribes before start and fences unrelated, completed and disposed requests", async () => {
  let emit!: (event: WorkspaceTextSearchEvent) => void;
  const unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation((callback) => {
    emit = callback;
    return unsubscribe;
  });
  mocks.control.mockResolvedValue(undefined);
  const onEvent = vi.fn();
  const controller = createWorkspaceTextSearch({
    hostId: "local",
    roots: ["/repo"],
    query: "word",
    onEvent,
  });
  const requestId = mocks.control.mock.calls[0]![1].requestId as string;
  expect(mocks.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.control.mock.invocationCallOrder[0]!,
  );
  emit({ requestId: "other", type: "done", limited: false });
  emit({ requestId, type: "done", limited: true });
  emit({ requestId, type: "error", code: "search-failed", message: "late" });
  await controller.stop();
  await controller.stop();
  expect(onEvent.mock.calls).toEqual([[{ requestId, type: "done", limited: true }]]);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(mocks.control).toHaveBeenCalledTimes(1);
});

test("closing during start fences callbacks immediately and stops the admitted request once", async () => {
  let emit!: (event: WorkspaceTextSearchEvent) => void;
  let finish!: () => void;
  mocks.subscribe.mockImplementation((callback) => {
    emit = callback;
    return vi.fn();
  });
  mocks.control.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.control.mockResolvedValue(undefined);
  const onEvent = vi.fn();
  const controller = createWorkspaceTextSearch({
    hostId: "ssh:test",
    roots: ["/repo"],
    query: "word",
    onEvent,
  });
  const requestId = mocks.control.mock.calls[0]![1].requestId as string;
  const stopped = controller.stop();
  emit({ requestId, type: "done", limited: false });
  finish();
  await stopped;
  await controller.stop();
  expect(onEvent).not.toHaveBeenCalled();
  expect(mocks.control.mock.calls.map(([channel]) => channel)).toEqual([
    "workspace-text-search:start",
    "workspace-text-search:stop",
  ]);
});

test("surfaces start failure as a terminal event and releases subscription", async () => {
  const unsubscribe = vi.fn();
  mocks.subscribe.mockReturnValue(unsubscribe);
  mocks.control.mockRejectedValue(new Error("offline"));
  const onEvent = vi.fn();
  const controller = createWorkspaceTextSearch({
    hostId: "local",
    roots: ["/repo"],
    query: "word",
    onEvent,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", code: "search-failed", message: "offline" }),
  );
  await controller.stop();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
