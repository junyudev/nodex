import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { render, textContent } from "../../test/dom";

describe("AppUpdateRestartNotice", () => {
  test("shows the downloaded Nightly build beside the restart CTA", async () => {
    let restartCalls = 0;
    let dismissCalls = 0;
    const { AppUpdateRestartNotice } = await import("./app-update-restart-notice");

    const view = render(
      <AppUpdateRestartNotice
        status={{
          status: "downloaded",
          supported: true,
          currentVersion: "0.5.5 (2523)",
          availableVersion: "0.5.5 (2524)",
          releaseName: null,
          releaseDate: null,
          releaseNotes: null,
          progressPercent: 100,
          transferredBytes: 10,
          totalBytes: 10,
          checkedAt: null,
          message: "Update ready. Restart Nodex to install it.",
          channel: "nightly",
          channelChangeAllowed: false,
        }}
        onDismiss={() => {
          dismissCalls += 1;
        }}
        onRestart={() => {
          restartCalls += 1;
        }}
      />,
    );

    expect(view.getByText("Nodex 0.5.5 (2524) is ready.")).toBeTruthy();

    fireEvent.click(view.getByText("Restart to Update"));
    fireEvent.click(view.getByText("Later"));

    expect(restartCalls).toBe(1);
    expect(dismissCalls).toBe(1);
  });

  test("returns nothing when no downloaded update exists", async () => {
    const { AppUpdateRestartNotice } = await import("./app-update-restart-notice");
    const view = render(
      <AppUpdateRestartNotice
        status={{
          status: "upToDate",
          supported: true,
          currentVersion: "0.1.5",
          availableVersion: null,
          releaseName: null,
          releaseDate: null,
          releaseNotes: null,
          progressPercent: null,
          transferredBytes: null,
          totalBytes: null,
          checkedAt: null,
          message: "You’re up to date.",
          channel: "stable",
          channelChangeAllowed: true,
        }}
        onDismiss={() => {}}
        onRestart={() => {}}
      />,
    );

    expect(textContent(view.container)).toBe("");
  });
});
