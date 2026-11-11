import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { electronUpdateFetch } from "./electron-update-fetch";
import type { AppUpdateChannel, AppUpdaterPlatform, AppUpdaterEvent } from "./app-updater";
import {
  readWindowsAppUpdateConfig,
  type WindowsAppUpdateConfig,
} from "./windows-app-update-config";
import {
  MAX_APPCAST_BYTES,
  selectWindowsUpdate,
  type WindowsUpdateItem,
} from "./windows-update-appcast";
import {
  cleanupWindowsUpdates,
  downloadWindowsInstaller,
  fetchUpdate,
  readBoundedAppcast,
  verifyWindowsInstaller,
  type UpdateFetch,
} from "./windows-update-download";

import { windowsUpdateInstallerCommand } from "./windows-update-handoff";

interface WindowsUpdaterPorts {
  readonly fetch: UpdateFetch;
  readonly currentVersion: string;
  readonly quit: () => void;
  readonly launch: (installer: string, relaunch: boolean) => void | Promise<void>;
  readonly observeSessionEnd: (listener: () => void) => () => void;
}

/** Node/Electron boundary only: wire cancellation and staging, never a second UI status owner. */
export function createWindowsAppUpdaterPlatform(
  config: WindowsAppUpdateConfig,
  directory: string,
  ports: WindowsUpdaterPorts,
): AppUpdaterPlatform | null {
  if (config.updates === "disabled") return null;
  return {
    acquire(initialChannel, onEvent) {
      let channel = initialChannel;
      let released = false;
      let generation = 0;
      let controller: AbortController | null = null;
      let ready: { path: string; item: WindowsUpdateItem } | null = null;
      let relaunch = false;
      let sessionEnding = false;
      const stopObserving = ports.observeSessionEnd(() => {
        sessionEnding = true;
      });
      // Every operation joins its predecessor before touching staged files.
      let pending = mkdir(directory, { recursive: true, mode: 0o700 }).then(() =>
        cleanupWindowsUpdates(directory),
      );
      // Startup failures are reported by the next check, never as unhandled rejections.
      void pending.catch(() => undefined);
      const emit = (event: AppUpdaterEvent, current: number) => {
        if (!released && generation === current) onEvent(event);
      };
      const cancel = () => {
        generation += 1;
        controller?.abort();
        controller = null;
        ready = null;
      };
      return {
        release: async () => {
          released = true;
          cancel();
          stopObserving();
          await pending.catch(() => undefined);
        },
        session: {
          check(kind) {
            if (released || controller || ready) return;
            const current = ++generation;
            controller = new AbortController();
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15 * 60 * 1000),
            ]);
            const selectedChannel = channel;
            emit({ type: "check-started", kind }, current);
            pending = pending
              .then(async () => {
                signal.throwIfAborted();
                const feed = await fetchUpdate(
                  config.feedUrls![selectedChannel],
                  ports.fetch,
                  signal,
                );
                const xml = await readBoundedAppcast(feed, MAX_APPCAST_BYTES, signal);
                const item = selectWindowsUpdate(xml, config.architecture, config.buildVersion);
                if (!item) {
                  emit({ type: "up-to-date", version: ports.currentVersion }, current);
                  return;
                }
                emit({ type: "update-found", ...item }, current);
                emit({ type: "download-started", expectedBytes: item.expectedBytes }, current);
                const preparedPath = join(directory, `prepared-${randomUUID()}.exe`);
                const response = await fetchUpdate(item.url, ports.fetch, signal);
                await downloadWindowsInstaller({
                  response,
                  item,
                  publicKey: config.publicKey,
                  preparedPath,
                  signal,
                  onProgress: (receivedBytes) =>
                    emit(
                      {
                        type: "download-progress",
                        receivedBytes,
                        expectedBytes: item.expectedBytes,
                      },
                      current,
                    ),
                });
                if (signal.aborted || generation !== current || released) {
                  await rm(preparedPath, { force: true });
                  return;
                }
                ready = { path: preparedPath, item };
                emit({ type: "update-ready", ...item }, current);
              })
              .catch((error: unknown) => {
                if (generation !== current || released) return;
                emit(
                  {
                    type: "error",
                    code: "windows-update-failed",
                    message: error instanceof Error ? error.message : String(error),
                    recoverable: true,
                  },
                  current,
                );
              })
              .finally(() => {
                if (generation === current) controller = null;
              });
          },
          setChannel(next: AppUpdateChannel) {
            if (released || next === channel) return;
            const previous = ready;
            cancel();
            channel = next;
            pending = pending.then(() =>
              previous ? rm(previous.path, { force: true }) : undefined,
            );
            void pending.catch(() => undefined);
          },
          installDownloadedUpdate() {
            if (released || !ready || sessionEnding)
              throw new Error("No verified update is ready to install.");
            relaunch = true;
            ports.quit();
          },
          prepareQuit() {
            if (released || !ready || sessionEnding) return null;
            const prepared = ready;
            const shouldRelaunch = relaunch;
            ready = null;
            // The immutable handoff survives lease release, after Core and windows close.
            return async () => {
              if (sessionEnding) return;
              await verifyWindowsInstaller(prepared.path, prepared.item, config.publicKey);
              if (!sessionEnding) await ports.launch(prepared.path, shouldRelaunch);
            };
          },
        },
      };
    },
  };
}

export function createPackagedWindowsAppUpdaterPlatform(options: {
  readonly resourcesPath: string;
  readonly architecture: "x64" | "arm64";
  readonly directory: string;
}): AppUpdaterPlatform | null {
  const config = readWindowsAppUpdateConfig(options.resourcesPath);
  if (config.architecture !== options.architecture)
    throw new Error("Packaged Windows update architecture does not match Electron.");
  if (config.updates === "disabled") return null;
  return createWindowsAppUpdaterPlatform(config, options.directory, {
    fetch: electronUpdateFetch,
    currentVersion: app.getVersion(),
    quit: () => app.quit(),
    launch: (installer, relaunch) =>
      new Promise<void>((resolve, reject) => {
        const command = windowsUpdateInstallerCommand(installer, relaunch);
        const child = spawn(command.executable, command.args, command.options);
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
    observeSessionEnd: (listener) => {
      const attach = (window: BrowserWindow) => {
        window.on("query-session-end", listener);
        window.on("session-end", listener);
      };
      BrowserWindow.getAllWindows().forEach(attach);
      const created = (_event: Electron.Event, window: BrowserWindow) => attach(window);
      app.on("browser-window-created", created);
      return () => {
        app.off("browser-window-created", created);
        for (const window of BrowserWindow.getAllWindows()) {
          window.off("query-session-end", listener);
          window.off("session-end", listener);
        }
      };
    },
  });
}
