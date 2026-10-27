import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseUi } from "../../scripts/scenarios/scenarios/board-dense-ui";
import {
  captureNodexBrowserHandoff,
  expectNodexAccount,
  readNativeAccount,
  readNodexAccount,
} from "./fixtures/nodex-account-ui";
import { startNodexOAuthHttpFixture } from "./fixtures/nodex-oauth-http";
import { openWorkbenchSettings } from "./support/workbench-settings";

const imageUrl = "https://images.nodex.invalid/account-review.svg";
const menuTrigger = (page: Page) =>
  page.getByRole("button", { name: "Account and settings", exact: true });
const openMenu = async (page: Page) => {
  await menuTrigger(page).click();
  await expect(page.getByRole("menu")).toBeVisible();
};
const backToApp = async (page: Page) => {
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(menuTrigger(page)).toBeVisible();
};
const setMode = async (page: Page, mode: "Light" | "Dark") => {
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  const radio = page.getByRole("radio", { name: mode, exact: true });
  await radio.locator("..").click();
  await expect(radio).toBeChecked();
};

test("shares the account menu and Settings identity while native login and local work remain independent", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_ACCOUNT_MENU_ARTIFACT_DIR ?? testInfo.outputPath("account-menu");
  const preliminary = process.env.NODEX_ACCOUNT_MENU_PRELIMINARY === "1";
  await mkdir(artifacts, { recursive: true });
  const oauth = await startNodexOAuthHttpFixture({ imageUrl });
  const harness = await ElectronScenarioHarness.create({
    label: "nodex-account-menu",
    environment: oauth.environment,
  });
  const nativeAuthPath = path.join(harness.profile.codexHome, "auth.json");
  const nativeAuth = `${JSON.stringify({ OPENAI_API_KEY: "synthetic-native-account-marker" })}\n`;
  const claudeAuthPath = path.join(harness.profile.claudeConfigHome, ".credentials.json");
  const claudeAuth = `${JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-claude-marker" } })}\n`;
  const claims: Array<{ name: string; expected: unknown; actual: unknown }> = [];
  const colorMeasurements: Array<{ mode: "light" | "dark"; actual: unknown }> = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  let recording: Page | undefined;
  let status = "failed";
  let stage = "setup";
  try {
    await writeFile(nativeAuthPath, nativeAuth, { mode: 0o600 });
    await writeFile(claudeAuthPath, claudeAuth, { mode: 0o600 });
    const page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route(imageUrl, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        path: path.resolve("src/renderer/assets/subagent-avatars/00-honeycomb-light.svg"),
      }),
    );
    const seed = new RendererIpcSeedAdapter(page);
    const manifest = await materializeScenario(
      BOARD_DENSE_SCENARIO_ID,
      seed,
      harness.profile.initialProjectsDirectory,
    );
    const pageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY]!;
    const localBefore = await seed.readPage(manifest.projectId, pageId);
    const nativeBefore = await readNativeAccount(page);
    expect(nativeBefore.account).toMatchObject({ type: "chatgpt", email: "queue@example.com" });
    const handoffs = await captureNodexBrowserHandoff(harness.application);
    await openWorkbenchSettings(page);
    await setMode(page, "Light");
    await backToApp(page);
    await focusBoardDenseUi(page, manifest);
    const hold = async () => {
      await page.mouse.move(1240, 760);
      if (!preliminary) await page.waitForTimeout(800);
    };
    const screenshot = async (name: string) => {
      if (name.endsWith("account.png")) await expect(page.locator('[role="menu"]')).toHaveCount(0);
      await hold();
      if (name === "light-menu.png" || name === "dark-menu.png") {
        const actual = await page.getByRole("menu").evaluate((menu) => {
          const appearance = (element: Element) => {
            const style = getComputedStyle(element);
            return {
              color: style.color,
              backgroundColor: style.backgroundColor,
              borderColor: style.borderColor,
              boxShadow: style.boxShadow,
              opacity: style.opacity,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
            };
          };
          return {
            surface: appearance(menu),
            dividers: Array.from(menu.querySelectorAll("div"))
              .filter((element) => {
                const bounds = element.getBoundingClientRect();
                return (
                  element.childElementCount === 0 &&
                  bounds.height > 0 &&
                  bounds.height <= 1.5 &&
                  bounds.width > 10
                );
              })
              .map(appearance),
            items: Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => ({
              label: item.textContent?.trim(),
              ...appearance(item),
              icons: Array.from(item.querySelectorAll("svg")).map((icon) => {
                let effectiveOpacity = 1;
                for (
                  let element: Element | null = icon;
                  element && element !== menu;
                  element = element.parentElement
                ) {
                  effectiveOpacity *= Number(getComputedStyle(element).opacity);
                }
                const style = getComputedStyle(icon);
                return {
                  ...appearance(icon),
                  effectiveOpacity,
                  fill: style.fill,
                  stroke: style.stroke,
                };
              }),
              text: Array.from(item.querySelectorAll("span"))
                .filter((span) => span.childElementCount === 0 && span.textContent?.trim())
                .map((span) => ({ label: span.textContent?.trim(), ...appearance(span) })),
            })),
          };
        });
        colorMeasurements.push({ mode: name === "light-menu.png" ? "light" : "dark", actual });
      }
      await page.screenshot({ path: path.join(artifacts, name) });
    };
    if (!preliminary) {
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
      });
      await page.screencast.showActions({
        position: "bottom",
        style: { title: "font-size: 14px" },
      });
      recording = page;
    }

    stage = "keyboard-menu";
    await menuTrigger(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    const signedOutActions = async () => ({
      count: await page.getByRole("menuitem").count(),
      settings: await page.getByRole("menuitem", { name: "Settings", exact: true }).isVisible(),
      signIn: await page.getByRole("menuitem", { name: "Sign in", exact: true }).isVisible(),
    });
    claim(
      "Signed-out menu offers Settings and first-party sign-in",
      { count: 2, settings: true, signIn: true },
      await signedOutActions(),
    );
    const geometry = await page.getByRole("menu").boundingBox();
    claim(
      "Account menu fits within the window",
      true,
      Boolean(
        geometry &&
        geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.x + geometry.width <= 1280 &&
        geometry.y + geometry.height <= 800,
      ),
    );
    await screenshot("signed-out-menu.png");
    await page.keyboard.press("Escape");
    await expect(menuTrigger(page)).toBeFocused();
    claim(
      "Escape returns keyboard focus to the account trigger",
      true,
      await menuTrigger(page).evaluate((element) => document.activeElement === element),
    );
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "General", exact: true, level: 1 }),
    ).toBeVisible();
    claim(
      "Keyboard Settings action opens General",
      true,
      await page.getByRole("heading", { name: "General", exact: true, level: 1 }).isVisible(),
    );
    await backToApp(page);

    stage = "menu-login";
    await openMenu(page);
    await page.getByRole("menuitem", { name: "Sign in", exact: true }).click();
    await expectNodexAccount(page, { status: "signing-in" });
    await expect.poll(async () => (await handoffs()).length).toBe(1);
    const callback = await oauth.authorize((await handoffs())[0]!);
    expect((await fetch(callback)).status).toBe(200);
    await expectNodexAccount(page, { status: "signed-in", connection: "available" });
    const avatar = menuTrigger(page).locator("img");
    await expect(avatar).toBeVisible();
    await expect
      .poll(() =>
        avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    claim(
      "Account image loads through the real browser",
      true,
      await avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    );
    claim(
      "Menu sign-in completes one verified PKCE exchange",
      1,
      oauth.evidence().verifiedCodeExchanges,
    );
    await openMenu(page);
    const identityRow = page.getByRole("menuitem", { name: /Nodex Scenario/ });
    await expect(identityRow).toContainText(oauth.email);
    await screenshot("light-menu.png");
    await identityRow.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(
      page.getByTestId("settings-route-shell").getByText(oauth.email, { exact: true }),
    ).toBeVisible();
    claim(
      "Identity action opens the same account in Settings",
      oauth.email,
      await page
        .getByTestId("settings-route-shell")
        .getByText(oauth.email, { exact: true })
        .innerText(),
    );
    await screenshot("light-account.png");

    stage = "dark-account";
    await setMode(page, "Dark");
    await backToApp(page);
    await openMenu(page);
    await screenshot("dark-menu.png");
    await page.getByRole("menuitem", { name: /Nodex Scenario/ }).click();
    await expect(
      page.getByTestId("settings-route-shell").getByText(oauth.email, { exact: true }),
    ).toBeVisible();
    await screenshot("dark-account.png");
    await backToApp(page);

    stage = "menu-sign-out";
    await openMenu(page);
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-out", account: null });
    await expect(menuTrigger(page).locator("img")).toHaveCount(0);
    claim("Sign out removes the avatar image", 0, await menuTrigger(page).locator("img").count());
    await openMenu(page);
    claim(
      "Sign out clears the menu identity",
      { count: 2, settings: true, signIn: true },
      await signedOutActions(),
    );
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "General", exact: true, level: 1 }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Account", exact: true }).click();
    await expect(page.getByText("Not signed in", { exact: true })).toBeVisible();
    claim(
      "Account settings immediately reflects menu sign-out",
      true,
      await page.getByText("Not signed in", { exact: true }).isVisible(),
    );
    claim(
      "Native Codex identity is unchanged",
      nativeBefore.account,
      (await readNativeAccount(page)).account,
    );
    claim(
      "Native Codex credential remains byte-identical",
      true,
      (await readFile(nativeAuthPath, "utf8")) === nativeAuth,
    );
    claim(
      "Native Claude credential remains byte-identical",
      true,
      (await readFile(claudeAuthPath, "utf8")) === claudeAuth,
    );
    await screenshot("signed-out-account.png");
    await backToApp(page);

    stage = "local-work";
    await focusBoardDenseUi(page, manifest);
    const localAfter = await seed.readPage(manifest.projectId, pageId);
    claim(
      "Local Page remains intact",
      { title: localBefore.title, descriptionPreview: localBefore.descriptionPreview },
      { title: localAfter.title, descriptionPreview: localAfter.descriptionPreview },
    );
    const editor = page.locator('.nfm-editor .ProseMirror[contenteditable="true"]:visible');
    await editor.click();
    await page.keyboard.press("ControlOrMeta+Home");
    const localEdit = "Local editing continues after account menu sign out.";
    await page.keyboard.insertText(localEdit);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await seed.readPage(manifest.projectId, pageId)).descriptionPreview)
      .toContain(localEdit);
    claim(
      "Local editing commits while Nodex remains signed out",
      { saved: true, status: "signed-out" },
      {
        saved: (await seed.readPage(manifest.projectId, pageId)).descriptionPreview.includes(
          localEdit,
        ),
        status: (await readNodexAccount(page)).status,
      },
    );
    claim("OAuth fixture reports no invalid request", [], oauth.evidence().invalidRequests);
    await screenshot("final.png");
    status = "passed";
    stage = "complete";
  } finally {
    try {
      await recording?.screencast.stop();
      await writeFile(
        path.join(artifacts, "result.json"),
        `${JSON.stringify({ status, stage, fixture: "board/dense@3; disposable Electron Profile; local OAuth and native Codex peers; synthetic HTTPS avatar", preliminary, claims }, null, 2)}\n`,
      );
      await writeFile(
        path.join(artifacts, "computed-colors.json"),
        `${JSON.stringify({ purpose: "Actual browser measurements for visual review; not styling assertions", measurements: colorMeasurements }, null, 2)}\n`,
      );
      await writeFile(
        path.join(artifacts, "README.md"),
        `# Account menu verification\n\nStatus: **${status}**.\n\nThe real Electron/Main/preload/UI workflow uses a fresh Profile and public board/dense seed. The local OAuth peer verifies PKCE; Chromium decodes a synthetic HTTPS account image. Keyboard menu navigation, Escape focus, identity-to-Account routing, light/dark presentation, sign-out convergence, native credential isolation and committed local editing have exact assertions in result.json.\n\n${preliminary ? "Preliminary screenshots for visual review; no video recorded." : "One uninterrupted native review.webm begins after startup and seeding and ends on the editable local Page. final.png records the settled result."}\n\nThis fixture does not verify real Clerk login, native provider authentication, Stripe or subscriptions. Previous live Clerk evidence is stored separately.\n\nRun: NODEX_ACCOUNT_MENU_ARTIFACT_DIR=<absolute-path> vp run test:e2e tests/e2e/nodex-account-menu.spec.ts. Set NODEX_ACCOUNT_MENU_PRELIMINARY=1 for screenshots only.\n`,
      );
    } finally {
      try {
        await harness.close();
      } finally {
        await oauth.close();
      }
    }
  }
});
