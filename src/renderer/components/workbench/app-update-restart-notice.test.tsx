import { describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { render, textContent } from "../../test/dom";

describe("AppUpdateRestartNotice", () => {
  test("renders the restart CTA for downloaded updates", async () => {
    let restartCalls = 0;
    let dismissCalls = 0;
    const { AppUpdateRestartNotice } = await import("./app-update-restart-notice");

    const view = render(
      <AppUpdateRestartNotice
        status={{
          status: "downloaded",
          supported: true,
          currentVersion: "0.1.5",
          availableVersion: "0.1.6",
          releaseName: null,
          releaseDate: null,
          releaseNotes: null,
          progressPercent: 100,
          transferredBytes: 10,
          totalBytes: 10,
          checkedAt: null,
          message: "Update ready. Restart Nodex to install it.",
        }}
        onDismiss={() => {
          dismissCalls += 1;
        }}
        onRestart={() => {
          restartCalls += 1;
        }}
      />,
    );

    expect(textContent(view.container).includes("Nodex 0.1.6 is ready.")).toBeTrue();

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
        }}
        onDismiss={() => { }}
        onRestart={() => { }}
      />,
    );

    expect(textContent(view.container)).toBe("");
  });
});
