import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { ElectronApplication } from "playwright";
import { expect, test } from "vite-plus/test";
import { launchTestElectron } from "../../scripts/testing/launch-electron";
import type { WindowBootstrap } from "../shared/app-startup";
import type { IpcApi } from "../shared/ipc-api";
import type { SpaceRequest } from "../shared/space-connection";

const bootstrap = {
  space: {
    spaceId: "fixture-space",
    kind: "team",
    memberId: "fixture-member",
    deviceId: "fixture-device",
    name: "Fixture Space",
    availability: "ready",
  },
  windowSession: { id: "fixture-window-session" },
  runtimeCapabilities: { enabledDevelopmentFeatures: [] },
  diagnostics: null,
} as unknown as WindowBootstrap;

test.each([
  { phase: "before Main is ready", holdInitialization: true, bootstrapReads: 1 },
  { phase: "after a failed bootstrap read", holdInitialization: false, bootstrapReads: 2 },
])(
  "a Space query succeeds on retry in the same renderer $phase",
  async ({ holdInitialization, bootstrapReads }) => {
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
      await application.evaluate(
        ({ ipcMain }, { hold, reply }) => {
          let ready = false;
          let reads = 0;
          const waiting: (() => void)[] = [];
          Reflect.set(globalThis, "finishInitialization", () => {
            ready = true;
            for (const resume of waiting.splice(0)) resume();
          });
          Reflect.set(globalThis, "bootstrapReads", () => reads);
          // A held read answers once Main is ready; otherwise it fails until then.
          ipcMain.handle("app:await-initialization", async () => {
            reads += 1;
            if (!ready && !hold) throw new Error("Space routing is not ready");
            if (!ready) await new Promise<void>((resume) => waiting.push(resume));
            return reply;
          });
          ipcMain.handle("settings:language:get", () => ({ locale: "en", preference: null }));
        },
        { hold: holdInitialization, reply: bootstrap },
      );
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
          error: expect.stringContaining("Space routing is not ready"),
        });
      }

      await application.evaluate(({ ipcMain }, spaceId) => {
        ipcMain.handle(
          "projects:get",
          (_event, request: SpaceRequest<IpcApi["projects:get"]["args"]>) => {
            if (request.spaceId !== spaceId || request.args[0] !== "fixture-project") {
              throw new Error("Expected a query bound to the sending Space");
            }
            return null;
          },
        );
        const finishInitialization = Reflect.get(globalThis, "finishInitialization") as () => void;
        finishInitialization();
      }, bootstrap.space.spaceId);
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
      // Every Space query in the document shares the one successful bootstrap read.
      await page.evaluate(() => window.api!.invoke("projects:get", "fixture-project"));
      expect(
        await application.evaluate(() =>
          (Reflect.get(globalThis, "bootstrapReads") as () => number)(),
        ),
      ).toBe(bootstrapReads);
    } finally {
      await application?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
