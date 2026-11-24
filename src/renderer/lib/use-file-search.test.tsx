import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { FileSearchEvent } from "../../shared/file-search";
import { createFileSearchSession } from "./file-search-operations";
import { useFileSearch } from "./use-file-search";

vi.mock("./file-search-operations", () => ({
  createFileSearchSession: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const PENDING = { matches: [], loading: true, incomplete: null, retry: null };
const IDLE = { matches: [], loading: false, incomplete: null, retry: null };

const updated = (query: string): FileSearchEvent => ({
  method: "fuzzyFileSearch/sessionUpdated",
  params: {
    sessionId: "session",
    query,
    files: [
      {
        root: "/first",
        path: "src/abc.ts",
        file_name: "abc.ts",
        match_type: "file",
        score: 10,
        indices: null,
      },
    ],
  },
});

test("reuses the native session across edits and fences old roots and late disposal events", async () => {
  const callbacks: Array<(event: FileSearchEvent) => void> = [];
  const update = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createFileSearchSession).mockImplementation(({ onEvent }) => {
    callbacks.push(onEvent);
    return { update, stop };
  });
  const { result, rerender, unmount } = renderHook(useFileSearch, {
    initialProps: { enabled: true, query: "a", scope: { hostId: "local", roots: ["/first"] } },
  });
  rerender({ enabled: true, query: "abc", scope: { hostId: "local", roots: ["/first"] } });
  expect(createFileSearchSession).toHaveBeenCalledTimes(1);
  expect(update.mock.calls).toEqual([["a"], ["abc"]]);
  await act(async () => {
    callbacks[0]!(updated("a"));
  });
  expect(result.current).toEqual(PENDING);
  await act(async () => {
    callbacks[0]!(updated("abc"));
  });
  expect(result.current.matches.map((match) => match.fsPath)).toEqual(["/first/src/abc.ts"]);
  expect(result.current.loading).toBe(true);
  await act(async () => {
    callbacks[0]!({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "session" } });
  });
  expect(result.current.loading).toBe(false);
  rerender({ enabled: true, query: "abc", scope: { hostId: "local", roots: ["/second"] } });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(createFileSearchSession).toHaveBeenLastCalledWith({
    hostId: "local",
    roots: ["/second"],
    onEvent: expect.any(Function),
  });
  await act(async () => {
    callbacks[0]!(updated("abc"));
  });
  expect(result.current).toEqual(PENDING);
  rerender({ enabled: true, query: "abc", scope: { hostId: "remote", roots: ["/second"] } });
  expect(stop).toHaveBeenCalledTimes(2);
  expect(createFileSearchSession).toHaveBeenLastCalledWith({
    hostId: "remote",
    roots: ["/second"],
    onEvent: expect.any(Function),
  });
  await act(async () => {
    callbacks[1]!(updated("abc"));
  });
  expect(result.current).toEqual(PENDING);
  rerender({ enabled: false, query: "abc", scope: { hostId: "remote", roots: ["/second"] } });
  expect(result.current).toEqual(IDLE);
  expect(stop).toHaveBeenCalledTimes(3);
  unmount();
});

const mountSession = (update = vi.fn().mockResolvedValue(undefined)) => {
  const callbacks: Array<(event: FileSearchEvent) => void> = [];
  vi.mocked(createFileSearchSession).mockImplementation(({ onEvent }) => {
    callbacks.push(onEvent);
    return { update, stop: vi.fn().mockResolvedValue(undefined) };
  });
  const hook = renderHook(useFileSearch, {
    initialProps: { enabled: true, query: "abc", scope: { hostId: "local", roots: ["/first"] } },
  });
  return { ...hook, update, emit: (event: FileSearchEvent) => callbacks[0]!(event) };
};

test("a search that could not cover every folder settles with its matches and the reason", async () => {
  const { result, emit, unmount } = mountSession();
  await act(async () => {
    emit(updated("abc"));
    emit({
      method: "fuzzyFileSearch/sessionCompleted",
      params: {
        sessionId: "session",
        query: "abc",
        incomplete: { reason: "too-large", root: "/first" },
      },
    });
  });
  expect(result.current.matches.map((match) => match.fsPath)).toEqual(["/first/src/abc.ts"]);
  expect(result.current).toMatchObject({
    loading: false,
    incomplete: { reason: "too-large", root: "/first" },
    retry: null,
  });
  unmount();
});

test("a search that could not run keeps its matches and can run again", async () => {
  let reject!: (error: Error) => void;
  const pending = vi.fn().mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  pending.mockResolvedValue(undefined);
  const { result, update, emit, unmount } = mountSession(pending);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await act(async () => {
      emit(updated("abc"));
      reject(new Error("Main released the session"));
      await Promise.resolve();
    });
  } finally {
    warn.mockRestore();
  }
  expect(result.current.matches.map((match) => match.fsPath)).toEqual(["/first/src/abc.ts"]);
  expect(result.current).toMatchObject({ loading: false, incomplete: { reason: "unavailable" } });
  await act(async () => {
    result.current.retry!();
  });
  expect(update.mock.calls).toEqual([["abc"], ["abc"]]);
  expect(result.current).toMatchObject({ loading: true, incomplete: null, retry: null });
  unmount();
});
