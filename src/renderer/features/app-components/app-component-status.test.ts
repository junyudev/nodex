import { describe, expect, it } from "vitest";
import type { AppComponentInstallation, AppComponentState } from "../../../shared/app-components";
import {
  appComponentCanRetry,
  appComponentProgress,
  appComponentStatus,
} from "./app-component-status";

const component = (
  installation: AppComponentInstallation,
  overrides: Partial<AppComponentState> = {},
): AppComponentState => ({
  id: "desktop-tools",
  enabled: true,
  downloadBytes: 284_416_909,
  installation,
  removalPending: false,
  ...overrides,
});

describe("appComponentStatus", () => {
  it("shows a pending removal over the files that are still installed", () => {
    expect(
      appComponentStatus(
        component(
          { status: "installed", installedBytes: 700 },
          { enabled: false, removalPending: true },
        ),
      ),
    ).toEqual({ kind: "removal-pending" });
  });

  it("offers the download size only for a component that is turned off", () => {
    expect(appComponentStatus(component({ status: "not-installed" }, { enabled: false }))).toEqual({
      kind: "not-installed",
      downloadBytes: 284_416_909,
    });
    expect(appComponentStatus(component({ status: "not-installed" }))).toEqual({ kind: "queued" });
  });

  it("says a component is waiting for first use instead of offering a download", () => {
    expect(appComponentStatus(component({ status: "on-demand" }))).toEqual({
      kind: "on-demand",
      downloadBytes: 284_416_909,
    });
  });

  it("keeps download progress inside the bar", () => {
    const status = (receivedBytes: number, totalBytes: number) =>
      appComponentStatus(component({ status: "downloading", receivedBytes, totalBytes }));
    expect(status(50, 200)).toEqual({ kind: "downloading", fraction: 0.25, totalBytes: 200 });
    expect(status(300, 200)).toMatchObject({ fraction: 1 });
    expect(status(10, 0)).toMatchObject({ fraction: 0 });
  });

  it("separates a failure Nodex retries from one that waits for a person", () => {
    const retrying = appComponentStatus(
      component({ status: "failed", reason: "network", message: "offline", retryAt: 1_000 }),
    );
    const stopped = appComponentStatus(
      component({ status: "failed", reason: "integrity", message: "damaged", retryAt: null }),
    );
    expect(retrying).toEqual({ kind: "retrying" });
    expect(stopped).toEqual({ kind: "failed", reason: "integrity", message: "damaged" });
    expect([retrying, stopped].map(appComponentCanRetry)).toEqual([true, true]);
    expect(appComponentCanRetry(appComponentStatus(component({ status: "installing" })))).toBe(
      false,
    );
  });

  it("fills the bar while unpacking and hides it otherwise", () => {
    expect(appComponentProgress(appComponentStatus(component({ status: "installing" })))).toBe(1);
    expect(
      appComponentProgress(
        appComponentStatus(component({ status: "installed", installedBytes: 1 })),
      ),
    ).toBeNull();
  });
});
