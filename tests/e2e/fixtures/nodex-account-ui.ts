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
  if (!(await account.isVisible()))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
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
