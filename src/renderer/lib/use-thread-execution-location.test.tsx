import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vite-plus/test";
import type { CodexAppHandoffOperation } from "../../shared/codex-thread-handoff";
import { buildThreadHandoffOperation } from "@/test/thread-handoff-fixture";
import { toastFailure } from "./failure-toast";
import { useThreadExecutionLocation } from "./use-thread-execution-location";
import { moveThreadExecution } from "./thread-handoff-runtime";

let observed: CodexAppHandoffOperation | null = null;
vi.mock("./thread-handoff-runtime", () => ({
  moveThreadExecution: vi.fn(),
  useThreadExecutionHandoff: () => observed,
}));
vi.mock("./failure-toast", () => ({ toastFailure: vi.fn() }));

const renderLocation = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => useThreadExecutionLocation("thread"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { view, client };
};

test("blocks another move during admission and releases the guard when admission fails", async () => {
  let fail!: (error: Error) => void;
  const move = vi.mocked(moveThreadExecution);
  move.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => useThreadExecutionLocation("thread"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  let operation!: Promise<void>;
  await act(async () => {
    operation = view.result.current.move("worktree", "present");
  });
  expect(view.result.current.busy).toBe(true);
  await act(async () => {
    await view.result.current.move("local", "missing");
  });
  expect(move).toHaveBeenCalledOnce();
  const failure = new Error("handoff unavailable");
  await act(async () => {
    fail(failure);
    await expect(operation).rejects.toBe(failure);
  });
  expect(view.result.current.busy).toBeFalsy();
  move.mockRejectedValueOnce(failure);
  await act(async () => {
    await expect(view.result.current.move("local", "missing")).rejects.toBe(failure);
  });
  expect(move).toHaveBeenCalledTimes(2);
  expect(move).toHaveBeenLastCalledWith(
    expect.objectContaining({
      threadId: "thread",
      destination: "local",
      expectedSource: "missing",
    }),
  );
  view.unmount();
  client.clear();
});

test("reports a failed move once, only on the surface that started it", async () => {
  observed = buildThreadHandoffOperation({
    operationId: "elsewhere",
    sourceThreadId: "thread",
    status: "error",
    message: "Started in another window",
  });
  const { view, client } = renderLocation();
  expect(toastFailure).not.toHaveBeenCalled();

  vi.mocked(moveThreadExecution).mockResolvedValueOnce(
    buildThreadHandoffOperation({
      operationId: "mine",
      sourceThreadId: "thread",
      status: "running",
      createdAt: 10,
    }),
  );
  await act(async () => {
    await view.result.current.move("local", "missing");
  });
  observed = buildThreadHandoffOperation({
    operationId: "mine",
    sourceThreadId: "thread",
    status: "error",
    message: "Branch checkout failed",
    revision: 5,
    createdAt: 10,
  });
  view.rerender();
  view.rerender();
  expect(toastFailure).toHaveBeenCalledExactlyOnceWith(
    "Couldn’t move the chat",
    "Branch checkout failed",
  );
  view.unmount();
  client.clear();
  observed = null;
});
