import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { expect, test } from "@playwright/test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openComposerModelPicker } from "./support/composer-model-picker";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/board-dense";
import {
  captureNodexBrowserHandoff,
  expectNodexAccount,
  openNodexAccount,
  readNativeAccount,
  readNodexAccount,
  refreshNodexAccount,
} from "./fixtures/nodex-account-ui";
import {
  startNodexOAuthHttpFixture,
  type NodexOAuthHttpFixture,
} from "./fixtures/nodex-oauth-http";

const startLogin = async (
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

const completeLogin = async (
  harness: ElectronScenarioHarness,
  oauth: NodexOAuthHttpFixture,
  readHandoffs: () => Promise<string[]>,
): Promise<void> => {
  const callback = await oauth.authorize(await startLogin(harness, readHandoffs));
  expect((await fetch(callback)).status).toBe(200);
  await expectNodexAccount(harness.page, {
    status: "signed-in",
    connection: "available",
    error: null,
  });
  await expect(harness.page.getByText(oauth.email, { exact: true })).toBeVisible();
};

test("keeps native and local state while Nodex login refreshes, survives restart and signs out", async () => {
  test.setTimeout(180_000);
  const oauth = await startNodexOAuthHttpFixture();
  const harness = await ElectronScenarioHarness.create({
    label: "nodex-account-persistence",
    environment: oauth.environment,
  });
  const nativeAuthPath = path.join(harness.profile.codexHome, "auth.json");
  const nativeAuth = `${JSON.stringify({ OPENAI_API_KEY: "synthetic-native-account-marker" })}\n`;
  const claudeAuthPath = path.join(harness.profile.claudeConfigHome, ".credentials.json");
  const claudeAuth = `${JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-claude-marker" } })}\n`;
  const credentialPath = path.join(harness.profile.nodexHome, "account/credentials.enc");
  try {
    await writeFile(nativeAuthPath, nativeAuth, { mode: 0o600 });
    await writeFile(claudeAuthPath, claudeAuth, { mode: 0o600 });
    let page = await harness.launch();
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
    const readHandoffs = await captureNodexBrowserHandoff(harness.application);
    await openNodexAccount(page);
    await completeLogin(harness, oauth, readHandoffs);
    await expectNodexAccount(page, { persistence: "secure" });

    await refreshNodexAccount(page);
    await expect.poll(() => oauth.evidence().refreshes).toBe(1);
    await expectNodexAccount(page, { status: "signed-in", connection: "available" });
    const encrypted = await readFile(credentialPath);
    expect(encrypted.byteLength).toBeGreaterThan(0);
    expect(encrypted.includes(Buffer.from("scenario-access-"))).toBe(false);
    expect(encrypted.includes(Buffer.from("scenario-refresh-"))).toBe(false);
    if (process.platform !== "win32") expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);

    oauth.setAvailable(false);
    await refreshNodexAccount(page);
    await expectNodexAccount(page, { status: "signed-in", connection: "unavailable" });
    expect((await readNodexAccount(page)).account?.subject).toBe(oauth.subject);
    oauth.setAvailable(true);
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-in", connection: "available", error: null });

    page = await harness.restart();
    await openNodexAccount(page);
    await expectNodexAccount(page, {
      status: "signed-in",
      connection: "available",
      persistence: "secure",
    });
    await expect(page.getByText(oauth.email, { exact: true })).toBeVisible();
    expect(oauth.evidence().verifiedCodeExchanges).toBe(1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-out", account: null, persistence: null });
    await expect.poll(() => oauth.evidence().revocations).toBe(1);
    await expect(stat(credentialPath)).rejects.toMatchObject({ code: "ENOENT" });

    const localAfter = await new RendererIpcSeedAdapter(page).readPage(manifest.projectId, pageId);
    expect(localAfter).toMatchObject({
      pageId: localBefore.pageId,
      title: localBefore.title,
      descriptionPreview: localBefore.descriptionPreview,
      documentReadiness: "ready",
    });
    expect((await readNativeAccount(page)).account).toEqual(nativeBefore.account);
    expect(await readFile(nativeAuthPath, "utf8")).toBe(nativeAuth);
    expect(await readFile(claudeAuthPath, "utf8")).toBe(claudeAuth);
    expect(oauth.evidence().invalidRequests).toEqual([]);
  } finally {
    try {
      await harness.close();
    } finally {
      await oauth.close();
    }
  }
});

test("rejects canceled and wrong-state callbacks and retires a revoked Nodex grant", async () => {
  test.setTimeout(120_000);
  const oauth = await startNodexOAuthHttpFixture();
  const harness = await ElectronScenarioHarness.create({
    label: "nodex-account-callbacks",
    environment: oauth.environment,
  });
  try {
    const page = await harness.launch();
    const readHandoffs = await captureNodexBrowserHandoff(harness.application);
    await openNodexAccount(page);
    const abandonedCallback = await oauth.authorize(await startLogin(harness, readHandoffs));
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-out", account: null });

    const callback = await oauth.authorize(await startLogin(harness, readHandoffs));
    const lateCallbackStatus = await fetch(abandonedCallback, {
      signal: AbortSignal.timeout(5_000),
    }).then(
      (response) => response.status,
      () => null,
    );
    // The OS may reuse the retired loopback port; the new attempt must still reject its state.
    expect([null, 400]).toContain(lateCallbackStatus);
    expect(oauth.evidence().verifiedCodeExchanges).toBe(0);
    await expectNodexAccount(page, { status: "signing-in", account: null });
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "unrelated-login-attempt");
    expect((await fetch(wrongState)).status).toBe(400);
    await expectNodexAccount(page, { status: "signing-in", account: null });
    expect((await fetch(callback)).status).toBe(200);
    await expectNodexAccount(page, { status: "signed-in", connection: "available" });
    expect(oauth.evidence().verifiedCodeExchanges).toBe(1);

    oauth.revokeGrants();
    await refreshNodexAccount(page);
    await expectNodexAccount(page, {
      status: "reauthentication-required",
      connection: "unavailable",
      error: "invalid-grant",
    });
    await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
    await expect(
      stat(path.join(harness.profile.nodexHome, "account/credentials.enc")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeEnabled();
    const renewedCallback = await oauth.authorize(
      await startLogin(harness, readHandoffs, "Sign in again"),
    );
    expect((await fetch(renewedCallback)).status).toBe(200);
    await expectNodexAccount(page, { status: "signed-in", connection: "available", error: null });
    expect(oauth.evidence().verifiedCodeExchanges).toBe(2);
    expect(oauth.evidence().invalidRequests).toEqual([]);
  } finally {
    try {
      await harness.close();
    } finally {
      await oauth.close();
    }
  }
});

test("offers prepaid Nodex models and credit only for the signed-in account", async () => {
  test.setTimeout(180_000);
  const oauth = await startNodexOAuthHttpFixture();
  const harness = await ElectronScenarioHarness.create({
    label: "nodex-models",
    environment: oauth.environment,
  });
  try {
    const page = await harness.launch();
    const readHandoffs = await captureNodexBrowserHandoff(harness.application);
    const catalog = async () =>
      (await page.evaluate(() =>
        window.api!.invoke("agent-runtime:providers:read", {}),
      )) as AgentRuntimeOperations["providers.read"]["output"];
    expect((await catalog()).filter((provider) => provider.source === "nodex")).toEqual([]);
    await openNodexAccount(page);
    await completeLogin(harness, oauth, readHandoffs);
    await expect(page.getByLabel("Remaining credit")).toHaveText("$12.50");
    const artifacts = process.env.NODEX_REVIEW_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.getByRole("button", { name: "Back to app", exact: true }).click();
      const setupNotice = page.getByRole("alert").filter({ hasText: "Global dictation is ready." });
      await setupNotice.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
      if (await setupNotice.isVisible())
        await setupNotice.getByRole("button", { name: "Dismiss notification" }).click();
      await openNodexAccount(page);
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
      });
      await page.screencast.showActions({ position: "bottom" });
    }
    // Account settings lays every tier out; there is no menu to open first.
    await expect(
      page.getByRole("button", { name: "Pay $5 for $35 credit", exact: true }),
    ).toBeDisabled();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "account-top-up.png") });
    await page.getByRole("button", { name: "Pay $2 for $14 credit", exact: true }).click();
    await expect.poll(readHandoffs).toContain("https://checkout.stripe.com/c/pay/synthetic-nodex");
    expect(oauth.evidence().checkouts).toEqual([2]);
    oauth.setBalance(26.5);
    await expect(page.getByLabel("Remaining credit")).toHaveText("$26.50", { timeout: 20_000 });
    await expectNodexAccount(page, { checkoutPending: false });
    const observedCredit = (await readNodexAccount(page)).credit?.balance;
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "account-credit.png") });
    const managed = (await catalog()).filter((provider) => provider.source === "nodex");
    expect(managed).toHaveLength(2);
    expect(
      managed.flatMap((provider) => provider.models.map((model) => model.slug)).sort(),
    ).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6.1-sol"]);
    expect(JSON.stringify(managed)).not.toContain("scenario-gateway-key");
    const encrypted = await readFile(
      path.join(harness.profile.nodexHome, "account/credentials.enc"),
    );
    expect(encrypted.includes(Buffer.from("scenario-gateway-key"))).toBe(false);
    oauth.setBalance(0);
    await refreshNodexAccount(page);
    await expect(page.getByLabel("Remaining credit")).toHaveText("$0.00");
    await page.screenshot({ path: test.info().outputPath("account-credit.png") });
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await page
      .getByRole("button", { name: /Start new chat in/u })
      .first()
      .click();
    const search = await openComposerModelPicker(page);
    await search.fill("Nodex");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(4);
    oauth.setModelAvailable("gpt-6-luna", false);
    await refreshNodexAccount(page);
    await expect(page.getByRole("option", { name: /GPT-6 Luna/u })).toBeDisabled();
    await expect(page.getByRole("option", { name: /GPT-6 Luna/u })).toContainText("Unavailable");
    const modelDisabled = await page.getByRole("option", { name: /GPT-6 Luna/u }).isDisabled();
    if (artifacts)
      await page
        .getByRole("listbox")
        .locator("..")
        .screenshot({ path: path.join(artifacts, "nodex-model-picker.png") });
    await page.screenshot({ path: test.info().outputPath("nodex-model-picker.png") });
    await page.getByRole("option", { name: /GPT-6.1 Sol/u }).click();
    await expect(page.getByRole("button", { name: "Select model", exact: true })).toContainText(
      "GPT-6.1 Sol",
    );
    await openComposerModelPicker(page);
    await page.getByRole("combobox", { name: "Search models" }).fill("Nodex");
    await page.getByRole("option", { name: /Claude Sonnet 5.5/u }).click();
    await expect(page.getByRole("button", { name: "Select model", exact: true })).toContainText(
      "Claude Sonnet 5.5",
    );
    // The rail credit meter shows the balance and leads to Account settings to buy.
    const creditMeter = page.locator("[data-nodex-credit-meter]");
    await creditMeter.hover();
    const creditCard = page.getByRole("dialog", { name: "Nodex credit details" });
    await expect(creditCard.getByLabel("Remaining credit")).toHaveText("$0.00");
    await creditCard.getByRole("button", { name: "Top up", exact: true }).click();
    await page.getByRole("button", { name: "Pay $2 for $14 credit", exact: true }).click();
    await expect.poll(() => oauth.evidence().checkouts).toEqual([2, 2]);
    oauth.setTopUpAvailable(false);
    await refreshNodexAccount(page);
    await expect(page.getByText("Top up is paused.", { exact: true })).toBeVisible();
    const topUpDisabled = await page
      .getByRole("button", { name: "Pay $2 for $14 credit", exact: true })
      .isDisabled();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "final.png") });
    if (artifacts) {
      await page.screencast.stop();
      await writeFile(
        path.join(artifacts, "result.json"),
        JSON.stringify(
          {
            status: "passed",
            scenario: "nodex-account prepaid models",
            claims: [
              {
                claim: "Checkout uses chosen amount",
                expected: [2, 2],
                actual: oauth.evidence().checkouts,
              },
              {
                claim: "Payment is observed automatically",
                expected: 26.5,
                actual: observedCredit,
              },
              {
                claim: "Closed Nodex catalog",
                expected: 4,
                actual: managed.flatMap((provider) => provider.models).length,
              },
              { claim: "Supply-limited model disabled", expected: true, actual: modelDisabled },
              { claim: "Paused top-up disabled", expected: true, actual: topUpDisabled },
            ],
          },
          null,
          2,
        ),
      );
    }
    await page.getByRole("button", { name: "Account and settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-out", credit: null });
    expect((await catalog()).filter((provider) => provider.source === "nodex")).toEqual([]);
    expect(oauth.evidence().invalidRequests).toEqual([]);
  } finally {
    if (process.env.NODEX_REVIEW_ARTIFACTS && !harness.page.isClosed())
      await harness.page.screencast.stop().catch(() => undefined);
    await harness.close();
    await oauth.close();
  }
});
