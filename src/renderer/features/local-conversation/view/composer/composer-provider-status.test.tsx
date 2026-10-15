import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { ComposerProviderStatus } from "./composer-provider-status";

describe("Composer provider status", () => {
  test("runs its action once at a time and reports a failure as a composer error", async () => {
    let fail: (cause: Error) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const onErrorMessage = vi.fn();
    render(
      <ComposerProviderStatus
        status={{
          message: "Waiting for 2 background tasks · resumes automatically",
          action: { label: "Stop", pendingLabel: "Stopping…", run },
        }}
        onErrorMessage={onErrorMessage}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Waiting for 2 background tasks");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await Promise.resolve();
    });
    const pending = screen.getByRole("button", { name: "Stopping…" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    await act(async () => {
      fail(new Error("This subagent has no running turn to stop"));
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(onErrorMessage).toHaveBeenLastCalledWith("This subagent has no running turn to stop");
    expect(run).toHaveBeenCalledOnce();
  });
});
