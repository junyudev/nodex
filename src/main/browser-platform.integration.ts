import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vite-plus/test";
import { _electron as electron, type ElectronApplication } from "playwright";

interface BrowserPlatformFixture {
  createGuest(id: string, url: string): Promise<number>;
  execute(id: string, expression: string): Promise<unknown>;
  load(id: string, url: string): Promise<void>;
  remove(id: string): void;
}

const fixtureMain = path.resolve("tests/fixtures/browser-platform/electron-main.cjs");
const temporaryDirectories: string[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser integration server did not bind a TCP port");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stopApplication(application: ElectronApplication): Promise<void> {
  await application.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Browser Platform Electron substrate", () => {
  test("shares one Profile while isolating, governing, restoring, emulating, and destroying guests", async () => {
    expect(process.versions.electron).toBeTruthy();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><body><h1>${pathname}</h1>` +
          `<script>window.fixturePath=${JSON.stringify(pathname)}</script>` +
          "</body></html>",
      );
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const userData = mkdtempSync(path.join(tmpdir(), "nodex-browser-platform-integration-"));
    temporaryDirectories.push(userData);
    let application: ElectronApplication | null = null;
    try {
      const childEnvironment = { ...process.env };
      delete childEnvironment.ELECTRON_RUN_AS_NODE;
      application = await electron.launch({
        args: [fixtureMain],
        env: {
          ...childEnvironment,
          NODEX_BROWSER_INTEGRATION_USER_DATA: userData,
        },
      });
      const page = await application.firstWindow();
      // Window creation precedes navigation; fixture calls require the loaded host document.
      await page.waitForURL(
        pathToFileURL(path.join(path.dirname(fixtureMain), "index.html")).href,
        {
          waitUntil: "load",
        },
      );
      const firstGuestId = await page.evaluate(
        async ({ url }) =>
          await (
            window as unknown as {
              browserPlatformFixture: BrowserPlatformFixture;
            }
          ).browserPlatformFixture.createGuest("first", url),
        { url: `${origin}/first` },
      );
      const secondGuestId = await page.evaluate(
        async ({ url }) =>
          await (
            window as unknown as {
              browserPlatformFixture: BrowserPlatformFixture;
            }
          ).browserPlatformFixture.createGuest("second", url),
        { url: `${origin}/second` },
      );

      await page.evaluate(async () => {
        const fixture = (
          window as unknown as {
            browserPlatformFixture: BrowserPlatformFixture;
          }
        ).browserPlatformFixture;
        await fixture.execute(
          "first",
          "document.cookie = 'shared_profile_cookie=ready; SameSite=Lax'; document.cookie",
        );
      });
      await expect(
        page.evaluate(async () => {
          const fixture = (
            window as unknown as {
              browserPlatformFixture: BrowserPlatformFixture;
            }
          ).browserPlatformFixture;
          return await fixture.execute("second", "document.cookie");
        }),
      ).resolves.toContain("shared_profile_cookie=ready");

      await expect(
        page.evaluate(async () => {
          const fixture = (
            window as unknown as {
              browserPlatformFixture: BrowserPlatformFixture;
            }
          ).browserPlatformFixture;
          return await fixture.execute(
            "first",
            `({
          process: typeof globalThis.process,
          require: typeof globalThis.require,
          electron: typeof globalThis.ipcRenderer,
        })`,
          );
        }),
      ).resolves.toEqual({
        process: "undefined",
        require: "undefined",
        electron: "undefined",
      });

      await expect(
        page.evaluate(async () => {
          const fixture = (
            window as unknown as {
              browserPlatformFixture: BrowserPlatformFixture;
            }
          ).browserPlatformFixture;
          return await fixture.execute("first", "Notification.requestPermission()");
        }),
      ).resolves.toBe("denied");

      const windowCountBeforePopup = await application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      await page.evaluate(async () => {
        const fixture = (
          window as unknown as {
            browserPlatformFixture: BrowserPlatformFixture;
          }
        ).browserPlatformFixture;
        await fixture.execute("first", "window.open('/popup', '_blank') === null");
      });
      await expect(
        application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      ).resolves.toBe(windowCountBeforePopup);

      const emulatedViewport = await application.evaluate(
        async ({ webContents }, input) => {
          const guest = webContents.fromId(input.guestId);
          if (!guest) throw new Error("Missing Browser guest");
          if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
          await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
            width: 412,
            height: 915,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const viewport = await guest.executeJavaScript(
            "({ width: window.innerWidth, height: window.innerHeight })",
            false,
          );
          await guest.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
          guest.debugger.detach();
          return viewport;
        },
        { guestId: firstGuestId },
      );
      expect(emulatedViewport).toEqual({ width: 412, height: 915 });

      await page.evaluate(
        async ({ url }) => {
          const fixture = (
            window as unknown as {
              browserPlatformFixture: BrowserPlatformFixture;
            }
          ).browserPlatformFixture;
          await fixture.load("first", url);
        },
        { url: `${origin}/third` },
      );
      const historyRoundTrip = await application.evaluate(
        async ({ WebContentsView, webContents }, input) => {
          const guest = webContents.fromId(input.guestId);
          if (!guest) throw new Error("Missing Browser guest");
          const entries = guest.navigationHistory.getAllEntries();
          const index = guest.navigationHistory.getActiveIndex();
          const restoredView = new WebContentsView({
            webPreferences: {
              partition: "persist:nodex-browser-integration",
            },
          });
          try {
            await restoredView.webContents.navigationHistory.restore({
              entries,
              index,
            });
            return {
              activeIndex: restoredView.webContents.navigationHistory.getActiveIndex(),
              entryCount: restoredView.webContents.navigationHistory.getAllEntries().length,
              url: restoredView.webContents.getURL(),
            };
          } finally {
            restoredView.webContents.close();
          }
        },
        { guestId: firstGuestId },
      );
      expect(historyRoundTrip.entryCount).toBeGreaterThanOrEqual(2);
      expect(historyRoundTrip.activeIndex).toBe(historyRoundTrip.entryCount - 1);
      expect(historyRoundTrip.url).toBe(`${origin}/third`);

      await page.evaluate(() => {
        (
          window as unknown as {
            browserPlatformFixture: BrowserPlatformFixture;
          }
        ).browserPlatformFixture.remove("first");
      });
      await expect
        .poll(
          async () =>
            await application?.evaluate(({ webContents }, guestId) => {
              const guest = webContents.fromId(guestId);
              return !guest || guest.isDestroyed();
            }, firstGuestId),
        )
        .toBe(true);
      await expect(
        application.evaluate(({ webContents }, guestId) => {
          const guest = webContents.fromId(guestId);
          return guest?.session.getStoragePath() ?? null;
        }, secondGuestId),
      ).resolves.toContain("Partitions/nodex-browser-integration");
    } finally {
      if (application) await stopApplication(application);
      await closeServer(server);
    }
  }, 60_000);
});
