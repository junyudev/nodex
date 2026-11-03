import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vite-plus/test";
import { useThreadExecutionLocation } from "./use-thread-execution-location";
import { moveThreadExecution } from "./thread-handoff-runtime";

vi.mock("./thread-handoff-runtime", () => ({
  moveThreadExecution: vi.fn(),
  useThreadExecutionHandoff: () => null,
}));

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
    operation = view.result.current.move("worktree");
  });
  expect(view.result.current.busy).toBe(true);
  await act(async () => {
    await view.result.current.move("local");
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
    await expect(view.result.current.move("local")).rejects.toBe(failure);
  });
  expect(move).toHaveBeenCalledTimes(2);
  expect(move).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: "thread", destination: "local" }),
  );
  view.unmount();
  client.clear();
});
