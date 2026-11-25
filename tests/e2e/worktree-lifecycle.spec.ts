import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { DictationSettingsStore } from "../../src/main/dictation/dictation-settings-store";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { AgentRuntimeMessageInput } from "../../src/shared/agent-runtime-api";
import type { ProjectSessionSummary } from "../../src/shared/types";
import {
  readRuntimeConversation,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";
import { openSummaryPanel } from "./support/subagents-panel";

const repositoryRoot = process.cwd();
const worktreeElectronEnvironment = {
  NODEX_CORE_IDLE_TIMEOUT_MS: "250",
  NODEX_LOG_CONSOLE: "0",
} as const;

const openingPrompt = "Report the current working directory.";
const reviewScreenshotsDir = process.env.NODEX_REVIEW_SCREENSHOTS_DIR;
const promptEditorSelector = '[contenteditable="true"][aria-label="Do anything"]';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requireCoreValue(result: unknown, label: string): unknown {
  if (isRecord(result) && result.ok === true && "value" in result) {
    return result.value;
  }
  const message =
    isRecord(result) && isRecord(result.error) && typeof result.error.message === "string"
      ? result.error.message
      : "unknown Core error";
  throw new Error(`${label} failed: ${message}`);
}

async function invokeIpc(
  page: Page,
  channel: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  return await page.evaluate(
    async ({ channel: targetChannel, args: targetArgs }) =>
      await window.api?.invoke(targetChannel, ...targetArgs),
    { channel, args },
  );
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function createRepository(root: string): {
  additionalRoot: string;
  nestedCwd: string;
  sourceRoot: string;
} {
  const sourceRoot = path.join(root, "source repo");
  const additionalRoot = path.join(root, "additional root");
  const nestedCwd = path.join(sourceRoot, "packages", "app");
  fs.mkdirSync(nestedCwd, { recursive: true });
  fs.mkdirSync(additionalRoot, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, ".codex", "environments"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "README.md"), "managed worktree fixture\n");
  fs.writeFileSync(path.join(nestedCwd, "package.json"), '{"private":true}\n');
  fs.writeFileSync(
    path.join(sourceRoot, ".codex", "environments", "environment.toml"),
    [
      "version = 1",
      'name = "E2E Environment"',
      "[setup]",
      "script = \"printf 'worktree setup complete\\n'\"",
      "",
    ].join("\n"),
  );
  runGit(sourceRoot, ["init", "--initial-branch=main"]);
  runGit(sourceRoot, ["config", "user.email", "worktree-e2e@nodex.invalid"]);
  runGit(sourceRoot, ["config", "user.name", "Nodex Worktree E2E"]);
  runGit(sourceRoot, ["add", "."]);
  runGit(sourceRoot, ["commit", "-m", "fixture"]);
  return { additionalRoot, nestedCwd, sourceRoot };
}

async function createWorktreeHarness(label: string): Promise<ElectronScenarioHarness> {
  const harness = await ElectronScenarioHarness.create({
    label,
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    prepareAgentRuntime: false,
    environment: {
      ...worktreeElectronEnvironment,
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(repositoryRoot, "tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  if (reviewScreenshotsDir) {
    // Record the first-launch nudge as seen before opening the review fixture.
    await new DictationSettingsStore(harness.profile.nodexHome).consumeGlobalShortcutNudge();
  }
  return harness;
}

async function createProject(page: Page, sources: readonly string[]): Promise<string> {
  const projectId = createUuidV7();
  const project = requireCoreValue(
    await invokeIpc(page, "projects:create", {
      operationId: createBoundedOperationId("e2e.worktree.project.create"),
      payload: {
        projectId,
        input: { name: "Managed Worktree E2E", sources },
      },
    }),
    "Project creation",
  );
  if (!isRecord(project) || typeof project.id !== "string") {
    throw new Error("Project creation returned no project id");
  }
  return project.id;
}

async function waitForProjectDraft(page: Page, projectId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const tasks = await invokeIpc(page, "workspace:tasks:list", projectId, { first: 20 });
        if (!isRecord(tasks) || !Array.isArray(tasks.items)) return 0;
        return tasks.items.filter((item) => isRecord(item) && item.thread === null).length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
}

const fakeRequests = (harness: ElectronScenarioHarness) =>
  fs
    .readFileSync(path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });

interface WorktreeFixture {
  readonly fixtureRoot: string;
  readonly managedRoot: string;
  readonly sourceRoot: string;
  readonly projectId: string;
  readonly page: Page;
}

async function openWorktreeProject(
  harness: ElectronScenarioHarness,
  prefix: string,
): Promise<WorktreeFixture> {
  // Core uses a Unix-domain socket under this root; keep the prefix short enough
  // to leave room for the generated profile/run/core endpoint on macOS.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const managedRoot = path.join(fixtureRoot, "managed worktrees");
  const fixture = createRepository(fixtureRoot);
  fs.mkdirSync(managedRoot, { recursive: true });
  const page = await harness.launch();
  const projectId = await createProject(page, [fixture.sourceRoot]);
  await invokeIpc(page, "worktrees:settings:update", {
    worktreeRoot: managedRoot,
    autoDeleteEnabled: false,
  });
  await page.reload();
  await page.evaluate(() => window.api?.awaitInitialization?.());
  return { fixtureRoot, managedRoot, sourceRoot: fixture.sourceRoot, projectId, page };
}

function removeFixtureRoot(fixtureRoot: string | undefined, prefix: string): void {
  if (!fixtureRoot) return;
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  if (!resolvedFixtureRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}${prefix}`)) {
    throw new Error(`Refusing to clean unexpected worktree E2E root: ${resolvedFixtureRoot}`);
  }
  fs.rmSync(resolvedFixtureRoot, { recursive: true, force: true });
}

/** Writes a prompt in the Project's new chat and chooses a new worktree with its Environment. */
async function composeWorktreeChat(page: Page, projectId: string, prompt: string) {
  await page
    .getByRole("button", { name: "Start new chat in Managed Worktree E2E", exact: true })
    .click();
  await waitForProjectDraft(page, projectId);
  const composer = page.locator(promptEditorSelector);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill(prompt);
  await expect(composer).toHaveText(prompt);
  await page.getByRole("button", { name: "Configure local environment", exact: true }).click();
  const newWorktree = page.getByRole("switch", { name: "New worktree", exact: true });
  await newWorktree.check();
  await expect(newWorktree).toBeChecked();
  await expect(composer).toHaveText(prompt);
  await expect(page.getByRole("menuitem", { name: "Branch: main", exact: true })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Environment: E2E Environment", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(newWorktree).toHaveCount(0);
  const sendButton = page.getByRole("button", { name: "Send prompt" });
  await expect(sendButton).toBeEnabled({ timeout: 20_000 });
  return sendButton;
}

async function agentSession(page: Page, projectId: string): Promise<ProjectSessionSummary> {
  let session: ProjectSessionSummary | null = null;
  await expect
    .poll(
      async () => {
        const tasks = (await invokeIpc(page, "workspace:tasks:list", projectId, {
          first: 20,
        })) as { items?: ProjectSessionSummary[] };
        session = tasks.items?.find((item) => item.executionRef) ?? null;
        return session !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return session!;
}

async function sendWorktreeChat(
  harness: ElectronScenarioHarness,
  fixture: WorktreeFixture,
  reviewDraft?: () => Promise<void>,
) {
  const sendButton = await composeWorktreeChat(fixture.page, fixture.projectId, openingPrompt);
  await reviewDraft?.();
  await sendButton.click();
  await expect(fixture.page.getByText("The task completed successfully.").first()).toBeVisible({
    timeout: 45_000,
  });
  const started = fakeRequests(harness).filter((request) => request.method === "thread/start");
  const cwd = fs.realpathSync(String(started.at(-1)?.params.cwd ?? ""));
  // The chat runs in its own worktree under the configured managed root.
  const worktreeGitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  expect(worktreeGitRoot.startsWith(`${fs.realpathSync(fixture.managedRoot)}${path.sep}`)).toBe(
    true,
  );
  return { session: await agentSession(fixture.page, fixture.projectId), worktreeGitRoot };
}

/** Waits for the worktree's inventory entry and returns the path accepted by Worktrees settings. */
async function listedWorktreePath(
  page: Page,
  worktreeGitRoot: string,
  sessionId: string,
): Promise<string> {
  const realWorktreeGitRoot = fs.realpathSync(worktreeGitRoot);
  let inventoryPath: string | undefined;
  await expect
    .poll(
      async () => {
        const entries = (await invokeIpc(page, "worktrees:list", "local")) as Array<{
          path: string;
          conversations: Array<{ sessionId: string | null }>;
        }>;
        const record = entries.find((entry) => fs.realpathSync(entry.path) === realWorktreeGitRoot);
        inventoryPath = record?.path;
        return record?.conversations.map((conversation) => conversation.sessionId) ?? null;
      },
      { timeout: 30_000 },
    )
    .toEqual([sessionId]);
  if (!inventoryPath) throw new Error("The chat's worktree is missing from the host inventory");
  return inventoryPath;
}

async function createAgentWorktreeChat(harness: ElectronScenarioHarness, fixture: WorktreeFixture) {
  const { session, worktreeGitRoot } = await sendWorktreeChat(harness, fixture);
  if (!session.executionRef) throw new Error("The worktree chat has no Runtime execution");
  const target = { sessionId: session.id, threadId: session.executionRef.threadId };
  await waitForRuntimeCompletedAgentTurn(fixture.page, target);
  return { target, worktreeGitRoot };
}

function removeWorktreeOutsideNodex(sourceRoot: string, worktreeGitRoot: string): void {
  fs.rmSync(worktreeGitRoot, { recursive: true });
  runGit(sourceRoot, ["worktree", "prune", "--expire", "now"]);
}

async function reopenWorktreeChat(page: Page, threadId: string): Promise<void> {
  if (reviewScreenshotsDir) await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.evaluate(() => window.api?.awaitInitialization?.());
  await page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
  if (reviewScreenshotsDir) await page.mouse.move(0, 0);
  await expect(transcriptMessages(page)).toHaveText([openingPrompt]);
}

const transcriptMessages = (page: Page) => page.locator('[data-user-message-bubble="true"]');
const composerNotice = (page: Page) => page.locator("[data-composer-notice]");
const workLocallyAction = (page: Page) =>
  composerNotice(page).getByRole("button", { name: "Work locally", exact: true });

async function expectMissingWorktreeLocation(page: Page) {
  const summary = await openSummaryPanel(page);
  const environment = summary.locator("section").filter({
    has: page.getByRole("button", { name: "Environment", exact: true }),
  });
  const location = environment.locator('[data-thread-execution-location-trigger="true"]');
  await expect(location).toBeVisible();
  await expect(location).toHaveText("Worktree");
  await expect(environment.getByText("Changes", { exact: true })).toHaveCount(0);
  return location;
}

async function expectLocalLocation(page: Page): Promise<void> {
  await expect(workLocallyAction(page)).toHaveCount(0);
  const summary = await openSummaryPanel(page);
  await expect(summary.locator('[data-thread-execution-location-trigger="true"]')).toHaveText(
    "Local",
  );
}

function turnsForPrompt(harness: ElectronScenarioHarness, prompt: string) {
  return fakeRequests(harness)
    .filter(
      ({ method, params }) =>
        method === "turn/start" &&
        Array.isArray(params.input) &&
        params.input.some((item) => isRecord(item) && item.type === "text" && item.text === prompt),
    )
    .map(({ params }) => params);
}

function expectOneLocalTurn(
  harness: ElectronScenarioHarness,
  prompt: string,
  sourceRoot: string,
): void {
  const turns = turnsForPrompt(harness, prompt);
  expect(turns).toHaveLength(1);
  const cwd = turns[0]?.cwd;
  expect(typeof cwd).toBe("string");
  expect(fs.realpathSync(String(cwd))).toBe(fs.realpathSync(sourceRoot));
}

async function captureReviewScreenshot(page: Page, filename: string): Promise<void> {
  if (!reviewScreenshotsDir) return;
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: path.join(reviewScreenshotsDir, filename),
    animations: "disabled",
  });
}

async function workLocallyWithoutConfirmation(page: Page, captureProgress = false): Promise<void> {
  await workLocallyAction(page).click();
  if (captureProgress && reviewScreenshotsDir) {
    const progress = composerNotice(page).getByText("Moving to the Project folder…", {
      exact: true,
    });
    if (await progress.isVisible()) {
      const screenshot = await page.screenshot();
      if (await progress.isVisible())
        fs.writeFileSync(path.join(reviewScreenshotsDir, "04-moving-to-project.png"), screenshot);
    }
  }
  await expect(composerNotice(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Work locally", exact: true })).toHaveCount(0);
}

test("a worktree that cannot be prepared offers Retry and Work locally, and runs locally", async () => {
  const harness = await createWorktreeHarness("worktree-failure");
  let fixtureRoot: string | undefined;
  try {
    const fixture = await openWorktreeProject(harness, "ndx-wt-fail-");
    fixtureRoot = fixture.fixtureRoot;
    const { page } = fixture;
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const sendButton = await composeWorktreeChat(page, fixture.projectId, "Invalid Git source E2E");
    // Keep the discovered branch visible to the Composer while invalidating its commit
    // before the worktree is checked out.
    const sourceCommit = runGit(fixture.sourceRoot, ["rev-parse", "HEAD"]);
    fs.rmSync(
      path.join(
        fixture.sourceRoot,
        ".git",
        "objects",
        sourceCommit.slice(0, 2),
        sourceCommit.slice(2),
      ),
    );
    await sendButton.click();

    // The composer says what stands in the way, and the transcript keeps Git's own reason.
    await expect(page.getByText("Couldn’t prepare the worktree", { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await page.getByRole("button", { name: "Request failed", exact: true }).click();
    await expect(page.getByRole("region", { name: "Recovery diagnostics" })).toContainText(
      "fatal: invalid reference",
    );
    await expect(page.getByText("Invalid Git source E2E", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    const workLocally = page.getByRole("button", { name: "Work locally", exact: true });
    await expect(workLocally).toBeVisible();
    await expect(page.getByText("Worktree created", { exact: true })).toHaveCount(0);
    expect(fakeRequests(harness).some((request) => request.method === "turn/start")).toBe(false);
    expect(fs.readdirSync(fixture.managedRoot).filter((name) => !name.startsWith("."))).toEqual([]);

    // Working locally starts the same message in the source checkout.
    await workLocally.click();
    await expect(page.getByText("The task completed successfully.").first()).toBeVisible({
      timeout: 45_000,
    });
    const started = fakeRequests(harness).find((request) => request.method === "thread/start");
    expect(fs.realpathSync(String(started?.params.cwd))).toBe(fs.realpathSync(fixture.sourceRoot));
    expect(rendererErrors).toEqual([]);
  } finally {
    await harness.close();
    removeFixtureRoot(fixtureRoot, "ndx-wt-fail-");
  }
});

test("creates a new-worktree chat through the Composer and runs it there", async () => {
  const harness = await createWorktreeHarness("worktree-composer");
  let fixtureRoot: string | undefined;
  try {
    const fixture = await openWorktreeProject(harness, "ndx-wt-ui-");
    fixtureRoot = fixture.fixtureRoot;
    runGit(fixture.sourceRoot, ["checkout", "-qb", "feature/review"]);
    fs.writeFileSync(path.join(fixture.sourceRoot, "review-branch.txt"), "selected branch\n");
    runGit(fixture.sourceRoot, ["add", "review-branch.txt"]);
    runGit(fixture.sourceRoot, ["commit", "-m", "Prepare an alternate starting branch"]);
    runGit(fixture.sourceRoot, ["checkout", "-q", "main"]);
    const { page } = fixture;
    const { worktreeGitRoot } = await sendWorktreeChat(harness, fixture, async () => {
      const configure = page.getByRole("button", {
        name: "Configure local environment",
        exact: true,
      });
      await configure.click();
      await page.getByRole("menuitem", { name: "Branch: main", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Search repository branches", exact: true })
        .fill("feature/review");
      await page.getByRole("menuitem", { name: "feature/review", exact: true }).click();
      await expect(
        page.getByRole("menuitem", { name: "Branch: feature/review", exact: true }),
      ).toBeVisible();
      // Selecting the draft's starting branch must leave the source checkout alone.
      expect(runGit(fixture.sourceRoot, ["branch", "--show-current"])).toBe("main");
      expect(runGit(fixture.sourceRoot, ["status", "--porcelain"])).toBe("");

      const environment = page.getByRole("menuitem", { name: /^Environment:/u });
      await environment.click();
      await page.getByRole("menuitem", { name: "Back to chat settings", exact: true }).click();
      await expect(environment).toHaveAccessibleName("Environment: E2E Environment");
      await environment.click();
      const search = page.getByRole("textbox", { name: "Search environments", exact: true });
      await search.fill("missing environment");
      await expect(page.getByText("No environments found", { exact: true })).toBeVisible();
      await search.clear();
      await page.getByRole("menuitem", { name: "Work without environment", exact: true }).click();
      await expect(environment).toHaveAccessibleName("Environment: No environment");
      await environment.click();
      await search.fill("E2E");
      await page.getByRole("menuitem", { name: "E2E Environment", exact: true }).click();
      await expect(environment).toHaveAccessibleName("Environment: E2E Environment");
      await page.keyboard.press("Escape");
      await expect(environment).toHaveCount(0);
      await expect(configure).toBeFocused();
      await expect(page.locator(promptEditorSelector)).toHaveText(
        "Report the current working directory.",
      );
    });
    expect(fs.readFileSync(path.join(worktreeGitRoot, "review-branch.txt"), "utf8")).toBe(
      "selected branch\n",
    );
    expect(fs.existsSync(path.join(fixture.sourceRoot, "review-branch.txt"))).toBe(false);
    // The Environment's setup ran in the new worktree before the message. A finished turn folds
    // its activity away, so open it when it has.
    const preparation = fixture.page.getByText("Preparing workspace").first();
    await expect(async () => {
      if (!(await preparation.isVisible()))
        await fixture.page
          .getByRole("button", { name: /^Worked for/u })
          .first()
          .click({ timeout: 2_000 });
      await expect(preparation).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    expect(runGit(worktreeGitRoot, ["status", "--porcelain"])).toBe("");
    await expect(
      fixture.page.getByText("Thread could not be restored", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
    removeFixtureRoot(fixtureRoot, "ndx-wt-ui-");
  }
});

test("lists an Agent chat's worktree, archives the chat when it is deleted, and restores it", async () => {
  test.setTimeout(180_000);
  const harness = await createWorktreeHarness("worktree-restart");
  let fixtureRoot: string | undefined;
  try {
    const fixture = await openWorktreeProject(harness, "ndx-wt-life-");
    fixtureRoot = fixture.fixtureRoot;
    const { session, worktreeGitRoot } = await sendWorktreeChat(harness, fixture);
    const threadId = session.executionRef!.threadId;

    const page = await harness.restart();
    const inventoryPath = await listedWorktreePath(page, worktreeGitRoot, session.id);
    await invokeIpc(page, "worktrees:delete", "local", inventoryPath);
    await expect.poll(() => fs.existsSync(worktreeGitRoot), { timeout: 20_000 }).toBe(false);
    expect(
      ((await invokeIpc(page, "project-sessions:get", session.id)) as { archived: boolean })
        .archived,
    ).toBe(true);
    expect(await invokeIpc(page, "worktrees:thread:availability", threadId)).toEqual({
      state: "restorable",
      repositoryPath: fixture.sourceRoot,
      snapshotRef: expect.stringMatching(/^refs\/codex\/snapshots\/[a-f0-9]{40}$/u),
      projectCheckout: fixture.sourceRoot,
    });

    expect(await invokeIpc(page, "worktrees:thread:restore", threadId)).toEqual({
      availability: { state: "available" },
      ownerWarning: null,
    });
    expect(fs.existsSync(worktreeGitRoot)).toBe(true);
    expect(runGit(worktreeGitRoot, ["status", "--porcelain"])).toBe("");
    expect(await invokeIpc(page, "worktrees:thread:availability", threadId)).toMatchObject({
      state: "available",
    });
  } finally {
    await harness.close();
    removeFixtureRoot(fixtureRoot, "ndx-wt-life-");
  }
});

test("moves a chat with a missing worktree to the Project folder and keeps its history", async () => {
  const prefix = "ndx-wt-gone-";
  const harness = await createWorktreeHarness("worktree-missing");
  let fixtureRoot: string | undefined;
  try {
    const fixture = await openWorktreeProject(harness, prefix);
    fixtureRoot = fixture.fixtureRoot;
    const { page, sourceRoot } = fixture;
    const { target, worktreeGitRoot } = await createAgentWorktreeChat(harness, fixture);
    removeWorktreeOutsideNodex(sourceRoot, worktreeGitRoot);
    await reopenWorktreeChat(page, target.threadId);

    const notice = composerNotice(page);
    await expect(notice.getByText("Working directory missing", { exact: true })).toBeVisible();
    await expect(
      notice.getByText("This chat’s worktree no longer exists", { exact: true }),
    ).toBeVisible();
    await expect(workLocallyAction(page)).toBeVisible();
    const prompt = "Continue the review from the Project folder.";
    const composer = page.locator('[data-codex-composer="true"][contenteditable="true"]:visible');
    await composer.fill(prompt);
    const sendButton = page.getByRole("button", { name: "Send prompt", exact: true });
    await expect(sendButton).toBeDisabled();
    const location = await expectMissingWorktreeLocation(page);
    await captureReviewScreenshot(page, "01-gone-notice.png");

    await location.click();
    await expect(page.getByText("Continue in", { exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Local", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Work locally", exact: true });
    await expect(dialog).toHaveAccessibleDescription(/^This chat’s worktree no longer exists\./u);
    await captureReviewScreenshot(page, "07-continue-in-local-dialog.png");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(workLocallyAction(page)).toBeVisible();

    await composer.press("Enter");
    const blockedSend = page.getByRole("alert").filter({ hasText: "Message not sent" });
    await expect(blockedSend).toBeVisible();
    await expect(composer).toHaveText(prompt);
    expect(turnsForPrompt(harness, prompt)).toHaveLength(0);
    await blockedSend.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(blockedSend).toHaveCount(0);

    await workLocallyWithoutConfirmation(page, true);
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    await expect(transcriptMessages(page)).toHaveText([openingPrompt, prompt]);
    await expect(page.getByText("The task completed successfully.", { exact: true })).toHaveCount(
      2,
    );
    expectOneLocalTurn(harness, prompt, sourceRoot);
    const { snapshot } = await waitForRuntimeCompletedAgentTurn(page, target);
    expect(snapshot.projection.runs.at(-1)).toMatchObject({ ordinal: 2 });
    await expectLocalLocation(page);
    if (reviewScreenshotsDir) await transcriptMessages(page).first().scrollIntoViewIfNeeded();
    await captureReviewScreenshot(page, "05-chat-now-local.png");
  } finally {
    await harness.close();
    removeFixtureRoot(fixtureRoot, prefix);
  }
});

test("sends the same waiting message once after working locally", async () => {
  const prefix = "ndx-wt-wait-";
  const harness = await createWorktreeHarness("worktree-waiting-message");
  let fixtureRoot: string | undefined;
  try {
    const fixture = await openWorktreeProject(harness, prefix);
    fixtureRoot = fixture.fixtureRoot;
    const { page, sourceRoot } = fixture;
    const { target, worktreeGitRoot } = await createAgentWorktreeChat(harness, fixture);
    removeWorktreeOutsideNodex(sourceRoot, worktreeGitRoot);
    await reopenWorktreeChat(page, target.threadId);

    // Admit the message through the composer's Runtime command after the checkout has gone.
    const prompt = "List the files in the Project folder.";
    const messageId = createUuidV7();
    await invokeIpc(page, "agent-runtime:session:message", {
      ...target,
      message: { messageId, text: prompt },
    } satisfies AgentRuntimeMessageInput);

    const waitingTurn = page.locator("[data-turn-key]").filter({ hasText: prompt });
    await expect(
      waitingTurn.getByRole("button", { name: "Working directory missing", exact: true }),
    ).toBeVisible();
    await expect(waitingTurn.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    expect(turnsForPrompt(harness, prompt)).toHaveLength(0);
    const failed = (await readRuntimeConversation(page, target)).snapshot.projection;
    const run = failed.runs.at(-1);
    if (!run) throw new Error("The waiting message did not create a Runtime Run");
    expect(run).toMatchObject({ status: "failed", startedAt: null, userMessageId: messageId });
    expect(failed.visibleTurnItems.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({
        type: "error",
        runId: run.id,
        failure: expect.objectContaining({ code: "workspace_missing" }),
      }),
    );
    await captureReviewScreenshot(page, "06-waiting-run.png");

    await workLocallyWithoutConfirmation(page);
    await expect
      .poll(async () => (await readRuntimeConversation(page, target)).snapshot.projection.runs)
      .toMatchObject([
        ...failed.runs.slice(0, -1).map(({ id }) => ({ id })),
        { id: run.id, status: "completed", userMessageId: messageId },
      ]);
    expectOneLocalTurn(harness, prompt, sourceRoot);
    await expect(transcriptMessages(page)).toHaveText([openingPrompt, prompt]);
  } finally {
    await harness.close();
    removeFixtureRoot(fixtureRoot, prefix);
  }
});

test("asks before working locally when the worktree can be restored", async () => {
  const prefix = "ndx-wt-save-";
  const harness = await createWorktreeHarness("worktree-restorable");
  let fixtureRoot: string | undefined;
  try {
    const fixture = await openWorktreeProject(harness, prefix);
    fixtureRoot = fixture.fixtureRoot;
    const { page, sourceRoot } = fixture;
    const { target, worktreeGitRoot } = await createAgentWorktreeChat(harness, fixture);
    fs.writeFileSync(path.join(worktreeGitRoot, "README.md"), "Saved worktree changes\n");
    const inventoryPath = await listedWorktreePath(page, worktreeGitRoot, target.sessionId);
    await invokeIpc(page, "worktrees:delete", "local", inventoryPath);
    // Worktrees settings archives the chat on removal. Reopen it while the snapshot is still saved.
    requireCoreValue(
      await invokeIpc(page, "project-sessions:unarchive", {
        operationId: createBoundedOperationId("e2e.worktree.recovery.unarchive"),
        payload: { sessionId: target.sessionId },
      }),
      "Chat unarchive",
    );
    await reopenWorktreeChat(page, target.threadId);

    const notice = composerNotice(page);
    await expect(notice.getByText("Worktree cleaned up", { exact: true })).toBeVisible();
    await expect(notice.getByText("Removed to save disk space", { exact: true })).toBeVisible();
    await expect(
      notice.getByRole("button", { name: "Restore worktree", exact: true }),
    ).toBeEnabled();
    await expect(workLocallyAction(page)).toBeEnabled();
    await expectMissingWorktreeLocation(page);
    await captureReviewScreenshot(page, "02-restorable-notice.png");

    await workLocallyAction(page).click();
    const dialog = page.getByRole("dialog", { name: "Work locally", exact: true });
    await expect(dialog).toHaveAccessibleDescription(
      "The chat continues in the Project folder. Changes saved when its worktree was cleaned up stay in the worktree’s snapshot and won’t come along. Restore the worktree first to keep them.",
    );
    await captureReviewScreenshot(page, "03-work-locally-dialog.png");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(notice.getByText("Worktree cleaned up", { exact: true })).toBeVisible();

    await workLocallyAction(page).click();
    await dialog.getByRole("button", { name: "Work locally", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectLocalLocation(page);
    await expect(transcriptMessages(page)).toHaveText([openingPrompt]);
    expect(fs.existsSync(worktreeGitRoot)).toBe(false);
    expect(runGit(sourceRoot, ["status", "--porcelain"])).toBe("");
    const snapshot = runGit(sourceRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/codex/snapshots",
    ]);
    expect(runGit(sourceRoot, ["show", `${snapshot}:README.md`])).toBe("Saved worktree changes");
  } finally {
    await harness.close();
    removeFixtureRoot(fixtureRoot, prefix);
  }
});
