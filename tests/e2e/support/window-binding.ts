import type { Page } from "@playwright/test";
import type { WindowBootstrap } from "../../../src/shared/app-startup";

/** The Space, Window Session and capabilities Main resolves for this window now. */
export const readWindowBinding = async (page: Page): Promise<WindowBootstrap> =>
  (await page.evaluate(
    async () => await window.api?.invoke("app:await-initialization"),
  )) as WindowBootstrap;
