import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { attachComposerFailureEvidence } from "./support/composer-failure-evidence";
import { openNewChatDraft } from "./support/new-chat-draft";
import { openSubagentsPanel, openSummaryPanel } from "./support/subagents-panel";

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

const startSubagentScenario = async (
  harness: ElectronScenarioHarness,
  prompt = "Coordinate the bounded subagent scenario",
): Promise<Page> => {
  const page = await harness.launch();
  const scene = await openNewChatDraft(page);
  const composer = scene.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  const sendButton = scene.getByRole("button", { name: "Send prompt" });
  try {
    await expect(composer).toBeVisible();
    await composer.fill(prompt);
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

test("keeps delegated work compact while hover and direct navigation expose each child", async () => {
  test.setTimeout(180_000);
  const artifacts = process.env.NODEX_SUBAGENT_PRESENTATION_ARTIFACT_DIR;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown): void => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  const selectedName = "Interaction details and keyboard accessibility";
  const harness = await createSubagentHarness("subagent-presentation", {
    NODEX_FAKE_SUBAGENT_SELECTED_NAME: selectedName,
  });
  let recording = false;
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  try {
    const page = await startSubagentScenario(
      harness,
      "Review the project architecture and interaction details.",
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light" });
    const summaryToggle = page.getByRole("button", { name: /^Toggle (pinned )?summary$/u }).first();
    if ((await summaryToggle.getAttribute("aria-pressed")) === "true") await summaryToggle.click();
    await expect(summaryToggle).toHaveAttribute("aria-pressed", "false");
    const group = page.getByTestId("delegated-task-group");
    const overflow = group.getByRole("button", { name: "Show all 17 subagents", exact: true });
    const investigator = group.getByRole("button", { name: selectedName, exact: true });
    const hover = page.getByRole("dialog", { name: `${selectedName} details`, exact: true });
    await expect(overflow).toBeVisible({ timeout: 30_000 });
    await expect(group).toHaveAttribute("aria-label", /13 done/u);
    claim("Consecutive delegated tasks share one activity group", 1, await group.count());
    await expect(investigator).toBeVisible();
    const identity = async (avatar: Locator) => {
      await expect(avatar).toBeVisible();
      await expect
        .poll(() =>
          avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true);
      return {
        seed: await avatar.getAttribute("data-subagent-avatar-seed"),
        index: await avatar.getAttribute("data-subagent-avatar-index"),
        src: await avatar.getAttribute("src"),
      };
    };
    const inlineAvatar = group.getByLabel(selectedName, { exact: true }).locator("img");
    const lightIdentity = await identity(inlineAvatar);
    claim(
      "The inline group displays at most four identities",
      4,
      await group.locator("img[data-subagent-avatar-seed]").count(),
    );
    claim(
      "The name budget leaves all remaining children reachable",
      "15 more",
      await overflow.innerText(),
    );
    const screenshot = async (name: string): Promise<void> => {
      if (!artifacts) return;
      // Assertions establish the state; let finite panel/theme motion settle for review images.
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(artifacts, name) });
    };
    if (artifacts) {
      // Finish first-launch guidance before recording the feature under review.
      const setupNotice = page.getByRole("alert").filter({ hasText: "Global dictation is ready." });
      await setupNotice.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
      if (await setupNotice.isVisible()) {
        await setupNotice.getByRole("button", { name: "Dismiss notification" }).click();
        await expect(setupNotice).toHaveCount(0);
      }
      await group.screenshot({ path: path.join(artifacts, "activity-light.png") });
    }
    // Restore a full-viewport capture after any element crop before the native recorder starts.
    await screenshot("light.png");
    if (artifacts) {
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1440, height: 960 },
        annotate: { position: "bottom", fontSize: 14 },
      });
      recording = true;
    }

    const summary = await openSummaryPanel(page);
    claim(
      "The summary reconstructs the same child identity",
      lightIdentity,
      await identity(
        summary
          .locator(`img[data-subagent-avatar-seed=${JSON.stringify(lightIdentity.seed)}]`)
          .first(),
      ),
    );
    await screenshot("summary.png");
    await summaryToggle.click();
    await expect(summaryToggle).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(180, 450);
    await investigator.hover();
    await expect(hover).toBeVisible();
    await expect(hover.getByText(/Codex.*GPT-5\.5/u)).toBeVisible();
    claim(
      "Hover exposes the executing Agent and model",
      true,
      await hover.getByText(/Codex.*GPT-5\.5/u).isVisible(),
    );
    await hover.hover();
    await expect(hover).toBeVisible();
    claim("The pointer can enter the detail layer", true, await hover.isVisible());
    await screenshot("hover.png");
    if (artifacts) await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await expect(hover).toHaveCount(0);
    claim("Escape dismisses the hover details", 0, await hover.count());
    // Escape restores the trigger's focus; leave it before testing a new keyboard entry.
    await investigator.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(hover).toBeVisible();
    claim("Keyboard focus exposes the same task details", true, await hover.isVisible());
    await page.keyboard.press("Escape");
    await investigator.click();
    const detail = page.locator('[data-subagents-side-panel-tab^="subagents:"]');
    await expect(detail).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    await expect(hover).toHaveCount(0);
    // Keep the pointer on the trigger beyond its opening delay: navigation must not reopen it.
    await page.waitForTimeout(900);
    await expect(hover).toHaveCount(0);
    claim("Opening the child keeps hover details dismissed", 0, await hover.count());
    await expect(
      detail.getByText("Checking the selected child history.", { exact: true }),
    ).toBeVisible();
    claim(
      "Clicking a task name opens its own child transcript",
      true,
      await detail.getByText("Checking the selected child history.", { exact: true }).isVisible(),
    );
    claim(
      "Child inspection does not create a second Composer",
      0,
      await detail.locator('[data-codex-composer="true"]').count(),
    );
    claim(
      "The selected child retains its avatar identity",
      lightIdentity,
      await identity(detail.locator("img[data-subagent-avatar-seed]").first()),
    );
    claim(
      "Inspecting a child does not resume native execution",
      [],
      readRpcEntries(harness).filter(
        (entry) =>
          entry.method === "thread/resume" &&
          typeof entry.params.threadId === "string" &&
          childThreadIds.has(entry.params.threadId),
      ),
    );
    await screenshot("child.png");
    if (artifacts) await page.waitForTimeout(800);
    await detail.getByRole("button", { name: "Back to subagents" }).click();
    const { panel, active, done } = overviewSections(page);
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "Close Subagents tab", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await overflow.click();
    await expect(panel).toBeVisible();
    await expect(active.getByRole("heading", { name: "Active · 4" })).toBeVisible();
    await expect(done.getByRole("heading", { name: "Done · 13" })).toBeVisible();
    claim(
      "The overflow opens the complete subagent overview",
      { active: "Active · 4", done: "Done · 13" },
      {
        active: await active.getByRole("heading").innerText(),
        done: await done.getByRole("heading").innerText(),
      },
    );
    claim(
      "Overview and inline activity use the same child identity",
      lightIdentity,
      await identity(
        active
          .getByRole("button", { name: `Open subagent ${selectedName}`, exact: true })
          .locator("img[data-subagent-avatar-seed]"),
      ),
    );
    await screenshot("final.png");
    if (artifacts) await page.waitForTimeout(1_000);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkIdentity = await identity(inlineAvatar);
    claim(
      "Theme changes preserve the child seed and bank index",
      { seed: lightIdentity.seed, index: lightIdentity.index },
      { seed: darkIdentity.seed, index: darkIdentity.index },
    );
    claim(
      "Dark appearance loads the separate dark artwork",
      true,
      darkIdentity.src !== lightIdentity.src,
    );
    claim(
      "Dark overview and inline activity retain identical artwork",
      darkIdentity,
      await identity(
        active
          .getByRole("button", { name: `Open subagent ${selectedName}`, exact: true })
          .locator("img[data-subagent-avatar-seed]"),
      ),
    );
    await screenshot("dark.png");
    if (artifacts) await page.waitForTimeout(1_000);
    if (recording) {
      await page.screencast.stop();
      recording = false;
    }
    // Element screenshots can temporarily resize the capture surface; keep them outside video.
    if (artifacts) await group.screenshot({ path: path.join(artifacts, "activity-dark.png") });
    await page.getByRole("button", { name: "Close Subagents tab", exact: true }).click();
    await page.setViewportSize({ width: 820, height: 720 });
    await expect(page.locator("[data-app-shell-width-class]")).toHaveAttribute(
      "data-app-shell-width-class",
      "medium",
    );
    await expect(investigator).toBeVisible();
    const horizontalOverflow = await group.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    claim("The activity group stays inside a narrow conversation", true, horizontalOverflow <= 1);
    await screenshot("narrow.png");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    claim(
      "Returning to light restores the exact original artwork",
      lightIdentity,
      await identity(inlineAvatar),
    );
    const restarted = await harness.restart();
    await restarted.setViewportSize({ width: 1440, height: 960 });
    await restarted.emulateMedia({ colorScheme: "light" });
    const restoredGroup = restarted.getByTestId("delegated-task-group");
    await expect(restoredGroup).toBeVisible({ timeout: 30_000 });
    claim(
      "Restart reconstructs the same identity from persisted child metadata",
      lightIdentity,
      await identity(restoredGroup.getByLabel(selectedName, { exact: true }).locator("img")),
    );
    if (artifacts) await restarted.screenshot({ path: path.join(artifacts, "restart.png") });
    status = "passed";
    if (artifacts) fs.rmSync(path.join(artifacts, "failure.png"), { force: true });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (artifacts)
      await harness.page
        .screenshot({ path: path.join(artifacts, "failure.png") })
        .catch(() => undefined);
    throw error;
  } finally {
    if (recording) await harness.page.screencast.stop();
    if (artifacts) {
      fs.writeFileSync(
        path.join(artifacts, "result.json"),
        `${JSON.stringify({ status, fixture: "fresh isolated Electron Profile; deterministic Codex peer starts 17 consecutive children through Agent Runtime", claims, failure }, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(artifacts, "README.md"),
        `# Subagent presentation review\n\nStatus: **${status}**\n\nThe native recording starts after the disposable Profile and delegated work are ready. It follows hover, pointer entry into task details, keyboard focus, direct navigation to the child transcript, return, overflow navigation to all 17 children, and a theme change. The child is read without resuming execution. Identity and artwork are compared across inline activity, detail and overview; a separate application restart verifies restoration from persisted child metadata.\n\n- review.webm: native interaction recording.\n- light.png and dark.png: activity and overview in both themes.\n- hover.png: task details and model metadata.\n- child.png: the selected child transcript.\n- final.png: overflow opens the complete overview.\n- narrow.png: the group at 820 px window width.\n- restart.png: restored conversation and identities after application restart.\n- result.json: exact expected and actual values for the verified claims.\n\nNo production Profile or user content was accessed.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
      );
    }
    await harness.close();
  }
});
