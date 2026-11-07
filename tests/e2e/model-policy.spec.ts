import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  captureNodexBrowserHandoff,
  completeNodexLogin,
  openNodexAccount,
} from "./fixtures/nodex-account-ui";
import { startNodexOAuthHttpFixture } from "./fixtures/nodex-oauth-http";
import { composerModelLabel, openComposerModelPicker } from "./support/composer-model-picker";
import { openWorkbenchSettings } from "./support/workbench-settings";

const creditProviders = async (page: Page) =>
  (
    (await page.evaluate(() =>
      window.api!.invoke("agent-runtime:providers:read", {}),
    )) as AgentRuntimeOperations["providers.read"]["output"]
  ).filter((provider) => provider.source === "nodex");

const openModelsSettings = async (page: Page) => {
  await openWorkbenchSettings(page);
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
};

const startNewChat = async (page: Page) => {
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await page
    .getByRole("button", { name: /Start new chat in/u })
    .first()
    .click();
};

test("turning models off removes them everywhere and survives a restart", async () => {
  test.setTimeout(240_000);
  const oauth = await startNodexOAuthHttpFixture();
  const harness = await ElectronScenarioHarness.create({
    label: "model-policy",
    environment: oauth.environment,
  });
  const artifacts = process.env.NODEX_REVIEW_ARTIFACTS;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const shot = async (page: Page, name: string) => {
    if (artifacts) await page.screenshot({ path: path.join(artifacts, name) });
  };
  try {
    let page = await harness.launch();
    const readHandoffs = await captureNodexBrowserHandoff(harness.application);
    await openNodexAccount(page);
    await completeNodexLogin(harness, oauth, readHandoffs);

    // Credits sit with the models that spend them, and Agents can't reach them by default.
    await openModelsSettings(page);
    await expect(page.getByText("Spends your credits. 312 left.", { exact: true })).toBeVisible();
    await expect(page.getByText("4 of 4 on", { exact: true })).toBeVisible({ timeout: 60_000 });
    const agents = page.getByRole("switch", {
      name: "Let Agents choose Nodex models",
      exact: true,
    });
    await expect(agents).not.toBeChecked();
    await shot(page, "models-settings.png");

    // An off model leaves the list and answers a search, marked off.
    await page.getByRole("switch", { name: "GPT-6.1 Sol", exact: true }).click();
    await expect(page.getByText("3 of 4 on", { exact: true })).toBeVisible();
    await startNewChat(page);
    let search = await openComposerModelPicker(page);
    const options = page.getByRole("listbox").getByRole("option");
    await expect(options.filter({ hasText: "Nodex" })).toHaveCount(3);
    await expect(page.getByRole("button", { name: /models? off$/u })).toBeVisible();
    await shot(page, "model-picker-off.png");
    await search.fill("GPT-6.1 Sol");
    const offRow = page.getByRole("option", { name: /GPT-6\.1 Sol.*Nodex.*Off/u });
    await expect(offRow).toBeVisible();
    await shot(page, "model-picker-search.png");

    // Credit is only turned back on deliberately: choosing it lands on its setting.
    await offRow.click();
    await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "GPT-6.1 Sol", exact: true })).not.toBeChecked();

    page = await harness.restart();
    await openModelsSettings(page);
    await expect(page.getByRole("switch", { name: "GPT-6.1 Sol", exact: true })).not.toBeChecked();

    // Nodex off closes credit while the account stays signed in, and a launch is refused outright.
    const [codexRuntime] = await creditProviders(page);
    if (!codexRuntime) throw new Error("A signed-in account lists its Nodex models.");
    await page.getByRole("switch", { name: "Turn off all Nodex models", exact: true }).click();
    await expect(
      page.getByText("Off. Nothing on this computer can spend your credits.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await creditProviders(page)).flatMap((provider) =>
            provider.models.filter((model) => model.policy?.on !== false),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0);
    const refusal = await page.evaluate(
      ({ instanceId, launchId, sessionId, messageId }) =>
        (
          window.api!.invoke("agent-runtime:session:launch", {
            launchId,
            acceptedAt: Date.now(),
            sessionId,
            projectId: null,
            title: "Refused",
            modelSelection: { instanceId, model: "gpt-6-luna" },
            interactionMode: "default",
            message: { messageId, text: "This must never reach the gateway." },
          } as never) as Promise<unknown>
        ).then(
          () => null,
          (error: unknown) => String(error),
        ),
      {
        instanceId: codexRuntime.instanceId,
        launchId: createUuidV7(),
        sessionId: createUuidV7(),
        messageId: createUuidV7(),
      },
    );
    expect(refusal).toContain("is off in Settings → Models");
    await shot(page, "models-settings-nodex-off.png");
    await startNewChat(page);
    search = await openComposerModelPicker(page);
    await search.fill("Nodex");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(0);
    await search.fill("");
    await page.keyboard.press("Escape");
    await openNodexAccount(page);
    await expect(page.getByLabel("Remaining credits")).toHaveText("312");

    // Turning it back on restores what each model was set to.
    await openModelsSettings(page);
    await page.getByRole("switch", { name: "Turn on Nodex", exact: true }).click();
    await expect(page.getByRole("switch", { name: "GPT-6.1 Sol", exact: true })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "GPT-6 Luna", exact: true })).toBeChecked();

    // A chat keeps its own model when that model turns off, and says so instead of swapping it.
    await startNewChat(page);
    search = await openComposerModelPicker(page);
    await search.fill("GPT-6 Luna");
    await page.getByRole("option", { name: /GPT-6 Luna.*Nodex/u }).click();
    await expect(composerModelLabel(page)).toContainText("GPT-6 Luna");
    await openModelsSettings(page);
    await page.getByRole("switch", { name: "GPT-6 Luna", exact: true }).click();
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(page.getByText("GPT-6 Luna on Nodex is off", { exact: true })).toBeVisible();
    await expect(composerModelLabel(page)).toContainText("GPT-6 Luna");
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toHaveCount(0);
    await shot(page, "composer-model-off.png");
    await page.getByRole("button", { name: "Choose model", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Search models", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: /GPT-6 Luna.*Off/u })).toBeDisabled();
    expect(oauth.evidence().invalidRequests).toEqual([]);
  } finally {
    await harness.close();
    await oauth.close();
  }
});
