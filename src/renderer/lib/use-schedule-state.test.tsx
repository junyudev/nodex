import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useScheduleState, type PageScheduleSource } from "./use-schedule-state";

const page: PageScheduleSource = {
  id: "page",
  scheduledStart: new Date("2026-11-03T09:00:00Z"),
  reminders: [],
};

test.each(["complete", "skip"] as const)(
  "keeps %s busy until settlement and propagates failure after cleanup",
  async (kind) => {
    let fail!: (error: Error) => void;
    const callback = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const view = renderHook(() =>
      useScheduleState({
        page,
        saveProperty: vi.fn(),
        ...(kind === "complete"
          ? { onCompleteOccurrence: callback }
          : { onSkipOccurrence: callback }),
      }),
    );
    let operation!: Promise<void>;
    await act(async () => {
      operation =
        kind === "complete"
          ? view.result.current.handleCompleteThisOccurrence()
          : view.result.current.handleSkipThisOccurrence();
    });
    expect(view.result.current.occurrenceBusy).toBe(true);
    expect(callback).toHaveBeenCalledWith(page.id, page.scheduledStart);
    const error = new Error("occurrence unavailable");
    await act(async () => {
      fail(error);
      await expect(operation).rejects.toBe(error);
    });
    expect(view.result.current.occurrenceBusy).toBe(false);
    callback.mockResolvedValueOnce(undefined);
    await act(async () => {
      await (kind === "complete"
        ? view.result.current.handleCompleteThisOccurrence()
        : view.result.current.handleSkipThisOccurrence());
    });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(view.result.current.occurrenceBusy).toBe(false);
  },
);
