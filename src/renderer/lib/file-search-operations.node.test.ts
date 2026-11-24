import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { FileSearchEvent } from "../../shared/file-search";
const mocks = vi.hoisted(() => ({ control: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/renderer-command", () => ({ invokeRendererControl: mocks.control }));
vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeFileSearchEvents: mocks.subscribe }),
}));
import { createFileSearchSession } from "./file-search-operations";

beforeEach(() => vi.resetAllMocks());

test("coalesces edits during session creation, delivers only current results, and stops once", async () => {
  let emit!: (event: FileSearchEvent) => void;
  const unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation((callback) => {
    emit = callback;
    return unsubscribe;
  });
  let finish!: () => void;
  mocks.control.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.control.mockResolvedValue(undefined);
  const receive = vi.fn();
  const session = createFileSearchSession({
    hostId: "local",
    roots: ["/repo"],
    onEvent: receive,
  });
  const first = session.update("a");
  const latest = session.update("abc");
  const sessionId = mocks.control.mock.calls[0]![1].sessionId as string;
  expect(mocks.control).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, latest]);
  expect(mocks.control).toHaveBeenLastCalledWith("file-search:update", {
    sessionId,
    query: "abc",
  });
  for (const [id, query] of [
    [sessionId, "a"],
    ["other", "abc"],
    [sessionId, "abc"],
  ]) {
    emit({
      method: "fuzzyFileSearch/sessionUpdated",
      params: { sessionId: id!, query: query!, files: [] },
    });
  }
  expect(receive).toHaveBeenCalledTimes(1);
  await session.stop();
  await session.stop();
  await session.update("later");
  emit({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId } });
  expect(receive).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(mocks.control).toHaveBeenCalledTimes(3);
  expect(mocks.control).toHaveBeenLastCalledWith("file-search:stop", { sessionId });
});

test("closing while start is in flight prevents an update and still releases the native session", async () => {
  mocks.subscribe.mockReturnValue(vi.fn());
  let finish!: () => void;
  mocks.control.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.control.mockResolvedValue(undefined);
  const session = createFileSearchSession({
    hostId: "local",
    roots: ["/repo"],
    onEvent: vi.fn(),
  });
  const update = session.update("a");
  const stop = session.stop();
  finish();
  await Promise.all([update, stop]);
  expect(mocks.control.mock.calls.map(([channel]) => channel)).toEqual([
    "file-search:start",
    "file-search:stop",
  ]);
});

test("a rejected update starts the session again once before reporting the failure", async () => {
  mocks.subscribe.mockReturnValue(vi.fn());
  mocks.control.mockImplementation(async (channel: string) => {
    if (channel === "file-search:update")
      throw new Error("File search session is not owned by this window");
  });
  const session = createFileSearchSession({ hostId: "local", roots: ["/repo"], onEvent: vi.fn() });
  await expect(session.update("a")).rejects.toThrow("not owned");
  expect(mocks.control.mock.calls.map(([channel]) => channel)).toEqual([
    "file-search:start",
    "file-search:update",
    "file-search:start",
    "file-search:update",
  ]);
  mocks.control.mockReset();
  mocks.control.mockRejectedValueOnce(new Error("lost")).mockResolvedValue(undefined);
  await session.update("ab");
  expect(mocks.control.mock.calls.map(([channel]) => channel)).toEqual([
    "file-search:update",
    "file-search:start",
    "file-search:update",
  ]);
});
