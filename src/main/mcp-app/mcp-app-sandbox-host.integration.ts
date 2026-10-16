import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { MCP_APP_REQUIRED_GUEST_PORT_NAMES } from "../../shared/mcp-app/mcp-app-sandbox-contract";
import { isolatedElectronArguments } from "../../../scripts/isolated-run/electron-arguments";

const temporaryDirectories: string[] = [];

interface SandboxFixtureState {
  didAttachAccepted: boolean | null;
  didAttachSessionMatched: boolean | null;
  didAttachUrl: string | null;
  error: string | null;
  guestId: number | null;
  handshake: boolean;
  portCount: number;
  webviewCount: number;
}

async function stopApplication(application: ElectronApplication): Promise<void> {
  await application.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP App sandbox host Electron boundary", () => {
  test("binds a validated session/init pair and forwards the Skybridge port bridge", async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "nodex-mcp-sandbox-integration-"));
    temporaryDirectories.push(outputDirectory);
    await build({
      bundle: true,
      entryPoints: {
        main: path.resolve("tests/fixtures/mcp-app-sandbox/electron-main.ts"),
        "mcp-app-sandbox-guest": path.resolve("src/preload/mcp-app-sandbox-guest.ts"),
        "owner-preload": path.resolve("tests/fixtures/mcp-app-sandbox/owner-preload.ts"),
      },
      external: ["electron"],
      format: "cjs",
      outdir: outputDirectory,
      platform: "node",
      target: "node24",
    });
    await build({
      bundle: true,
      entryPoints: [path.resolve("tests/fixtures/mcp-app-sandbox/owner-script.ts")],
      format: "iife",
      outfile: path.join(outputDirectory, "owner-script.js"),
      platform: "browser",
      target: "es2022",
    });
    const home = path.join(outputDirectory, "home");
    mkdirSync(home);

    const childEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnvironment[name] = value;
    }
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    childEnvironment.CODEX_HOME = path.join(home, "agent");
    let application: ElectronApplication | null = null;
    try {
      application = await electron.launch({
        args: [
          path.join(outputDirectory, "main.js"),
          "--home",
          home,
          ...isolatedElectronArguments(),
        ],
        env: childEnvironment,
      });
      const page = await application.firstWindow();
      expect(await application.evaluate(({ app }) => app.getPath("userData"))).toBe(
        path.join(home, "user-data"),
      );
      await expect
        .poll(async () =>
          page.evaluate(
            () => (window as unknown as { fixtureState: SandboxFixtureState }).fixtureState,
          ),
        )
        .toMatchObject({
          didAttachAccepted: true,
          didAttachSessionMatched: true,
          guestId: expect.any(Number),
          webviewCount: 1,
        });
      const state = await page.evaluate(
        () => (window as unknown as { fixtureState: SandboxFixtureState }).fixtureState,
      );
      expect(state.guestId).not.toBe(null);

      await expect
        .poll(async () =>
          page.evaluate(
            () => (window as unknown as { fixtureState: SandboxFixtureState }).fixtureState,
          ),
        )
        .toMatchObject({
          error: null,
          handshake: true,
          portCount: MCP_APP_REQUIRED_GUEST_PORT_NAMES.length + 1,
        });

      const guestFacts = await application.evaluate(
        async ({ BrowserWindow, webContents }, guestId) => {
          const guest = webContents.fromId(guestId ?? -1);
          if (!guest) throw new Error("Missing MCP sandbox guest");
          const preferences = (
            guest as unknown as { getLastWebPreferences(): Record<string, unknown> }
          ).getLastWebPreferences();
          const globals = await guest.executeJavaScript(
            `({
            process: typeof globalThis.process,
            require: typeof globalThis.require,
            electron: typeof globalThis.ipcRenderer,
          })`,
            false,
          );
          const permission = await guest.executeJavaScript(
            "Notification.requestPermission()",
            false,
          );
          const windowCount = BrowserWindow.getAllWindows().length;
          await guest.executeJavaScript("window.open('https://example.com')", false);
          const urlBeforeNavigation = guest.getURL();
          await guest.executeJavaScript("location.href = 'https://example.com'", false);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            globals,
            permission,
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            storagePath: guest.session.getStoragePath(),
            url: guest.getURL(),
            urlBeforeNavigation,
            windowCount,
            windowCountAfterPopup: BrowserWindow.getAllWindows().length,
          };
        },
        state.guestId,
      );

      expect(guestFacts).toMatchObject({
        globals: {
          electron: "undefined",
          process: "undefined",
          require: "undefined",
        },
        permission: "denied",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        storagePath: null,
      });
      expect(guestFacts.urlBeforeNavigation).toMatch(/^nodex-mcp-sandbox:/u);
      expect(guestFacts.windowCountAfterPopup).toBe(guestFacts.windowCount);
      expect(guestFacts.url).toBe(guestFacts.urlBeforeNavigation);

      const pingPorts = () =>
        page.evaluate(() =>
          (
            window as unknown as {
              pingFixturePorts(): Promise<{ nonce: string; counter: number }[]>;
            }
          ).pingFixturePorts(),
        );
      const baseline = await pingPorts();
      expect(baseline).toHaveLength(MCP_APP_REQUIRED_GUEST_PORT_NAMES.length + 1);
      const nonce = baseline[0]!.nonce;
      expect(new Set(baseline.map((reply) => reply.nonce))).toEqual(new Set([nonce]));
      for (const target of ["fixture-panel", "fixture-parking", "fixture-inline"]) {
        await page.evaluate(
          (target) =>
            (window as unknown as { moveFixtureFrame(target: string): void }).moveFixtureFrame(
              target,
            ),
          target,
        );
        const replies = await pingPorts();
        expect(replies).toHaveLength(baseline.length);
        expect(replies.every((reply) => reply.nonce === nonce && reply.counter === 0)).toBe(true);
        expect(
          await application.evaluate(
            ({ webContents }, id) => Boolean(webContents.fromId(id ?? -1)),
            state.guestId,
          ),
        ).toBe(true);
      }
      await application.evaluate(async ({ webContents }, id) => {
        const guest = webContents.fromId(id ?? -1);
        if (!guest) throw new Error("Native fixture guest disappeared during surface moves");
        const point = (await guest.executeJavaScript(
          "(()=>{const r=document.getElementById('increment').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
        )) as { x: number; y: number };
        guest.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        guest.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      }, state.guestId);
      await expect
        .poll(async () =>
          (await pingPorts()).every((reply) => reply.nonce === nonce && reply.counter === 1),
        )
        .toBe(true);

      await page.evaluate(() => (window as unknown as { attachAgain(): void }).attachAgain());
      await expect
        .poll(async () =>
          application?.evaluate(
            ({ webContents }) =>
              webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
                .length,
          ),
        )
        .toBe(2);
      await page.evaluate(() =>
        (window as unknown as { removeFixtureFrame(): void }).removeFixtureFrame(),
      );
      await expect
        .poll(() =>
          application!.evaluate(
            ({ webContents }, id) => !webContents.fromId(id ?? -1),
            state.guestId,
          ),
        )
        .toBe(true);
    } finally {
      if (application) await stopApplication(application);
    }
  }, 60_000);
});
