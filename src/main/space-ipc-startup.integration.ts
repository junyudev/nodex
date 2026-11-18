import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { ElectronApplication } from "playwright";
import { expect, test } from "vite-plus/test";
import { launchTestElectron } from "../../scripts/testing/launch-electron";
import type { IpcApi } from "../shared/ipc-api";
import type { SpaceConnectionSummary, SpaceRequest } from "../shared/space-connection";

const space: SpaceConnectionSummary = {
  spaceId: "fixture-space",
  kind: "team",
  memberId: "fixture-member",
  deviceId: "fixture-device",
  name: "Fixture Space",
  availability: "ready",
};

test.each([
  { phase: "before Main is ready", holdInitialization: true },
  { phase: "after readiness if the context read fails", holdInitialization: false },
])(
  "a Space query succeeds on retry in the same renderer $phase",
  async ({ holdInitialization }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "nodex-space-ipc-startup-"));
    const entry = path.join(directory, "main.cjs");
    let application: ElectronApplication | undefined;
    try {
      await Promise.all([
        build({
          entryPoints: [path.resolve("src/preload/index.ts")],
          bundle: true,
          external: ["electron"],
          platform: "node",
          format: "cjs",
          target: "node24",
          outfile: path.join(directory, "preload.cjs"),
        }),
        writeFile(
          entry,
          `
          const { app, BrowserWindow } = require("electron");
          const path = require("node:path");
          app.setPath("userData", path.join(__dirname, "profile"));
          void app.whenReady().then(async () => {
            const window = new BrowserWindow({
              show: false,
              webPreferences: {
                preload: path.join(__dirname, "preload.cjs"),
                sandbox: true,
                contextIsolation: true,
              },
            });
            await window.loadURL("data:text/html,<title>Space IPC startup</title>");
          });
        `,
        ),
      ]);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
        ),
      );
      application = await launchTestElectron({ args: [entry], env });
      await application.evaluate(({ ipcMain }, hold) => {
        const ready = new Promise<void>((resolve) => {
          Reflect.set(globalThis, "finishInitialization", resolve);
          if (!hold) resolve();
        });
        ipcMain.handle("app:await-initialization", () => ready);
        ipcMain.handle("settings:language:get", () => ({ locale: "en", preference: null }));
      }, holdInitialization);
      const page = await application.firstWindow();
      await page.waitForLoadState("load");
      await page.evaluate(async () => {
        const api = window.api!;
        Reflect.set(
          window,
          "earlyQuery",
          api.invoke("projects:get", "fixture-project").then(
            (value) => ({ value }),
            (error: unknown) => ({ error: String(error) }),
          ),
        );
        // An IPC round trip while the application handlers are still missing.
        await api.invoke("settings:language:get");
      });
      if (!holdInitialization) {
        const early = await page.evaluate(
          () => Reflect.get(window, "earlyQuery") as Promise<unknown>,
        );
        expect(early).toEqual({
          error: expect.stringContaining("No handler registered for 'spaces:context'"),
        });
      }

      await application.evaluate(({ ipcMain }, context) => {
        ipcMain.handle("spaces:context", () => context);
        ipcMain.handle(
          "projects:get",
          (_event, request: SpaceRequest<IpcApi["projects:get"]["args"]>) => {
            if (request.spaceId !== context.spaceId || request.args[0] !== "fixture-project") {
              throw new Error("Expected a query bound to the sending Space");
            }
            return null;
          },
        );
        const finishInitialization = Reflect.get(globalThis, "finishInitialization") as () => void;
        finishInitialization();
      }, space);
      const retry = await page.evaluate(() =>
        window.api!.invoke("projects:get", "fixture-project"),
      );
      expect(retry).toBeNull();
      if (holdInitialization) {
        const early = await page.evaluate(
          () => Reflect.get(window, "earlyQuery") as Promise<unknown>,
        );
        expect(early).toEqual({ value: null });
      }
    } finally {
      await application?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
