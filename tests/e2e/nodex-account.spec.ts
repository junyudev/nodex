import { expect, test } from "@playwright/test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
