import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  launchNodexElectronApplication,
  stopNodexElectronApplication,
  waitForNodexFirstWindow,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { withIsolatedProfile } from "../../scripts/scenarios/profile/isolated-profile";

test("retains queryable startup evidence without Core or verbose logs", async () => {
  test.setTimeout(60_000);
  // No authority lease: this case intentionally never starts a Core generation.
  await withIsolatedProfile({ label: "core-unavailable-startup-evidence" }, async (profile) => {
    const application = await launchNodexElectronApplication({
      cwd: profile.runRoot,
      nodexHome: profile.nodexHome,
      projectsDirectory: profile.projectsDirectory,
      codexHome: profile.codexHome,
      claudeConfigHome: profile.claudeConfigHome,
      environment: {
        NODEX_CORE_EXECUTABLE: join(tmpdir(), `nodex-missing-core-${randomUUID()}.exe`),
        NODEX_LOG_CONSOLE: "false",
        NODEX_LOG_FILE: "false",
      },
    });
    try {
      const page = await waitForNodexFirstWindow(application);
      await expect(page.getByRole("button", { name: "Restart Nodex" })).toBeVisible();
      const evidence = await page.evaluate(() => window.api!.getStartupFailureEvidence!());
      expect(evidence?.recordPath).toBeTruthy();
      const directory = process.platform === "win32" ? "startup" : "fatal";
      expect(
        evidence!.recordPath!.startsWith(join(profile.nodexHome, "diagnostics", directory)),
      ).toBe(true);
      const record = JSON.parse(readFileSync(evidence!.recordPath!, "utf8"));
      expect(record.id).toBe(evidence!.incidentId);
      if (process.platform === "win32") {
        expect(record).toMatchObject({
          reason: "core-startup-failed",
          executable: "nodex-core.exe",
          spawnCode: "ENOENT",
        });
      } else {
        expect(record.causes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "CoreStartupError",
              executable: "nodex-core",
              spawnCode: "ENOENT",
            }),
          ]),
        );
      }
      expect(JSON.stringify(record)).not.toContain(profile.nodexHome);
    } finally {
      await stopNodexElectronApplication(application);
    }
  });
});
