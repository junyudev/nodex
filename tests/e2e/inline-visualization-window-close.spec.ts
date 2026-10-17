import { expect, test } from "@playwright/test";
import {
  ElectronScenarioHarness,
  openNodexWindow,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createAgentSmokeDraft, invokeIpc } from "./support/agent-smoke-harness";

test("native window close releases its prepared visualization guest without renderer errors", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "visualization-window-close" });
  try {
    const page = await harness.launch();
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Window close",
    );
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
    const standby = page.locator('webview[data-inline-visualization-standby="ready"]');
    await expect(standby).toHaveCount(1, { timeout: 30_000 });
    const guestId = await standby.evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
    );
    expect(
      await harness.application.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id);
        return guest?.getType() === "webview" && !guest.isDestroyed();
      }, guestId),
    ).toBe(true);

    const survivingWindow = await openNodexWindow(harness.application, async () => {
      expect(
        await invokeIpc(page, "window:new", {
          activeProjectId: draft.projectId,
          activeProjectSessionId: null,
        }),
      ).toBe(true);
    });

    const closed = page.waitForEvent("close");
    const ownerWindow = await harness.application.browserWindow(page);
    // Sandboxed renderer window.close() bypasses Electron's native close event and flush handshake.
    await ownerWindow.evaluate((window) => window.close());
    await closed;
    await expect
      .poll(() =>
        harness.application.evaluate(
          ({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true,
          guestId,
        ),
      )
      .toBe(true);
    expect(survivingWindow.isClosed()).toBe(false);
    expect(rendererErrors).toEqual([]);
  } finally {
    await harness.close();
  }
});
