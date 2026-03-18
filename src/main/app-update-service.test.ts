import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AppUpdateSettings } from "../shared/types";
import { AppUpdateService } from "./app-update-service";

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  checkCount = 0;
  installCount = 0;

  async checkForUpdates(): Promise<null> {
    this.checkCount += 1;
    return null;
  }

  quitAndInstall(): void {
    this.installCount += 1;
  }
}

function createLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function createService(overrides?: Partial<{
  currentVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  updater: FakeUpdater;
}>) {
  const updater = overrides?.updater ?? new FakeUpdater();
  const service = new AppUpdateService({
    currentVersion: overrides?.currentVersion ?? "0.1.5",
    isPackaged: overrides?.isPackaged ?? true,
    platform: overrides?.platform ?? "darwin",
    logger: createLogger(),
    createUpdater: () => updater,
  });
  return { service, updater };
}

const automaticChecksEnabled: AppUpdateSettings = {
  automaticChecksEnabled: true,
};

describe("AppUpdateService", () => {
  test("reports unsupported outside packaged macOS builds", () => {
    const { service } = createService({
      isPackaged: false,
      platform: "linux",
    });

    const status = service.initialize();

    expect(status.supported).toBeFalse();
    expect(status.status).toBe("unsupported");
    expect(status.currentVersion).toBe("0.1.5");
  });

  test("starts exactly one automatic check when enabled", () => {
    const { service, updater } = createService();

    service.maybeStartAutomaticChecks(automaticChecksEnabled);
    service.maybeStartAutomaticChecks(automaticChecksEnabled);

    expect(updater.checkCount).toBe(1);
    expect(updater.autoDownload).toBeTrue();
    expect(updater.autoInstallOnAppQuit).toBeFalse();
    expect(updater.allowPrerelease).toBeFalse();
  });

  test("tracks no-update checks", async () => {
    const { service, updater } = createService();

    await service.checkForUpdates("manual");
    updater.emit("checking-for-update");
    updater.emit("update-not-available", {
      version: "0.1.5",
      releaseDate: "2026-03-18T00:00:00.000Z",
      files: [],
      path: "Nodex-0.1.5-arm64.zip",
      sha512: "sha",
    });

    const status = service.getStatus();
    expect(status.status).toBe("upToDate");
    expect(status.supported).toBeTrue();
    expect(status.message).toBe("You’re up to date.");
    expect(status.releaseDate).toBe("2026-03-18T00:00:00.000Z");
  });

  test("tracks download progress and installs only after download completes", async () => {
    const { service, updater } = createService();

    await service.checkForUpdates("manual");
    updater.emit("update-available", {
      version: "0.1.6",
      releaseName: "0.1.6",
      releaseDate: "2026-03-19T00:00:00.000Z",
      releaseNotes: "Bug fixes",
      files: [],
      path: "Nodex-0.1.6-arm64.zip",
      sha512: "sha",
    });
    updater.emit("download-progress", {
      percent: 50.125,
      transferred: 512,
      total: 1024,
      bytesPerSecond: 128,
      delta: 0,
    });

    let status = service.getStatus();
    expect(status.status).toBe("downloading");
    expect(status.availableVersion).toBe("0.1.6");
    expect(status.progressPercent).toBe(50.13);
    expect(status.transferredBytes).toBe(512);
    expect(status.totalBytes).toBe(1024);

    expect(service.installUpdateAndRestart()).toBeFalse();
    expect(updater.installCount).toBe(0);

    updater.emit("update-downloaded", {
      version: "0.1.6",
      releaseName: "0.1.6",
      releaseDate: "2026-03-19T00:00:00.000Z",
      releaseNotes: "Bug fixes",
      files: [{ size: 1024 }],
    });

    status = service.getStatus();
    expect(status.status).toBe("downloaded");
    expect(status.progressPercent).toBe(100);
    expect(status.message).toBe("Update ready. Restart Nodex to install it.");
    expect(service.installUpdateAndRestart()).toBeTrue();
    expect(updater.installCount).toBe(1);
  });

  test("surfaces updater errors", async () => {
    const { service, updater } = createService();

    await service.checkForUpdates("manual");
    updater.emit("error", new Error("network failed"));

    const status = service.getStatus();
    expect(status.status).toBe("error");
    expect(status.message).toBe("network failed");
  });
});
