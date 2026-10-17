import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import { AGENT_CLI_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import type { CodexThreadHandoffSnapshot } from "../../src/shared/codex-thread-handoff";
import type { ProjectSession } from "../../src/shared/types";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/agent-smoke-harness";
import { chooseComposerModel } from "./support/composer-model-picker";
import { openSummaryPanel } from "./support/subagents-panel";

interface NativeObservation {
  readonly type: "launch" | "prompt";
  readonly cwd: string;
  readonly sessionId: string;
  readonly resumed?: boolean;
  readonly persistent?: boolean;
  readonly content?: string;
  readonly historyPromptTexts?: readonly string[];
  readonly priorPromptTexts?: readonly string[];
}

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const readNativeObservations = (filePath: string): NativeObservation[] => {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NativeObservation);
};

test("moves a Claude Code chat with its uncommitted files and native history across worktree, restart, and local checkout", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "claude-thread-handoff",
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  const sourceRoot = realpathSync(harness.profile.initialProjectsDirectory);
  const managedRoot = path.join(harness.profile.runRoot, "managed worktrees");
  const nativeHome = path.join(harness.profile.runRoot, "native-claude");
  const observationsPath = path.join(nativeHome, "observations.jsonl");
  const executable = path.join(harness.profile.runRoot, "claude");
  const peer = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
  ).href;
  const rendererErrors: string[] = [];
  let threadId: string | null = null;
  let nativeSessionId: string | null = null;
  let sessionId: string | null = null;

  try {
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(executable, `#!${process.execPath}\nimport(${JSON.stringify(peer)});\n`, {
      mode: 0o755,
    });
    writeFileSync(path.join(sourceRoot, "README.md"), "Original workspace\n");
    runGit(sourceRoot, "init", "--initial-branch=main");
    runGit(sourceRoot, "config", "user.name", "Nodex Handoff E2E");
    runGit(sourceRoot, "config", "user.email", "handoff-e2e@nodex.invalid");
    runGit(sourceRoot, "add", ".");
    runGit(sourceRoot, "commit", "-m", "Prepare isolated handoff workspace");
    runGit(sourceRoot, "checkout", "-b", "task-work");

    let page = await harness.launch();
    const observeRenderer = (target: Page) =>
      target.on("pageerror", (error) => rendererErrors.push(error.message));
    observeRenderer(page);
    const manifest = await materializeScenario(
      AGENT_CLI_SCENARIO_ID,
      new RendererIpcSeedAdapter(page),
      sourceRoot,
    );
    await invokeIpc(page, "worktrees:settings:update", {
      worktreeRoot: managedRoot,
      autoDeleteEnabled: false,
    });
    await invokeIpc(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-handoff",
          displayName: "Claude Code",
          binaryPath: executable,
          configDirectory: nativeHome,
          enabled: true,
          environment: [],
        },
      ],
    });
    sessionId = createUuidV7();
    const created = await invokeIpc(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.claude.handoff.create"),
      payload: {
        sessionId,
        input: {
          projectId: manifest.projectId,
          noThreadFallbackTitle: "Claude handoff",
          initialPageIds: [],
        },
      },
    });
    expect(created).toMatchObject({ ok: true });
    const projectRow = page.locator(`[data-app-action-sidebar-project-id="${manifest.projectId}"]`);
    const chatRow = page.getByText("Claude handoff", { exact: true }).first();
    // The expand control shows on hover; a re-render can take it away mid-click.
    await expect(async () => {
      await projectRow.hover();
      const expand = projectRow.getByRole("button", { name: "Expand project", exact: true });
      if (await expand.count()) await expand.click({ timeout: 1_000 });
      await expect(chatRow).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await chatRow.click();
    await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
    await page.keyboard.press("Escape");

    const composer = () =>
      page.locator('[data-codex-composer="true"][contenteditable="true"]:visible').first();
    const submit = async (phase: string) => {
      await composer().fill(`Verify handoff ${phase}`);
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      await expect(
        page.getByText(`Native handoff verified: ${phase}`, { exact: true }),
      ).toBeVisible();
    };
    await submit("origin");
    const original = (await invokeIpc(page, "project-sessions:get", sessionId)) as ProjectSession;
    if (!original.executionRef) throw new Error("Claude chat did not start in its Session");
    threadId = original.executionRef.threadId;
    const target = { sessionId, threadId };
    const location = async () =>
      ((await invokeIpc(page, "agent-runtime:session:control", target)) as AgentRuntimeConversation)
        .snapshot.projection.thread.worktreePath;
    nativeSessionId =
      readNativeObservations(observationsPath).find(
        (entry) => entry.type === "launch" && entry.persistent,
      )?.sessionId ?? null;
    if (!nativeSessionId) throw new Error("Claude did not start a native session");
    expect(await location()).toBe(sourceRoot);

    writeFileSync(path.join(sourceRoot, "README.md"), "Uncommitted task changes\n");
    writeFileSync(path.join(sourceRoot, "task-notes.txt"), "Untracked task context\n");
    expect(runGit(sourceRoot, "status", "--porcelain")).toContain("README.md");
    await composer().fill("Retain my handoff draft");

    const move = async (destination: "local" | "worktree", rejected = false) => {
      const summary = await openSummaryPanel(page);
      const trigger = summary.locator('[data-thread-execution-location-trigger="true"]');
      const sourceLabel = destination === "worktree" ? "Local" : "Worktree";
      await expect(trigger).toHaveText(sourceLabel);
      const before = await location();
      const previousOperations = new Set(
        (
          (await invokeIpc(page, "codex:thread-handoffs:list")) as CodexThreadHandoffSnapshot
        ).operations.map((operation) => operation.operationId),
      );
      await trigger.click();
      await page.locator(`[data-thread-execution-destination="${destination}"]`).click();
      const title = destination === "worktree" ? "Move to worktree" : "Move to local";
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(trigger).toHaveText(sourceLabel);
      // Nothing moves until the move is confirmed.
      expect(await location()).toBe(before);
      await dialog.getByRole("button", { name: title, exact: true }).click();
      await expect
        .poll(
          async () => {
            const snapshot = (await invokeIpc(
              page,
              "codex:thread-handoffs:list",
            )) as CodexThreadHandoffSnapshot;
            const operation = snapshot.operations
              .filter(
                (entry) =>
                  entry.sourceThreadId === threadId && !previousOperations.has(entry.operationId),
              )
              .at(-1);
            if (operation?.status === "error" && !rejected)
              throw new Error(operation.message ?? "Thread handoff failed");
            return operation?.direction ===
              (destination === "worktree" ? "local-to-worktree" : "worktree-to-local")
              ? operation.status
              : null;
          },
          { timeout: 30_000, intervals: [100, 250, 500], message: `${title} terminal state` },
        )
        .toBe(rejected ? "error" : "success");
      if (rejected) {
        const operation = (
          (await invokeIpc(page, "codex:thread-handoffs:list")) as CodexThreadHandoffSnapshot
        ).operations
          .filter(
            (entry) =>
              entry.sourceThreadId === threadId && !previousOperations.has(entry.operationId),
          )
          .at(-1);
        expect(operation).toMatchObject({
          status: "error",
          recoveryRequired: false,
          completedAt: expect.any(Number),
        });
        expect(operation?.message).toContain("Stash or commit your local changes");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(trigger).toHaveText(sourceLabel);
        return await location();
      }
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toHaveText(destination === "worktree" ? "Worktree" : "Local");
      return await location();
    };
    const worktreeRoot = await move("worktree");
    if (!worktreeRoot) throw new Error("Move to worktree did not retain its destination");
    expect(worktreeRoot.startsWith(`${realpathSync(managedRoot)}${path.sep}`)).toBe(true);
    expect(runGit(sourceRoot, "branch", "--show-current")).toBe("main");
    expect(runGit(sourceRoot, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(worktreeRoot, "README.md"), "utf8")).toBe(
      "Uncommitted task changes\n",
    );
    expect(readFileSync(path.join(worktreeRoot, "task-notes.txt"), "utf8")).toBe(
      "Untracked task context\n",
    );
    expect(runGit(worktreeRoot, "branch", "--show-current")).toBe("task-work");
    await expect(composer()).toHaveText("Retain my handoff draft");
    await submit("worktree");
    expect(
      readNativeObservations(observationsPath)
        .filter((entry) => entry.type === "prompt")
        .at(-1),
    ).toMatchObject({
      cwd: worktreeRoot,
      sessionId: nativeSessionId,
      priorPromptTexts: ["Verify handoff origin"],
    });
    await page.screenshot({ path: test.info().outputPath("claude-worktree-handoff.png") });

    page = await harness.restart();
    observeRenderer(page);
    // The chat reopens in its worktree with its history; the next message resumes Claude there.
    await expect(page.getByText("Native handoff verified: worktree", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(await location()).toBe(worktreeRoot);
    await submit("restarted");
    expect(
      readNativeObservations(observationsPath)
        .filter((entry) => entry.type === "launch" && entry.persistent)
        .at(-1),
    ).toMatchObject({
      cwd: worktreeRoot,
      sessionId: nativeSessionId,
      resumed: true,
      historyPromptTexts: ["Verify handoff origin", "Verify handoff worktree"],
    });
    const blockingFile = path.join(sourceRoot, "local-only.txt");
    writeFileSync(blockingFile, "Keep local changes\n");
    expect(await move("local", true)).toBe(worktreeRoot);
    expect(readFileSync(blockingFile, "utf8")).toBe("Keep local changes\n");
    expect(readFileSync(path.join(worktreeRoot, "README.md"), "utf8")).toBe(
      "Uncommitted task changes\n",
    );
    await submit("after-rejection");
    expect(
      readNativeObservations(observationsPath)
        .filter((entry) => entry.type === "prompt")
        .at(-1),
    ).toMatchObject({
      cwd: worktreeRoot,
      sessionId: nativeSessionId,
      priorPromptTexts: [
        "Verify handoff origin",
        "Verify handoff worktree",
        "Verify handoff restarted",
      ],
    });
    rmSync(blockingFile);
    expect(await move("local")).toBe(sourceRoot);
    expect(runGit(sourceRoot, "branch", "--show-current")).toBe("task-work");
    expect(readFileSync(path.join(sourceRoot, "README.md"), "utf8")).toBe(
      "Uncommitted task changes\n",
    );
    expect(readFileSync(path.join(sourceRoot, "task-notes.txt"), "utf8")).toBe(
      "Untracked task context\n",
    );
    expect(runGit(worktreeRoot, "status", "--porcelain")).toBe("");
    await expect(
      (await openSummaryPanel(page)).getByRole("button", {
        name: "task-work",
        exact: true,
      }),
    ).toBeVisible();
    await submit("local");
    expect(
      readNativeObservations(observationsPath)
        .filter((entry) => entry.type === "prompt")
        .at(-1),
    ).toMatchObject({
      cwd: sourceRoot,
      sessionId: nativeSessionId,
      priorPromptTexts: [
        "Verify handoff origin",
        "Verify handoff worktree",
        "Verify handoff restarted",
        "Verify handoff after-rejection",
      ],
    });
    // One Claude session carried the whole conversation across every location.
    expect(
      new Set(
        readNativeObservations(observationsPath)
          .filter((entry) => entry.type === "prompt")
          .map((entry) => entry.sessionId),
      ),
    ).toEqual(new Set([nativeSessionId]));
    expect(rendererErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("claude-local-handoff.png") });
    await test.info().attach("native-execution-history", {
      body: readFileSync(observationsPath, "utf8"),
      contentType: "application/jsonl",
    });
  } catch (error) {
    await test.info().attach("handoff-runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    await test.info().attach("handoff-native", {
      body: existsSync(observationsPath)
        ? readFileSync(observationsPath, "utf8")
        : "No native execution",
      contentType: "text/plain",
    });
    if (threadId) {
      const handoffs = await invokeIpc(harness.page, "codex:thread-handoffs:list").catch(
        (cause: unknown) => String(cause),
      );
      await test.info().attach("handoff-operation", {
        body: JSON.stringify(
          typeof handoffs === "string"
            ? handoffs
            : ((handoffs as CodexThreadHandoffSnapshot).operations
                .filter((operation) => operation.sourceThreadId === threadId)
                .at(-1) ?? null),
        ),
        contentType: "application/json",
      });
      const diagnostic = await invokeIpc(
        harness.page,
        "agent-backend:session:read",
        threadId,
      ).catch((cause: unknown) => String(cause));
      await test.info().attach("handoff-conversation", {
        body: JSON.stringify({
          threadId,
          nativeSessionId,
          sessionId,
          diagnostic,
          rendererErrors,
        }),
        contentType: "application/json",
      });
    }
    throw error;
  } finally {
    await harness.close();
  }
});
