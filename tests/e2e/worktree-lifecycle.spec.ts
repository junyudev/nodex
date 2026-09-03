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

async function beginPendingWorktreeEventCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __worktreeE2ePendingEntries?: unknown[];
      __worktreeE2eStopPendingCapture?: () => void;
    };
    scope.__worktreeE2eStopPendingCapture?.();
    scope.__worktreeE2ePendingEntries = [];
    scope.__worktreeE2eStopPendingCapture = window.api?.on(
      "codex:pending-worktrees:changed",
      (entries: unknown) => {
        if (!Array.isArray(entries)) return;
        scope.__worktreeE2ePendingEntries?.push(...entries);
      },
    );
  });
}

async function capturedPendingWorktreeEntries(page: Page): Promise<readonly unknown[]> {
  return await page.evaluate(() => {
    const scope = window as typeof window & {
      __worktreeE2ePendingEntries?: unknown[];
    };
    return scope.__worktreeE2ePendingEntries ?? [];
  });
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

async function createProjectSession(page: Page, projectId: string): Promise<string> {
  const sessionId = createUuidV7();
  const session = await invokeIpc(page, "project-sessions:create", {
    operationId: createBoundedOperationId("e2e.worktree.session.create"),
    payload: {
      sessionId,
      input: { projectId, noThreadFallbackTitle: "New thread", initialPageIds: [] },
    },
  });
  const value = requireCoreValue(session, "Project Session creation");
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Project Session creation returned no session id");
  }
  return value.id;
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

function pendingStartInput(input: {
  additionalRoot: string;
  environmentPath: string | null;
  nestedCwd: string;
  projectId: string;
  projectSessionId: string;
  sourceRoot: string;
}): Record<string, unknown> {
  return {
    hostId: "local",
    label: "Managed worktree E2E",
    sourceWorkspaceRoot: input.sourceRoot,
    startingState: { type: "working-tree" },
    localEnvironmentConfigPath: input.environmentPath,
    launchMode: "start-conversation",
    firstSubmission: {
      launchId: "01991e60-b800-7000-8000-000000000101",
      clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
    },
    prompt: "Report the current working directory.",
    projectSessionId: input.projectSessionId,
    startConversationParamsInput: {
      input: [{ type: "text", text: "Report the current working directory.", text_elements: [] }],
      commentAttachments: [],
      workspaceRoots: [input.sourceRoot, input.additionalRoot],
      cwd: input.nestedCwd,
      fileAttachments: [],
      addedFiles: [],
      agentMode: "auto",
      shouldSendPermissionOverrides: true,
      model: null,
      serviceTier: null,
      reasoningEffort: null,
      collaborationMode: null,
      config: {},
      threadSource: "user",
      workspaceKind: "project",
      projectAssignment: {
        projectKind: "local",
        projectId: input.projectId,
        pendingCoreUpdate: false,
      },
    },
    sourceConversationId: null,
    sourceCollaborationMode: null,
  };
}

function worktreeInitCount(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.turns)) return 0;
  return value.turns.reduce((count, turn) => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) return count;
    return (
      count +
      turn.items.filter((item) => isRecord(item) && item.semanticKind === "worktreeInit").length
    );
  }, 0);
}

function runtimeWorkspaceRoots(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.runtimeWorkspaceRoots)) {
    return value.runtimeWorkspaceRoots.filter((root): root is string => typeof root === "string");
  }
  const canonicalState = value.canonicalState;
  if (!isRecord(canonicalState) || !isRecord(canonicalState.sidecar)) return [];
  const hydrationContext = canonicalState.sidecar.hydrationContext;
  if (!isRecord(hydrationContext) || !isRecord(hydrationContext.currentPermissions)) return [];
  const roots = hydrationContext.currentPermissions.runtimeWorkspaceRoots;
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
}

async function waitForPendingThread(page: Page, clientThreadId: string): Promise<string> {
  let resolvedThreadId: string | null = null;
  await expect
    .poll(
      async () => {
        const result = await invokeIpc(
          page,
          "codex:pending-worktree:resolve-thread",
          clientThreadId,
        );
        if (!isRecord(result)) return "missing";
        if (result.state === "succeeded" && typeof result.threadId === "string") {
          resolvedThreadId = result.threadId;
        }
        if (result.state === "failed") {
          const pending = await invokeIpc(page, "codex:pending-worktrees:list");
          return `failed: ${JSON.stringify({ pending, resolution: result })}`;
        }
        return String(result.state ?? "missing");
      },
      { timeout: 45_000 },
    )
    .toBe("succeeded");
  if (resolvedThreadId === null) throw new Error("Pending worktree returned no thread id");
  return resolvedThreadId;
}

test("keeps a pre-checkout failure in the creation state and renders exact recovery actions", async () => {
  test.setTimeout(90_000);
  const harness = await createWorktreeHarness("worktree-failure");
  let fixtureRoot: string | undefined;
  try {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ndx-wt-fail-"));
    const managedRoot = path.join(fixtureRoot, "managed worktrees");
    const fixture = createRepository(fixtureRoot);
    fs.mkdirSync(managedRoot, { recursive: true });
    const page = await harness.launch();
    const projectId = await createProject(page, [fixture.sourceRoot]);
    await invokeIpc(page, "worktrees:settings:update", {
      worktreeRoot: managedRoot,
      autoDeleteEnabled: false,
    });
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));

    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    await page
      .getByRole("button", {
        name: "Start new chat in Managed Worktree E2E",
        exact: true,
      })
      .click();
    await waitForProjectDraft(page, projectId);
    const composer = page.locator('[contenteditable="true"][aria-label="Do anything"]');
    await composer.fill("Invalid Git source E2E");
    await page.getByRole("button", { name: "Start in" }).click();
    await page.locator('[data-new-chat-start-in-option="newWorktree"]').click();
    await expect(page.getByRole("button", { name: "Select starting state" })).toContainText("main");
    const sendButton = page.getByRole("button", { name: "Send prompt" });
    await expect(sendButton).toBeEnabled();

    await beginPendingWorktreeEventCapture(page);
    // Keep the discovered branch visible to Composer while invalidating its
    // commit before the worker consumes it. This is the exact pre-checkout
    // boundary that previously published a false "Worktree created" state.
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
    await sendButton.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("Expected send button");
      button.click();
    });

    let pendingWorktreeId: string | null = null;
    await expect
      .poll(
        async () => {
          const entries = await capturedPendingWorktreeEntries(page);
          const entry = entries.find(
            (candidate) =>
              isRecord(candidate) &&
              candidate.launchMode === "start-conversation" &&
              candidate.label === "Invalid Git source E2E",
          );
          if (!isRecord(entry) || typeof entry.id !== "string") return "missing";
          pendingWorktreeId = entry.id;
          return "captured";
        },
        { timeout: 20_000 },
      )
      .toBe("captured");
    if (pendingWorktreeId === null) throw new Error("Pending failure fixture returned no identity");

    let failedEntry: Record<string, unknown> | null = null;
    await expect
      .poll(
        async () => {
          const entries = await invokeIpc(page, "codex:pending-worktrees:list");
          if (!Array.isArray(entries)) return "missing";
          const entry = entries.find(
            (candidate) => isRecord(candidate) && candidate.id === pendingWorktreeId,
          );
          if (!isRecord(entry)) return "missing";
          failedEntry = entry;
          return String(entry.phase ?? "missing");
        },
        { timeout: 20_000 },
      )
      .toBe("failed");
    expect(failedEntry).toMatchObject({
      worktreeGitRoot: null,
      worktreeWorkspaceRoot: null,
    });

    await expect(page.getByTestId("pending-worktree-route-shell")).toBeVisible();
    await expect(page.getByText("Worktree setup failed", { exact: true })).toBeVisible();
    await expect(page.getByText("Preparing workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("Checking out files", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Less details" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit environment" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("Worktree created", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Auto-fix" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue anyway" })).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  } finally {
    await harness.close();
    if (fixtureRoot) {
      const resolvedFixtureRoot = path.resolve(fixtureRoot);
      const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}ndx-wt-fail-`;
      if (!resolvedFixtureRoot.startsWith(expectedPrefix)) {
        throw new Error(
          `Refusing to clean unexpected failed-worktree E2E root: ${resolvedFixtureRoot}`,
        );
      }
      fs.rmSync(resolvedFixtureRoot, { recursive: true, force: true });
    }
  }
});

test("creates a new-worktree Task through the real Composer without changing renderer identity", async () => {
  test.setTimeout(120_000);
  // Core uses a Unix-domain socket under this root; keep the prefix short enough
  // to leave room for the generated profile/run/core endpoint on macOS.
  const harness = await createWorktreeHarness("worktree-composer");
  let fixtureRoot: string | undefined;
  try {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ndx-wt-ui-"));
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
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const openProjectChat = page.getByRole("button", {
      name: "Start new chat in Managed Worktree E2E",
      exact: true,
    });
    await expect(openProjectChat).toBeVisible({ timeout: 20_000 });
    await openProjectChat.click();
    await waitForProjectDraft(page, projectId);

    const composer = page.locator('[contenteditable="true"][aria-label="Do anything"]');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill("Report the current working directory.");
    await expect(composer).toHaveText("Report the current working directory.");
    await page.getByRole("button", { name: "Start in" }).click();
    await page.locator('[data-new-chat-start-in-option="newWorktree"]').click();
    await expect(composer).toHaveText("Report the current working directory.");
    await expect(page.getByRole("button", { name: "Select worktree environment" })).toContainText(
      "E2E Environment",
      { timeout: 20_000 },
    );
    const sendButton = page.getByRole("button", { name: "Send prompt" });
    await expect(sendButton).toBeEnabled({ timeout: 20_000 });
    await beginPendingWorktreeEventCapture(page);
    await sendButton.click();

    let clientThreadId: string | null = null;
    await expect
      .poll(
        async () => {
          const entries = await capturedPendingWorktreeEntries(page);
          const entry = entries.find(
            (candidate) => isRecord(candidate) && candidate.launchMode === "start-conversation",
          );
          if (!isRecord(entry) || typeof entry.clientThreadId !== "string") return "missing";
          clientThreadId = entry.clientThreadId;
          return "captured";
        },
        { timeout: 20_000 },
      )
      .toBe("captured");
    if (clientThreadId === null) throw new Error("Composer worktree returned no client id");

    const threadId = await waitForPendingThread(page, clientThreadId);
    const threadPage = page.getByTestId("session-thread-page");
    const prompt = threadPage.getByText("Report the current working directory.", { exact: true });
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(threadPage.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(threadPage.getByText("Thread could not be restored", { exact: true })).toHaveCount(
      0,
    );
    const snapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId);
    expect(worktreeInitCount(snapshot)).toBe(1);
    expect(
      rendererErrors.filter((message) => message.includes("IdentityPromotionConflict")),
    ).toEqual([]);
  } finally {
    await harness.close();
    if (fixtureRoot) {
      const resolvedFixtureRoot = path.resolve(fixtureRoot);
      const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}ndx-wt-ui-`;
      if (!resolvedFixtureRoot.startsWith(expectedPrefix)) {
        throw new Error(`Refusing to clean unexpected Composer E2E root: ${resolvedFixtureRoot}`);
      }
      fs.rmSync(resolvedFixtureRoot, { recursive: true, force: true });
    }
  }
});

test("keeps a managed Task recoverable across renderer and full app restarts", async () => {
  test.setTimeout(180_000);
  const harness = await createWorktreeHarness("worktree-restart");
  let fixtureRoot: string | undefined;
  let managedPath = "";
  try {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-e2e-"));
    const managedRoot = path.join(fixtureRoot, "managed worktrees");
    const fixture = createRepository(fixtureRoot);
    fs.mkdirSync(managedRoot, { recursive: true });
    let page = await harness.launch();
    const projectId = await createProject(page, [fixture.sourceRoot, fixture.additionalRoot]);
    const projectSessionId = await createProjectSession(page, projectId);
    await invokeIpc(page, "worktrees:settings:update", {
      worktreeRoot: managedRoot,
      autoDeleteEnabled: false,
    });

    const created = await invokeIpc(
      page,
      "codex:pending-worktree:create",
      pendingStartInput({
        ...fixture,
        environmentPath: ".codex/environments/environment.toml",
        projectId,
        projectSessionId,
      }),
    );
    if (
      !isRecord(created) ||
      typeof created.clientThreadId !== "string" ||
      typeof created.pendingWorktreeId !== "string"
    ) {
      throw new Error("Pending worktree creation returned no identities");
    }

    const threadId = await waitForPendingThread(page, created.clientThreadId);
    const liveSummary = await invokeIpc(page, "codex:thread:summary:get", threadId);
    if (!isRecord(liveSummary) || typeof liveSummary.managedWorktreePath !== "string") {
      throw new Error("Created Task returned no managed worktree path");
    }
    managedPath = liveSummary.managedWorktreePath;
    expect(path.resolve(managedPath).startsWith(`${path.resolve(managedRoot)}${path.sep}`)).toBe(
      true,
    );
    expect(fs.existsSync(managedPath)).toBe(true);

    const liveSnapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId);
    expect(worktreeInitCount(liveSnapshot)).toBe(1);
    expect(liveSummary).toMatchObject({
      threadId,
      managedWorktreePath: managedPath,
    });
    expect((liveSummary as { cwd?: string }).cwd).toBe(path.join(managedPath, "packages", "app"));
    expect(runtimeWorkspaceRoots(liveSnapshot)).toEqual([managedPath, fixture.additionalRoot]);

    const taskWindow = await invokeIpc(page, "workspace:tasks:list", projectId);
    expect(taskWindow).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: projectSessionId,
          thread: expect.objectContaining({
            threadId,
            managedWorktreePath: managedPath,
          }),
        }),
      ]),
    });
    await invokeIpc(page, "project-sessions:set-pinned", {
      operationId: createBoundedOperationId("e2e.worktree.session.pin"),
      payload: { sessionId: projectSessionId, pinned: true },
    });

    await expect
      .poll(
        async () => {
          const sidebar = await invokeIpc(page, "codex:sidebar:snapshot", { refresh: false });
          if (!isRecord(sidebar) || !Array.isArray(sidebar.items)) return null;
          const item = sidebar.items.find(
            (candidate) => isRecord(candidate) && candidate.threadId === threadId,
          );
          return isRecord(item) ? item.runLocation : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({
        kind: "local-worktree",
        path: managedPath,
        phase: "ready",
      });

    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    const rendererReloadSnapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId);
    expect(worktreeInitCount(rendererReloadSnapshot)).toBe(1);

    page = await harness.restart();
    const resumed = await invokeIpc(page, "codex:thread:resume:request", threadId);
    expect(isRecord(resumed) && isRecord(resumed.conversation)).toBe(true);
    const coldSnapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId);
    // The initialization occurrence is app-owned. Like the product runtime,
    // it survives renderer replacement but is not serialized into protocol history.
    expect(worktreeInitCount(coldSnapshot)).toBe(0);
    const coldSummary = await invokeIpc(page, "codex:thread:summary:get", threadId);
    expect(coldSummary).toMatchObject({
      threadId,
      cwd: path.join(managedPath, "packages", "app"),
      managedWorktreePath: managedPath,
    });

    let records: unknown = null;
    await expect
      .poll(
        async () => {
          try {
            records = await invokeIpc(page, "worktrees:list", "local");
            return Array.isArray(records);
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostId: "local",
          path: managedPath,
          exists: true,
          conversations: expect.arrayContaining([expect.objectContaining({ threadId })]),
        }),
      ]),
    );
    await invokeIpc(page, "worktrees:delete", "local", managedPath);
    await expect.poll(() => fs.existsSync(managedPath), { timeout: 20_000 }).toBe(false);
    const deletedAvailability = await invokeIpc(page, "worktrees:thread:availability", threadId);
    expect(deletedAvailability).toEqual({
      state: "restorable",
      repositoryPath: fixture.sourceRoot,
      snapshotRef: expect.stringMatching(/^refs\/codex\/snapshots\/[a-f0-9]{40}$/u),
    });

    const restored = await invokeIpc(page, "worktrees:thread:restore", threadId);
    expect(restored).toEqual({
      availability: { state: "available" },
      ownerWarning: null,
    });
    expect(fs.existsSync(managedPath)).toBe(true);
    expect(runGit(managedPath, ["status", "--porcelain"])).toBe("");
    const restoredAvailability = await invokeIpc(page, "worktrees:thread:availability", threadId);
    expect(restoredAvailability).toMatchObject({ state: "available" });
  } finally {
    await harness.close();
    if (fixtureRoot) {
      const resolvedFixtureRoot = path.resolve(fixtureRoot);
      const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}nodex-worktree-e2e-`;
      if (!resolvedFixtureRoot.startsWith(expectedPrefix)) {
        throw new Error(`Refusing to clean unexpected Worktree E2E root: ${resolvedFixtureRoot}`);
      }
      fs.rmSync(resolvedFixtureRoot, { recursive: true, force: true });
    }
  }
});
