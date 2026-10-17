import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { attachComposerFailureEvidence } from "./support/composer-failure-evidence";
import { openNewChatDraft } from "./support/new-chat-draft";
import { openSubagentsPanel } from "./support/subagents-panel";

const repositoryRoot = process.cwd();
const scenarioThreadTimestampHex = Date.now().toString(16).padStart(12, "0");
const scenarioThreadId = (suffix: string): string =>
  `${scenarioThreadTimestampHex.slice(0, 8)}-${scenarioThreadTimestampHex.slice(8)}-7000-8000-${suffix}`;
const rootThreadId = scenarioThreadId("000000000101");
const childThreadIds = new Set([
  ...Array.from({ length: 5 }, (_, index) =>
    scenarioThreadId(String(201 + index).padStart(12, "0")),
  ),
  ...Array.from({ length: 12 }, (_, index) =>
    scenarioThreadId(String(301 + index).padStart(12, "0")),
  ),
]);

interface RpcEntry {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A Codex whose root Turn spawns 17 children; Agent execution follows them from its own Turns. */
const createSubagentHarness = async (
  label: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<ElectronScenarioHarness> => {
  const harness = await ElectronScenarioHarness.create({
    label,
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_SUBAGENT_UUID_V7_TIMESTAMP_HEX: scenarioThreadTimestampHex,
      NODEX_FAKE_SUBAGENT_SPAWN: "1",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      ...environment,
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(repositoryRoot, "tests/e2e/fixtures/codex-subagent-app-server.mjs"),
  );
  return harness;
};

const startSubagentScenario = async (harness: ElectronScenarioHarness): Promise<Page> => {
  const page = await harness.launch();
  const scene = await openNewChatDraft(page);
  const composer = scene.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  const sendButton = scene.getByRole("button", { name: "Send prompt" });
  try {
    await expect(composer).toBeVisible();
    await composer.fill("Coordinate the bounded subagent scenario");
    await expect(sendButton).toBeEnabled();
  } catch (error) {
    await attachComposerFailureEvidence(page, test.info());
    throw error;
  }
  await sendButton.click();
  return page;
};

const readRpcEntries = (harness: ElectronScenarioHarness): RpcEntry[] => {
  const logPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcEntry);
};

const overviewSections = (page: Page) => {
  const panel = page.locator("[data-subagents-panel-overview]").first();
  return {
    panel,
    active: panel.locator('[data-subagent-overview-section="active"]'),
    done: panel.locator('[data-subagent-overview-section="done"]'),
  };
};

const rows = (section: Locator) => section.locator('[aria-label^="Open subagent "]');

/** The overview reads each section a page at a time; load every page the section offers. */
const expandSection = async (section: Locator): Promise<void> => {
  const more = section.getByRole("button", { name: "Show more" });
  while ((await more.count()) > 0) {
    const shown = await rows(section).count();
    await more.click();
    await expect
      .poll(async () => (await more.count()) === 0 || (await rows(section).count()) > shown)
      .toBe(true);
  }
};

test("shows an Agent chat's subagents and reads the selected child without resuming it", async () => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-overview-and-selected-child");
  try {
    const page = await startSubagentScenario(harness);
    await page.setViewportSize({ width: 1440, height: 960 });
    await openSubagentsPanel(page);
    const { panel, active, done } = overviewSections(page);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(active.getByRole("heading", { name: "Active · 4" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(rows(active)).toHaveCount(4);
    await expect(
      active.getByRole("button", { name: "Open subagent Approval sentinel" }),
    ).toBeVisible();
    // Done is read a page at a time but counts every finished subagent from the start.
    await expect(done.getByRole("heading", { name: "Done · 13" })).toBeVisible({
      timeout: 30_000,
    });
    await expandSection(done);
    await expect(done.getByRole("heading", { name: "Done · 13" })).toBeVisible();
    await expect(rows(done)).toHaveCount(13);
    await expect(done.getByRole("button", { name: "Open subagent Reconnect scout" })).toBeVisible();

    await active.getByRole("button", { name: "Open subagent Deep investigator" }).click();
    const sidePanel = page.locator('[data-subagents-side-panel-tab^="subagents:"]');
    await expect(sidePanel).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    await expect(
      sidePanel.getByText("Checking the selected child history.", { exact: true }),
    ).toBeVisible();
    // A child is read here, never continued: it has no Composer and its Codex thread stays put.
    await expect(sidePanel.locator('[data-codex-composer="true"]')).toHaveCount(0);
    await expect(page.locator('[data-codex-composer="true"]')).toHaveCount(1);
    expect(
      readRpcEntries(harness).filter(
        (entry) =>
          entry.method === "thread/resume" &&
          typeof entry.params.threadId === "string" &&
          childThreadIds.has(entry.params.threadId),
      ),
    ).toEqual([]);
    await sidePanel.getByRole("button", { name: "Back to subagents" }).click();
    await expect(panel).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("omits an empty Done section and remains usable at narrow width", async () => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-zero-done-narrow", {
    NODEX_FAKE_SUBAGENT_DONE_COUNT: "0",
    NODEX_FAKE_SUBAGENT_SCOUT_ACTIVE: "1",
  });
  try {
    const page = await startSubagentScenario(harness);
    // Crossing the shell breakpoint closes competing panels. Establish the
    // narrow layout before opening the overview whose usability is under test.
    await page.setViewportSize({ width: 820, height: 720 });
    await expect(page.locator("[data-app-shell-width-class]")).toHaveAttribute(
      "data-app-shell-width-class",
      "medium",
    );
    await openSubagentsPanel(page);
    const { panel, active } = overviewSections(page);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(active.getByRole("heading", { name: "Active · 5" })).toBeVisible({
      timeout: 30_000,
    });
    await expandSection(active);
    await expect(rows(active)).toHaveCount(5);
    await expect(panel.locator('[data-subagent-overview-section="done"]')).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: /^Done/u })).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Open subagent Deep investigator" }),
    ).toBeVisible();
    const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await harness.close();
  }
});

test("stopping the root stops each active child once and settles every subagent as Done", async () => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-root-stop", {
    NODEX_FAKE_SUBAGENT_SCOUT_ACTIVE: "1",
  });
  try {
    const page = await startSubagentScenario(harness);
    await openSubagentsPanel(page);
    const { panel, active, done } = overviewSections(page);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(done.getByRole("heading", { name: "Done · 12" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(active.getByRole("heading", { name: "Active · 5" })).toBeVisible();
    await expandSection(active);
    await expandSection(done);

    const rootComposer = page.locator('[data-codex-composer="true"]').first();
    await rootComposer.click();
    await rootComposer.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await rootComposer.press("Backspace");
    const stopButton = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stopButton).toBeVisible();
    await stopButton.click();

    await expect(active.getByRole("heading", { name: "Active · 0" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(active.getByText("No active subagents", { exact: true })).toBeVisible();
    await expandSection(done);
    await expect(done.getByRole("heading", { name: "Done · 17" })).toBeVisible();
    await expect(stopButton).toHaveCount(0);
    const interrupts = readRpcEntries(harness)
      .filter((entry) => entry.method === "turn/interrupt")
      .map((entry) => entry.params.threadId);
    expect(interrupts.filter((threadId) => threadId === rootThreadId)).toHaveLength(1);
    const childInterrupts = interrupts.filter((threadId) => threadId !== rootThreadId);
    expect(new Set(childInterrupts).size).toBe(childInterrupts.length);
    expect(childInterrupts).toHaveLength(5);
  } finally {
    await harness.close();
  }
});
