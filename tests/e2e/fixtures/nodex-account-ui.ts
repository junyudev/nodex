import type { ElectronScenarioHarness } from "../../../scripts/scenarios/harness/electron-e2e-harness";
import type { NodexOAuthHttpFixture } from "./nodex-oauth-http";
import { openWorkbenchSettings } from "../support/workbench-settings";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import type { IpcApi } from "../../../src/shared/ipc-api";
import {
  NodexAccountSnapshotSchema,
  type NodexAccountSnapshot,
} from "../../../src/shared/nodex-account";

export const readNodexAccount = async (page: Page): Promise<NodexAccountSnapshot> =>
  NodexAccountSnapshotSchema.parse(
    await page.evaluate(() => window.api!.invoke("nodex-account:read")),
  );

export const readNativeAccount = async (
  page: Page,
): Promise<IpcApi["codex:account:read"]["result"]> =>
  (await page.evaluate(() =>
    window.api!.invoke("codex:account:read"),
  )) as IpcApi["codex:account:read"]["result"];

export const expectNodexAccount = async (
  page: Page,
  expected: Partial<NodexAccountSnapshot>,
): Promise<void> => {
  await expect.poll(() => readNodexAccount(page)).toMatchObject(expected);
};

export const openNodexAccount = async (page: Page): Promise<void> => {
  const account = page.getByRole("link", { name: "Account", exact: true });
  if (!(await account.isVisible())) await openWorkbenchSettings(page);
  await account.click();
};

/** Replace only the OS browser handoff; discovery, callbacks and token exchanges stay real. */
export const captureNodexBrowserHandoff = async (
  application: ElectronApplication,
): Promise<() => Promise<string[]>> => {
  await application.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { nodexAccountOpenedUrls: opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  return () =>
    application.evaluate(
      () =>
        (globalThis as typeof globalThis & { nodexAccountOpenedUrls: string[] })
          .nodexAccountOpenedUrls,
    );
};

export const refreshNodexAccount = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.api!.invoke("nodex-account:refresh"));
};

export const startNodexLogin = async (
  harness: ElectronScenarioHarness,
  readHandoffs: () => Promise<string[]>,
  buttonName = "Sign in",
): Promise<string> => {
  const before = (await readHandoffs()).length;
  await harness.page.getByRole("button", { name: buttonName, exact: true }).click();
  await expectNodexAccount(harness.page, { status: "signing-in" });
  await expect.poll(async () => (await readHandoffs()).length).toBe(before + 1);
  return (await readHandoffs())[before]!;
};

export const completeNodexLogin = async (
  harness: ElectronScenarioHarness,
  oauth: NodexOAuthHttpFixture,
  readHandoffs: () => Promise<string[]>,
): Promise<void> => {
  const callback = await oauth.authorize(await startNodexLogin(harness, readHandoffs));
  expect((await fetch(callback)).status).toBe(200);
  await expectNodexAccount(harness.page, {
    status: "signed-in",
    connection: "available",
    error: null,
  });
  await expect(harness.page.getByText(oauth.email, { exact: true })).toBeVisible();
};
