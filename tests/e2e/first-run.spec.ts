import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { captureNodexBrowserHandoff, startNodexLogin } from "./fixtures/nodex-account-ui";
import { startNodexOAuthHttpFixture } from "./fixtures/nodex-oauth-http";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/agent-smoke-harness";

const setup = (page: Page) => page.getByRole("dialog", { name: "Set up Nodex" });

/** Scenarios normally come with a signed-in Codex, and setup is about having none yet. */
const NO_AGENT = { NODEX_FAKE_CODEX_SIGNED_OUT: "1" };

const projectList = async (page: Page) =>
  ((await invokeIpc(page, "projects:list")) as { items: { id: string; name: string }[] }).items;

/** One Claude Code conversation in `cwd`, as that Agent writes its own history. */
function writeClaudeConversation(configHome: string, cwd: string): void {
  const sessionId = createUuidV7();
  const userId = createUuidV7();
  const directory = path.join(configHome, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(
    path.join(directory, `${sessionId}.jsonl`),
    [
      {
        type: "user",
        uuid: userId,
        parentUuid: null,
        sessionId,
        cwd,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "Fix the build" }] },
      },
      {
        type: "assistant",
        uuid: createUuidV7(),
        parentUuid: userId,
        sessionId,
        cwd,
        timestamp,
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "Fixed." }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
}

/** Makes Claude Code a ready Agent without any account, through its ordinary profile setting. */
async function connectScriptedClaude(page: Page, runRoot: string): Promise<void> {
  const executable = path.join(runRoot, "claude");
  const peer = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
  ).href;
  writeFileSync(executable, `#!${process.execPath}\nimport(${JSON.stringify(peer)});\n`, {
    mode: 0o755,
  });
  const settings = (await invokeIpc(page, "settings:claude-agents:get")) as {
    instances: readonly Record<string, unknown>[];
  };
  await invokeIpc(page, "settings:claude-agents:update", {
    instances: settings.instances.map((instance) => ({
      ...instance,
      binaryPath: executable,
      enabled: true,
    })),
  });
}

test.describe("first run", () => {
  test("skipping creates nothing, and the Composer asks for an Agent", async () => {
    test.setTimeout(180_000);
    const harness = await ElectronScenarioHarness.create({
      label: "first-run-skip",
      emptyProfile: true,
      environment: NO_AGENT,
    });
    try {
      const page = await harness.launch();
      await expect(setup(page).getByRole("heading", { name: "Connect an agent" })).toBeVisible();
      expect(await projectList(page)).toEqual([]);
      expect(readdirSync(harness.profile.projectsDirectory)).toEqual([]);

      await setup(page).getByRole("button", { name: "Skip" }).click();
      await expect(setup(page)).toHaveCount(0);
      await expect(page.getByText("Connect an agent to start")).toBeVisible({ timeout: 60_000 });
      expect(await projectList(page)).toEqual([]);

      // Skipping is remembered, even though the Profile is still empty.
      const reopened = await harness.restart();
      await expect(reopened.getByText("Connect an agent to start")).toBeVisible({
        timeout: 60_000,
      });
      await expect(setup(reopened)).toHaveCount(0);

      // The notice leads back to just the Agents page.
      await reopened.getByRole("button", { name: "Connect" }).click();
      await expect(
        setup(reopened).getByRole("heading", { name: "Connect an agent" }),
      ).toBeVisible();
      await setup(reopened).getByRole("button", { name: "Close" }).click();
      await expect(setup(reopened)).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("Nodex credits are optional, and funding them leaves a model to choose", async () => {
    test.setTimeout(240_000);
    const oauth = await startNodexOAuthHttpFixture();
    oauth.setBalance(0);
    const harness = await ElectronScenarioHarness.create({
      label: "first-run-credits",
      emptyProfile: true,
      environment: { ...NO_AGENT, ...oauth.environment },
    });
    try {
      const page = await harness.launch();
      const flow = setup(page);
      const readHandoffs = await captureNodexBrowserHandoff(harness.application);
      await expect(flow.getByRole("button", { name: "Continue without an agent" })).toBeEnabled({
        timeout: 60_000,
      });

      const callback = await oauth.authorize(
        await startNodexLogin(harness, readHandoffs, "Get started"),
      );
      expect((await fetch(callback)).status).toBe(200);

      // Signed in with an empty wallet: the tiers are right there, and nothing waits on them.
      const tier = flow.getByRole("button", { name: "Pay $10 for 275 credits" });
      await expect(tier).toBeEnabled({ timeout: 60_000 });
      await expect(flow.getByRole("button", { name: "Continue without an agent" })).toBeEnabled();

      await tier.click();
      await expect(flow.getByText("Waiting for payment…")).toBeVisible();
      await expect.poll(() => oauth.evidence().checkouts).toEqual([10]);

      // The payment finishes in the browser, and the row notices by itself.
      oauth.setBalance(11);
      await expect(tier).toHaveCount(0, { timeout: 60_000 });
      await expect(flow.getByText("275 credits", { exact: true })).toBeVisible();

      await flow.getByRole("button", { name: "Continue", exact: true }).click();
      await flow.getByRole("button", { name: "Skip" }).click();
      await expect(flow).toHaveCount(0);

      // Credits are never spent automatically, so the Composer waits for a choice of model.
      await expect(page.getByRole("button", { name: "Select model" }).first()).toContainText(
        "Choose model",
        { timeout: 60_000 },
      );
      await expect(page.getByText("Connect an agent to start")).toHaveCount(0);

      // Sending before choosing asks for the choice, and the message stays.
      const composer = page.locator('[data-codex-composer="true"]:visible').first();
      await composer.fill("Hello");
      await composer.press("Enter");
      await expect(
        page.getByRole("combobox", { name: "Search models", exact: true }),
      ).toBeVisible();
      await expect(composer).toContainText("Hello");
    } finally {
      try {
        await harness.close();
      } finally {
        await oauth.close();
      }
    }
  });

  test("finds a project in Agent history, resumes after a quit, and lands with a first task", async () => {
    test.setTimeout(240_000);
    const harness = await ElectronScenarioHarness.create({
      label: "first-run-project",
      emptyProfile: true,
      environment: NO_AGENT,
    });
    try {
      // Temporary folders are never offered, and a scenario's Profile lives in one.
      const repository = test.info().outputPath("widgets");
      mkdirSync(repository, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: repository });
      for (let chat = 0; chat < 3; chat += 1) {
        writeClaudeConversation(harness.profile.claudeConfigHome, realpathSync(repository));
      }

      const page = await harness.launch();
      const flow = setup(page);
      await expect(flow.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
      await expect(flow.getByRole("button", { name: "Continue without an agent" })).toBeEnabled({
        timeout: 60_000,
      });
      await connectScriptedClaude(page, harness.profile.runRoot);
      // Finishing an Agent's setup elsewhere shows up on coming back to the window.
      const proceed = flow.getByRole("button", { name: "Continue", exact: true });
      await expect(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(proceed).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      await proceed.click();

      await expect(flow.getByRole("heading", { name: "Where should agents work?" })).toBeVisible();
      // Quitting part-way comes back to the same page.
      const reopened = await harness.restart();
      const resumed = setup(reopened);
      await expect(
        resumed.getByRole("heading", { name: "Where should agents work?" }),
      ).toBeVisible();
      const widgets = resumed.getByRole("checkbox", { name: "widgets" });
      await expect(widgets).toBeChecked({ timeout: 60_000 });
      expect(await projectList(reopened)).toEqual([]);

      await resumed.getByRole("button", { name: "Add project" }).click();
      await expect(resumed).toHaveCount(0);
      expect(await projectList(reopened)).toEqual([expect.objectContaining({ name: "widgets" })]);

      // The first task waits in the Composer, unsent.
      await expect(
        reopened
          .locator('[data-codex-composer="true"]:visible')
          .filter({ hasText: "Get to know this project" }),
      ).toBeVisible();
      await expect(reopened.getByText("What should we build in widgets?")).toBeVisible();
    } finally {
      await harness.close();
    }
  });

  test("a Profile that already holds work never sees setup", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "first-run-existing" });
    try {
      const page = await harness.launch();
      await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible();
      await expect(setup(page)).toHaveCount(0);
      expect(await projectList(page)).toEqual([expect.objectContaining({ name: "My Project" })]);
      expect(existsSync(path.join(harness.profile.projectsDirectory, "My Project"))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
