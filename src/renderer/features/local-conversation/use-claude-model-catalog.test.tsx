import { act } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { useClaudeModelCatalog } from "./use-claude-model-catalog";
import type { ClaudeDiscovery } from "../../../shared/claude-models";
const subscribe = () => () => {};
const discovery = (models: readonly AgentSessionConfigSelectOption[]): ClaudeDiscovery => ({
  models,
  intelligence: { model: null, effort: null, fast: null, thinking: null },
  commands: [],
  skills: [],
  revision: "fixture",
  health: { status: "unknown", executable: null, version: null, account: null, error: null },
});

const deferred = () => {
  let resolve!: (models: ClaudeDiscovery) => void;
  const promise = new Promise<ClaudeDiscovery>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const options = (value: string) => [{ value, name: value, description: null }];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const advance = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

test("keeps model discovery scoped to the current instance and Project when replies race", async () => {
  const first = deferred();
  const second = deferred();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(
    ({ instance, project }) => useClaudeModelCatalog(instance, project, read, subscribe),
    {
      initialProps: { instance: "personal", project: "project-a" },
    },
  );
  rerender({ instance: "work", project: "project-b" });
  await act(async () => {
    second.resolve(discovery(options("gateway/model-b")));
  });
  await waitFor(() => expect(result.current.options).toEqual(options("gateway/model-b")));
  await act(async () => {
    first.resolve(discovery(options("claude-sonnet-5")));
  });
  expect(result.current.options).toEqual(options("gateway/model-b"));
  expect(read.mock.calls.map(([input]) => input)).toEqual([
    { instanceConfigId: "personal", projectId: "project-a" },
    { instanceConfigId: "work", projectId: "project-b" },
  ]);
  expect((read.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
  expect((read.mock.calls[1]?.[1] as AbortSignal).aborted).toBe(false);
});

test("releases an unfinished discovery when its consumer unmounts", async () => {
  const pending = deferred();
  const read = vi.fn().mockReturnValue(pending.promise);
  const { unmount } = renderHook(() => useClaudeModelCatalog("work", "project", read, subscribe));
  const signal = read.mock.calls[0]?.[1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    pending.resolve(discovery(options("late")));
  });
});

test("keeps discovery failures explicit without inventing model choices", async () => {
  const read = vi.fn().mockRejectedValue(new Error("private launch details"));
  const { result } = renderHook(() => useClaudeModelCatalog("work", "project", read, subscribe));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.options).toEqual([]);
  expect(result.current.error).not.toContain("private launch details");
});

test("refreshes after settings publication while preserving the same scope's previous options", async () => {
  let settingsChanged = () => {};
  const subscribeChanges = (listener: () => void) => {
    settingsChanged = listener;
    return () => {};
  };
  const updated = deferred();
  const read = vi
    .fn()
    .mockResolvedValueOnce(discovery(options("old")))
    .mockReturnValueOnce(updated.promise);
  const { result } = renderHook(() =>
    useClaudeModelCatalog("work", "project", read, subscribeChanges),
  );
  await waitFor(() => expect(result.current.options).toEqual(options("old")));
  await act(async () => {
    settingsChanged();
  });
  expect(result.current.options).toEqual(options("old"));
  await act(async () => {
    updated.resolve(discovery(options("new")));
  });
  await waitFor(() => expect(result.current.options).toEqual(options("new")));
  expect(read).toHaveBeenCalledTimes(2);
});

test("revalidates expired native configuration automatically without probing on every focus or while hidden", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const update = deferred();
  const read = vi
    .fn()
    .mockResolvedValueOnce(discovery(options("old")))
    .mockReturnValueOnce(update.promise)
    .mockResolvedValue(discovery(options("new")));
  const { result, unmount } = renderHook(() =>
    useClaudeModelCatalog("work", "project", read, subscribe),
  );
  try {
    await advance(0);
    await advance(59_000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(read).toHaveBeenCalledOnce();
    visibility.mockReturnValue("hidden");
    await advance(301_000);
    expect(read).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.options).toEqual(options("old"));
    await act(async () => {
      update.resolve(discovery(options("new")));
    });
    expect(result.current.options).toEqual(options("new"));
    await advance(59_999);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    unmount();
  }
  await advance(120_000);
  expect(read).toHaveBeenCalledTimes(3);
});

test("recovers from transient discovery failures with bounded backoff and retains known models", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const read = vi
    .fn()
    .mockResolvedValueOnce(discovery(options("known")))
    .mockRejectedValue(new Error("private details"));
  const { result, unmount } = renderHook(() =>
    useClaudeModelCatalog("work", "project", read, subscribe),
  );
  try {
    await advance(0);
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.options).toEqual(options("known"));
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toContain("private details");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(read).toHaveBeenCalledTimes(2);
    await advance(999);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(3);
    await advance(4_000);
    expect(read).toHaveBeenCalledTimes(4);
    await advance(15_000);
    expect(read).toHaveBeenCalledTimes(5);
    await advance(59_999);
    expect(read).toHaveBeenCalledTimes(5);
    read.mockResolvedValue(discovery(options("recovered")));
    await advance(1);
    expect(read).toHaveBeenCalledTimes(6);
    expect(result.current.options).toEqual(options("recovered"));
    expect(result.current.error).toBeNull();
  } finally {
    unmount();
  }
  await advance(120_000);
  expect(read).toHaveBeenCalledTimes(6);
});
