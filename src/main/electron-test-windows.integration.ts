import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { launchTestElectron } from "../../scripts/testing/launch-electron";

interface WindowSnapshot {
  visible: boolean;
  focused: boolean;
  focusable: boolean;
  opacity: number;
}
interface WindowFixture {
  automaticId: number;
  deferredId: number;
  facts(): {
    windows: WindowSnapshot[];
    shows: WindowSnapshot[];
    focusEvents: number;
    dockVisible?: boolean;
  };
}

test("keeps constructor and later test windows out of the desktop while CDP renders and edits", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "nodex-background-windows-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  vi.stubEnv("NODEX_E2E_WINDOWS", undefined);
  const cleanup = () => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  };
  const application = await launchTestElectron({
    args: [path.resolve("tests/fixtures/background-windows/electron-main.cjs"), "--home", home],
    env,
    timeout: 10_000,
  }).catch((error: unknown) => {
    cleanup();
    throw error;
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "Message" }).fill("Background editing");
    await page.getByRole("button", { name: "Apply" }).click();
    expect(await page.locator("output").textContent()).toBe("Background editing");

    const facts = () =>
      application.evaluate(() => (Reflect.get(globalThis, "testWindows") as WindowFixture).facts());
    const background = { focused: false, focusable: false, opacity: 0 };
    expect((await facts()).windows).toEqual([
      { ...background, visible: true },
      { ...background, visible: true },
      { ...background, visible: false },
    ]);

    const assertInactive = async () => {
      const current = await facts();
      expect(current.focusEvents).toBe(0);
      expect(current.shows.length).toBeGreaterThanOrEqual(2);
      for (const show of current.shows) expect(show).toMatchObject(background);
      for (const window of current.windows) expect(window).toMatchObject(background);
      if (process.platform !== "darwin") return;
      expect(current.dockVisible).toBe(false);
      const front = execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" }).trim();
      const info = execFileSync("/usr/bin/lsappinfo", ["info", "-only", "pid", front], {
        encoding: "utf8",
      });
      const pid = /\bpid\s*=\s*(\d+)/.exec(info)?.[1];
      expect(pid).toBeDefined();
      expect(Number(pid)).not.toBe(application.process().pid);
    };
    await assertInactive();
    for (const method of ["show", "showInactive", "focus"] as const) {
      await application.evaluate(({ app, BrowserWindow }, method) => {
        const id = (Reflect.get(globalThis, "testWindows") as WindowFixture).deferredId;
        const window = BrowserWindow.fromId(id)!;
        window.hide();
        window[method]();
        app.focus({ steal: true });
      }, method);
      expect((await facts()).windows.every((window) => window.visible)).toBe(true);
      await assertInactive();
    }
    const pixel = await application.evaluate(async ({ BrowserWindow }) => {
      const id = (Reflect.get(globalThis, "testWindows") as WindowFixture).automaticId;
      const window = BrowserWindow.fromId(id)!;
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
      return Array.from(image.toBitmap().subarray(0, 4));
    });
    expect(pixel).toEqual([56, 34, 12, 255]);
  } finally {
    await application.close().finally(cleanup);
  }
}, 30_000);
