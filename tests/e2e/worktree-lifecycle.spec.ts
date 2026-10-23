import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { ProjectSessionSummary } from "../../src/shared/types";

const repositoryRoot = process.cwd();
const worktreeElectronEnvironment = {
  NODEX_CORE_IDLE_TIMEOUT_MS: "250",
  NODEX_LOG_CONSOLE: "0",
} as const;

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
  const composer = page.locator('[contenteditable="true"][aria-label="Do anything"]');
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
  const prompt = "Report the current working directory.";
  const sendButton = await composeWorktreeChat(fixture.page, fixture.projectId, prompt);
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

test("a worktree that cannot be prepared offers Retry and Work locally, and runs locally", async () => {
  test.setTimeout(120_000);
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

    await expect(
      page.getByText("The worktree could not be prepared.", { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
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
  test.setTimeout(120_000);
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
      await expect(page.locator('[contenteditable="true"][aria-label="Do anything"]')).toHaveText(
        "Report the current working directory.",
      );
    });
    expect(fs.readFileSync(path.join(worktreeGitRoot, "review-branch.txt"), "utf8")).toBe(
      "selected branch\n",
    );
    expect(fs.existsSync(path.join(fixture.sourceRoot, "review-branch.txt"))).toBe(false);
    // The Environment's setup ran in the new worktree before the message.
    await expect(fixture.page.getByText("Preparing workspace").first()).toBeVisible();
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
    const listed = async () =>
      (await invokeIpc(page, "worktrees:list", "local")) as Array<{
        path: string;
        conversations: Array<{
          threadId: string;
          sessionId: string | null;
          sessionTitle: string | null;
        }>;
      }>;
    await expect
      .poll(
        async () => {
          const record = (await listed()).find(
            (entry) => fs.realpathSync(entry.path) === fs.realpathSync(worktreeGitRoot),
          );
          return record?.conversations.map((conversation) => conversation.sessionId) ?? null;
        },
        { timeout: 30_000 },
      )
      .toEqual([session.id]);

    const record = (await listed()).find(
      (entry) => fs.realpathSync(entry.path) === fs.realpathSync(worktreeGitRoot),
    )!;
    await invokeIpc(page, "worktrees:delete", "local", record.path);
    await expect.poll(() => fs.existsSync(worktreeGitRoot), { timeout: 20_000 }).toBe(false);
    expect(
      ((await invokeIpc(page, "project-sessions:get", session.id)) as { archived: boolean })
        .archived,
    ).toBe(true);
    expect(await invokeIpc(page, "worktrees:thread:availability", threadId)).toEqual({
      state: "restorable",
      repositoryPath: fixture.sourceRoot,
      snapshotRef: expect.stringMatching(/^refs\/codex\/snapshots\/[a-f0-9]{40}$/u),
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
