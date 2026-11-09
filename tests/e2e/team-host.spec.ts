import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, stat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import electron from "electron";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { acquireAgentRuntimeProcess } from "../../src/main/platform/node/AgentRuntimeProcess";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { parsePageWork } from "../../src/shared/work-graph";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../scripts/scenarios/scenarios/document-sync-recovery";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { CoreClient } from "../../src/main/core-client/core-client";
import { connectOrStartCore } from "../../src/main/core-client/core-launcher";
import { enrollRemoteCore } from "../../src/main/core-client/remote-http";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import { openBoardPageFromCard } from "./support/open-board-page";
import { createConvergenceBoardPage, invokeIpc } from "./support/editor-scenario";
import { parseDatabaseViewId } from "../../src/shared/database-identities";
import { proveTwoDesktopBudget } from "./support/team-budget";

const exec = promisify(execFile);

test("a joined desktop starts host work, answers its question and accepts it across a host restart", async ({}, testInfo) => {
  test.setTimeout(1_200_000);
  const screenshots = process.env.NODEX_TEAM_HOST_SCREENSHOTS ?? testInfo.outputPath("screenshots");
  const root = await realpath(await mkdtemp("/tmp/ndx-host-"));
  const home = path.join(root, "space");
  const fake = path.join(root, "fake");
  const clone = path.join(root, "clone");
  const remote = "https://git.example/team/host";
  const cli = path.resolve("target/debug/nodex");
  const core = path.resolve("target/debug/nodex-core");
  const environment = {
    ...process.env,
    NODEX_HOME: home,
    NODEX_AGENT_ENDPOINT: undefined,
    NODEX_AGENT_CREDENTIAL: undefined,
    NODEX_AGENT_ATTRIBUTION: undefined,
    NODE_ENV: "test",
    NODEX_LOG_FILE: "1",
    NODEX_LOG_DIR: path.join(home, "logs"),
    NODEX_LOG_FILE_LEVEL: "info",
    NODEX_CORE_BINARY: core,
    NODEX_TEST_HOST_ELECTRON: electron as unknown as string,
    NODEX_TEST_HOST_ENTRY: path.resolve("out/main/serve.js"),
    NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: fake,
    NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: process.execPath,
    CODEX_HOME: path.join(root, "codex"),
    NODEX_HOST_CORE_AUTH: path.join(home, "run/core/core.auth"),
  };
  const command = async <T>(...args: string[]): Promise<T> => {
    const { stdout } = await exec(cli, ["--json", ...args], { env: environment, timeout: 100_000 });
    const value = JSON.parse(stdout) as { ok: boolean; result: T };
    expect(value.ok).toBe(true);
    return value.result;
  };
  const serve = <T>(...args: string[]) => command<T>("serve", ...args, "--home", home);
  type Status = {
    running: boolean;
    state: string;
    pid: number | null;
    listener: { url: string; peer_policy: "private" | "operator" };
    warning: string | null;
  };
  let running: Status | null = null;
  const foregroundChildren: Array<ReturnType<typeof spawn>> = [];
  let foregroundLog = "";
  const stop = async () => {
    if (!running?.pid) return;
    process.kill(running.pid, "SIGTERM");
    await expect
      .poll(async () => (await serve<Status>("status")).state, { timeout: 30_000 })
      .toBe("stopped");
    running = null;
  };
  const events = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(path.join(fake, "native.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  let completed = false;
  try {
    await mkdir(screenshots, { recursive: true });
    await mkdir(fake);
    await mkdir(clone);
    await mkdir(environment.CODEX_HOME);
    await writeFile(path.join(clone, "README.md"), "# Host repository\n");
    expect(await realpath(clone)).toBe(path.join(root, "clone"));
    expect(clone.startsWith(root + path.sep)).toBe(true);
    await exec("git", ["init", "-b", "main"], { cwd: clone });
    expect(
      (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: clone })).stdout.trim(),
    ).toBe(clone);
    await exec("git", ["remote", "add", "origin", remote + ".git"], { cwd: clone });
    expect(
      (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: clone })).stdout.trim(),
    ).toBe(clone);
    await exec("git", ["add", "README.md"], { cwd: clone });
    expect(
      (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: clone })).stdout.trim(),
    ).toBe(clone);
    await exec(
      "git",
      [
        "-c",
        "user.name=Host fixture",
        "-c",
        "user.email=host@example.test",
        "commit",
        "-m",
        "Initial fixture",
      ],
      { cwd: clone },
    );
    prepareScenarioCodexAppServerRuntimeSync(
      fake,
      path.resolve("scripts/scenarios/runtime/cross-provider-peer.mjs"),
    );
    await writeFile(
      path.join(fake, "plan.json"),
      JSON.stringify({ scenario: "team-host", pageId: "pending" }),
    );
    const reserved = createServer();
    await new Promise<void>((resolve, reject) => {
      reserved.once("error", reject);
      reserved.listen(0, "127.0.0.1", resolve);
    });
    const address = reserved.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const initialized = await serve<{ spaceId: string; projectId: string; name: string }>(
      "init",
      "--address",
      `127.0.0.1:${address.port}`,
      "--name",
      "Host Crew",
      "--project-name",
      "Host Project",
      "--repository",
      remote,
      "--clone",
      clone,
    );
    expect(initialized.name).toBe("Host Crew");
    const personalIntent = path.join(home, "team-transport/remote-access.json");
    await expect(readFile(personalIntent)).rejects.toMatchObject({ code: "ENOENT" });
    // A saved personal listener must neither replace nor be rewritten by this deployment.
    const personal = await connectOrStartCore({
      nodexHome: home,
      repositoryRoot: path.resolve("."),
      environment,
      isPackaged: false,
      buildId: "team-host-personal-intent",
    });
    const privateListener = await personal.client.listenSpace({
      address: "127.0.0.1:0",
      cert: null,
      key: null,
      peer_policy: "private",
    });
    expect(privateListener.url).not.toBe(`https://127.0.0.1:${address.port}`);
    const savedPersonalIntent = await readFile(personalIntent, "utf8");
    expect(JSON.parse(savedPersonalIntent)).toMatchObject({
      enabled: true,
      peer_policy: "private",
      address: privateListener.url.slice("https://".length),
    });
    await expect(
      connectOrStartCore({
        nodexHome: home,
        repositoryRoot: path.resolve("."),
        environment,
        isPackaged: false,
        buildId: "team-host-conflicting-operator",
        operatorListener: { address: `127.0.0.1:${address.port}`, cert: null, key: null },
      }),
    ).rejects.toThrow();
    expect(await readFile(personalIntent, "utf8")).toBe(savedPersonalIntent);
    await expect(personal.client.health()).resolves.toMatchObject({ status: "ready" });
    await personal.client.shutdown();
    await expect
      .poll(async () =>
        stat(path.join(home, "run/core/core.json")).then(
          () => true,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return false;
            throw cause;
          },
        ),
      )
      .toBe(false);
    if (process.platform !== "win32") {
      const key = path.join(home, "team-transport/server-identity.pem");
      for (const secret of [key, path.join(home, "nodex.db")])
        expect((await stat(secret)).mode & 0o777).toBe(0o600);
      await chmod(key, 0o640);
      try {
        await expect(serve<Status>("start")).rejects.toThrow();
        expect((await serve<Status>("status")).state).toBe("stopped");
      } finally {
        await chmod(key, 0o600);
      }
    }
    running = await serve<Status>("start");
    if (process.platform !== "win32")
      expect((await stat(path.join(home, "run/core/core.auth"))).mode & 0o777).toBe(0o600);
    expect(running.running).toBe(true);
    expect(running.listener).toMatchObject({
      url: `https://127.0.0.1:${address.port}`,
      peer_policy: "operator",
    });
    expect(await readFile(personalIntent, "utf8")).toBe(savedPersonalIntent);
    expect(running.warning).toMatch(/host user/iu);
    const alias = home.replace(/^\/private\/tmp\//u, "/tmp/");
    expect(await command<Status>("serve", "status", "--home", alias)).toMatchObject({
      running: true,
      pid: running.pid,
    });
    await expect(serve<Status>("start")).rejects.toThrow();
    expect((await serve<Status>("status")).pid).toBe(running.pid);
    const host = await CoreClient.connect({
      nodexHome: home,
      clientKind: "native_cli",
      buildId: "team-host-e2e",
    });
    const project = await host.workspaceRead({
      kind: "project",
      project_id: initialized.projectId,
    });
    if (project.value.kind !== "project" || !project.value.project.default_database_view_id)
      throw new Error("Missing initial Project");
    const boardViewId = project.value.project.default_database_view_id;
    expect(project.value.project.sources).toEqual([{ kind: "repository", remote, order: 0 }]);
    expect(project.value.project.primary_workspace_root).toBeNull();
    const view = await host.databaseRead({
      kind: "view",
      view_id: project.value.project.default_database_view_id,
    });
    if (view.value.kind !== "view") throw new Error("Missing Board");
    const hostDataSourceId = view.value.value.data_source_id;
    const created = await command<{ page_id: string }>(
      "--project",
      initialized.projectId,
      "page",
      "create",
      "--parent",
      `data_source:${hostDataSourceId}`,
      "--title",
      "Host runner task",
      "--empty",
    );
    await writeFile(
      path.join(fake, "plan.json"),
      JSON.stringify({ scenario: "team-host", pageId: created.page_id }),
    );
    const invitation = await serve<{ url: string; fingerprint: string; code: string }>(
      "invite",
      "--role",
      "owner",
    );
    await withElectronScenario(
      {
        label: "team-host",
        scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
        seedThrough: "core",
        onFailure: async ({ page, readRuntimeLogs }) => {
          await page?.screenshot({ path: path.join(screenshots, "failure.png") });
          await writeFile(
            testInfo.outputPath("renderer-errors.json"),
            JSON.stringify(
              {
                errors: (await page?.pageErrors())?.map((error) => ({
                  message: error.message,
                  stack: error.stack,
                })),
                console: (await page?.consoleMessages())?.map((entry) => ({
                  type: entry.type(),
                  text: entry.text(),
                })),
              },
              null,
              2,
            ),
          );
          if (page) {
            const diagnostics = await Promise.allSettled([
              host.workspaceRead({ kind: "page_turn", page_id: created.page_id }),
              invokeIpc(page, "work:turn", created.page_id),
              invokeIpc(page, "inbox:window", {
                scope: { kind: "all" },
                after: null,
                first: 50,
              }),
              page.evaluate(
                () =>
                  (globalThis as typeof globalThis & { hostInboxEvents?: unknown[] })
                    .hostInboxEvents,
              ),
            ]);
            await writeFile(
              testInfo.outputPath("work-state.json"),
              JSON.stringify(
                diagnostics.map((entry) =>
                  entry.status === "rejected"
                    ? { status: entry.status, error: String(entry.reason) }
                    : entry,
                ),
                null,
                2,
              ),
            );
          }
          await writeFile(testInfo.outputPath("desktop.log"), await readRuntimeLogs());
          await writeFile(
            testInfo.outputPath("host.log"),
            await readFile(path.join(home, "logs/host.log"), "utf8"),
          );
        },
      },
      async ({ page }) => {
        await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
        await page.getByRole("button", { name: "Spaces and settings", exact: true }).click();
        await page.getByRole("menuitem", { name: "Join a Space", exact: true }).click();
        const join = page.getByRole("dialog", { name: "Join a Space" });
        await join
          .getByLabel("Invite URL")
          .fill(`${invitation.url}?fingerprint=${invitation.fingerprint}`);
        await expect(join.getByText("Certificate pinned", { exact: true })).toBeVisible();
        await expect(join.getByLabel("Certificate fingerprint")).toHaveCount(0);
        await join.getByLabel("One-time code").fill(invitation.code);
        await join.getByLabel("Your name").fill("Alice");
        await join.getByRole("button", { name: "Join", exact: true }).click();
        await expect.poll(() => page.url(), { timeout: 20_000 }).toContain("spaceId=");
        await expect
          .poll(
            async () =>
              (await invokeIpc(page, "spaces:list")).find(
                (space) => space.spaceId === initialized.spaceId,
              )?.name,
          )
          .toBe("Host Crew");
        await expect(
          page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByText("Host Crew", { exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Spaces and settings", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "Host Crew", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.evaluate(() => {
          const target = globalThis as typeof globalThis & { hostInboxEvents?: unknown[] };
          target.hostInboxEvents = [];
          if (!window.api) throw new Error("Missing desktop API");
          window.api.on("inbox-changed", (event) => target.hostInboxEvents!.push(event));
        });
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect(page.getByRole("button", { name: "Open Nodex", exact: true })).toBeEnabled({
          timeout: 20_000,
        });
        await page.getByRole("button", { name: "Open Nodex", exact: true }).click();
        await expect(
          page.getByText("Nodex is monitoring the team Space.", { exact: true }),
        ).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Open Host Project", exact: true }).click();
        await openProjectBoard(page);
        const card = page.locator(`[data-board-uuid-v7="${created.page_id}"]:visible`);
        await expect(card).toBeVisible();
        await openBoardPageFromCard({ card, page, tabName: "Host runner task" });
        const member = (await invokeIpc(page, "spaces:context")).memberId;
        if (!member) throw new Error("Missing joined Member");
        const assign = async (pageId: string) => {
          const detail = await invokeIpc(page, "pages:detail:get", initialized.projectId, pageId);
          if (!detail.ok) throw new Error(detail.error.message);
          const work = detail.value.intrinsicProperties.find(
            (property) => property.key === "work",
          )!;
          const assigned = await invokeIpc(page, "block-properties:mutate", initialized.projectId, {
            mutationId: randomUUID(),
            projectId: initialized.projectId,
            storeEpoch: detail.value.storeEpoch,
            actor: { kind: "person" },
            fields: [
              {
                scope: "intrinsic",
                blockId: pageId,
                propertyKey: "work",
                operation: "set",
                expectedRevision: work.revision,
                value: {
                  ...parsePageWork(work.value)!,
                  owner: member,
                  assignee: {
                    kind: "agent",
                    instance_id: "codex",
                    model: "gpt-5.5",
                    effort: "medium",
                  },
                  auto_start: false,
                },
              },
            ],
          });
          expect(assigned.ok).toBe(true);
          return detail.value.storeEpoch;
        };
        const storeEpoch = await assign(created.page_id);
        const stage = page.locator(
          `[data-page-stage-page-id="${created.page_id}"][data-page-stage-surface="true"]:visible`,
        );
        await expect(stage.getByRole("button", { name: "Start", exact: true })).toBeEnabled({
          timeout: 20_000,
        });
        await page.screenshot({ path: path.join(screenshots, "01-start.png") });
        const history = await invokeIpc(page, "pages:history:list", {
          requestingProjectId: initialized.projectId,
          pageId: created.page_id,
        });
        expect(history.ok).toBe(true);
        if (!history.ok) throw new Error(history.error.message);
        expect(
          history.value.entries.find((entry) => entry.kind === "block_mutation"),
        ).toMatchObject({
          mutationKind: "property_batch",
          evidence: { status: "verified" },
          display: { actorLabel: "by You" },
        });
        await stage.getByRole("button", { name: "History", exact: true }).click();
        const historyDialog = page.getByRole("dialog", { name: "Page history" });
        await historyDialog.getByRole("button", { name: "Activity", exact: true }).click();
        await expect(
          historyDialog.getByRole("button", { name: /^Updated Page properties,/ }),
        ).toBeVisible();
        await expect(historyDialog.getByText("by You", { exact: true }).first()).toBeVisible();
        await expect(historyDialog.getByText("property_batch", { exact: true })).toBeVisible();
        await page.screenshot({ path: path.join(screenshots, "00-history.png") });
        await historyDialog
          .getByRole("button", { name: "Close Page history", exact: true })
          .click();
        // A real Git hook pauses allocation while a desktop reads the newly bound Session.
        const allocationStarted = path.join(root, "allocation-started");
        const allocationRelease = path.join(root, "allocation-release");
        const hook = path.join(clone, ".git/hooks/post-checkout");
        await writeFile(
          hook,
          `#!/bin/sh\ntouch '${allocationStarted}'\nattempt=0\nwhile ! test -f '${allocationRelease}'; do\n  attempt=$((attempt + 1))\n  if test "$attempt" -ge 1200; then exit 1; fi\n  sleep 0.05\ndone\n`,
        );
        await chmod(hook, 0o700);
        try {
          await stage.getByRole("button", { name: "Start", exact: true }).click();
          await expect
            .poll(
              () =>
                stat(allocationStarted).then(
                  () => true,
                  () => false,
                ),
              { timeout: 30_000 },
            )
            .toBe(true);
          const pending = await invokeIpc(page, "work:turn", created.page_id);
          if (!pending.activeChat) throw new Error("Missing preparing Session");
          // Reads may report preparation, but must not create a base-clone Thread.
          await invokeIpc(page, "agent-runtime:session:inspect", {
            sessionId: pending.activeChat.session_id,
          }).catch(() => null);
        } finally {
          await writeFile(allocationRelease, "release");
        }
        await expect
          .poll(async () => (await invokeIpc(page, "work:turn", created.page_id)).activeChat, {
            timeout: 30_000,
          })
          .not.toBeNull();
        await expect(stage.getByRole("button", { name: "Open chat", exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        const row = page.locator(`[data-inbox-page-id="${created.page_id}"]:visible`);
        await expect(
          row.getByText("Which scope should the host use?", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        const questionTurn = await invokeIpc(page, "work:turn", created.page_id);
        if (!questionTurn.activeChat) throw new Error("Missing hosted question Session");
        const observed = await host.workspaceRead({
          kind: "session_execution_observer",
          session_id: questionTurn.activeChat.session_id,
        });
        if (observed.value.kind !== "session_execution_observer")
          throw new Error("Missing question observation");
        const question = observed.value.observer?.observation?.pendingRequests.find(
          (request) => request.kind === "question",
        );
        if (!question) throw new Error("Missing pending hosted question");
        const otherInvite = await serve<{ url: string; fingerprint: string; code: string }>(
          "invite",
        );
        const otherMember = await enrollRemoteCore(otherInvite, {
          code: otherInvite.code,
          display_name: "Bob",
          device_label: "Other member desktop",
        });
        const otherDesktop = await CoreClient.connectRemote({
          ...otherInvite,
          spaceId: otherMember.space_id,
          deviceCredential: otherMember.device_credential,
          buildId: "team-host-other-member",
        });
        await expect(
          otherDesktop.hostCall({
            operation: "session_respond",
            input: {
              sessionId: questionTurn.activeChat.session_id,
              runId: observed.value.observer!.observation!.runId,
              requestId: question.id,
              answers: { scope: "Project" },
            },
          }),
        ).rejects.toThrow(/belongs to another Member/u);
        const otherInbox = await otherDesktop.workspaceRead({
          kind: "inbox_window",
          scope: { kind: "all" },
          filter: "inbox",
          window: { first: 20 },
        });
        if (otherInbox.value.kind !== "inbox_window") throw new Error("Missing other Member Inbox");
        expect(otherInbox.value.items.items.some((item) => item.page_id === created.page_id)).toBe(
          false,
        );
        const workspace = await invokeIpc(page, "work:workspace", created.page_id);
        const firstWork = (await events()).find((entry) => entry.event === "host.work")!;
        const initialExecution = await invokeIpc(page, "agent-runtime:session:inspect", {
          sessionId: questionTurn.activeChat.session_id,
        });
        expect(initialExecution.thread.worktreePath).toBe(workspace.workspace?.worktree_path);
        expect(initialExecution.thread.branch).toBe(workspace.workspace?.branch_name);
        expect(workspace.workspace?.lifecycle).toBe("ready");
        expect(firstWork.cwd).toBe(workspace.workspace?.worktree_path);
        expect(firstWork.shell).toMatchObject({
          status: 0,
          stdout: `${workspace.workspace?.worktree_path}\n${workspace.workspace?.branch_name}\n`,
        });
        await expect
          .poll(async () => {
            const snapshot = await invokeIpc(page, "agent-runtime:session:read", {
              sessionId: questionTurn.activeChat!.session_id,
            });
            return snapshot.snapshot.projection.runs[0]?.status;
          })
          .toBe("completed");
        const budgetPage = await command<{ page_id: string }>(
          "--project",
          initialized.projectId,
          "page",
          "create",
          "--parent",
          `data_source:${hostDataSourceId}`,
          "--title",
          "Budget navigation Page",
          "--empty",
        );
        const budgetInvite = await serve<{ url: string; fingerprint: string; code: string }>(
          "invite",
          "--member",
          otherMember.member_id,
        );
        await page.screenshot({ path: path.join(screenshots, "02-question.png") });
        await proveTwoDesktopBudget({
          alice: page,
          host,
          home,
          projectId: initialized.projectId,
          pageId: budgetPage.page_id,
          invite: budgetInvite,
          question: {
            sessionId: questionTurn.activeChat.session_id,
            runId: observed.value.observer!.observation!.runId!,
            requestId: question.id,
          },
          answerQuestion: async () => {
            await row.getByRole("button", { name: "Project", exact: true }).click();
            await expect(row.getByRole("button", { name: "Accept", exact: true })).toBeVisible({
              timeout: 30_000,
            });
          },
          screenshots,
          evidence:
            process.env.NODEX_TEAM_BUDGET_EVIDENCE ?? testInfo.outputPath("budget-evidence.json"),
        });
        await expect(row.getByRole("button", { name: "Accept", exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await page.screenshot({ path: path.join(screenshots, "03-ready.png") });
        await page
          .getByRole("button", { name: "Host runner task", exact: true })
          .and(page.locator("[data-app-action-sidebar-thread-row]"))
          .click();
        await expect(
          page.getByText("Host work is ready. The member answered the question.", { exact: true }),
        ).toBeVisible({ timeout: 20_000 });
        await page.screenshot({ path: path.join(screenshots, "04-transcript.png") });
        // The person reply travels through team Core to the same execution owner.
        const turn = await invokeIpc(page, "work:turn", created.page_id);
        if (!turn.activeChat) throw new Error("Missing hosted chat");
        await invokeIpc(page, "agent-runtime:session:message", {
          sessionId: turn.activeChat.session_id,
          message: { messageId: randomUUID(), text: `Thanks for ${created.page_id}` },
        });
        await expect(page.getByText("Host received your reply.", { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        await page.screenshot({ path: path.join(screenshots, "04b-reply.png") });
        // An image from this desktop reaches the host's Agent as this Member's Library File.
        const desktopShot = path.join(root, "desktop-shot.png");
        await writeFile(
          desktopShot,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGPQzrkJRwzEcQBLchcBrdrRDQAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
        const imageText = `Look at my screenshot for ${created.page_id}`;
        await invokeIpc(page, "agent-runtime:session:message", {
          sessionId: turn.activeChat.session_id,
          message: {
            messageId: randomUUID(),
            text: imageText,
            images: [{ source: desktopShot, caption: "desktop-shot.png" }],
          },
        });
        await expect
          .poll(
            async () =>
              (await events()).find(
                (entry) =>
                  entry.event === "prompt" &&
                  typeof entry.prompt === "string" &&
                  entry.prompt.includes(imageText),
              )?.inputs,
            { timeout: 30_000 },
          )
          .toEqual([{ type: "image", mimeType: "image/png" }]);
        // A picture in the hosted chat is read from the host as this Member and drawn as locally.
        await invokeIpc(page, "agent-runtime:session:message", {
          sessionId: turn.activeChat.session_id,
          message: { messageId: randomUUID(), text: "Show the host screenshot" },
        });
        await expect(page.getByText("Here is the host screenshot.", { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        let screenshotItemId: string | undefined;
        await expect
          .poll(
            async () => {
              const read = await invokeIpc(page, "agent-runtime:session:read", {
                sessionId: turn.activeChat!.session_id,
              });
              screenshotItemId = read.snapshot.projection.visibleTurnItems
                .map(({ item }) => item)
                .find(
                  (item) => item.type === "dynamic_tool" && item.mcpToolCall?.tool === "screenshot",
                )?.id;
              return screenshotItemId;
            },
            { timeout: 20_000 },
          )
          .toBeDefined();
        const picture = await invokeIpc(page, "agent-runtime:session:attachment", {
          sessionId: turn.activeChat.session_id,
          itemId: screenshotItemId!,
          attachmentId: "tool-result:0",
        });
        expect(picture).toEqual({
          dataUrl: expect.stringMatching(/^data:image\/png;base64,iVBORw0KGgo/u),
        });
        const activity = page.getByRole("button", { name: /^Worked for/u }).last();
        if ((await activity.count()) && (await activity.getAttribute("aria-expanded")) !== "true")
          await activity.click();
        const screenshot = page.getByRole("img", { name: "Tool output", exact: true });
        if (!(await screenshot.isVisible()))
          await page
            .getByRole("button", { name: /screenshot/iu })
            .last()
            .click();
        await expect(screenshot).toBeVisible({ timeout: 20_000 });
        await expect
          .poll(() => screenshot.evaluate((element: HTMLImageElement) => element.naturalWidth))
          .toBe(4);
        expect(await screenshot.getAttribute("src")).toBe(
          (picture as { readonly dataUrl: string }).dataUrl,
        );
        await page.screenshot({ path: path.join(screenshots, "04b-hosted-picture.png") });
        const bobReply = `Bob's follow-up for ${created.page_id}`;
        await otherDesktop.hostCall({
          operation: "session_message",
          input: {
            sessionId: turn.activeChat.session_id,
            message: { messageId: randomUUID(), text: bobReply },
            delivery: "send",
          },
        });
        await expect
          .poll(
            async () =>
              (await events()).some(
                (entry) =>
                  entry.event === "prompt" &&
                  typeof entry.prompt === "string" &&
                  entry.prompt.includes(bobReply),
              ),
            { timeout: 20_000 },
          )
          .toBe(true);
        await expect
          .poll(
            async () => {
              const observed = await host.workspaceRead({
                kind: "session_execution_observer",
                session_id: turn.activeChat!.session_id,
              });
              if (observed.value.kind !== "session_execution_observer") return null;
              const run = observed.value.observer?.observation?.runId;
              if (!run) return null;
              // Read-only attribution evidence; execution still crosses the real HTTPS Host path.
              const database = new DatabaseSync(path.join(home, "nodex.db"), { readOnly: true });
              try {
                return (
                  database
                    .prepare(
                      "SELECT member_id FROM session_run_members WHERE session_id=? AND run_id=?",
                    )
                    .get(turn.activeChat!.session_id, run) as { member_id: string } | undefined
                )?.member_id;
              } finally {
                database.close();
              }
            },
            { timeout: 20_000 },
          )
          .toBe(otherMember.member_id);
        const security = (await events()).find((entry) => entry.event === "host.security");
        expect(security).toMatchObject({
          secretsAbsent: true,
          contentAvailable: true,
          adminRefused: true,
        });
        const workEvents = (await events()).filter((entry) => entry.event === "host.work");
        expect(workEvents).toHaveLength(1);
        const providerLaunches = async () =>
          (await events()).filter(
            (entry) =>
              entry.event === "prompt" &&
              typeof entry.prompt === "string" &&
              entry.prompt.startsWith("# ") &&
              entry.prompt.includes(`Page ID: ${created.page_id}`),
          );
        expect(await providerLaunches()).toHaveLength(1);
        expect((await events()).find((entry) => entry.event === "host.session")).toMatchObject({
          sessionId: turn.activeChat.session_id,
        });
        const workRoot = String(workEvents[0]!.cwd);
        expect(workRoot.startsWith(path.join(root, "space-execution/worktrees") + path.sep)).toBe(
          true,
        );
        expect(await readFile(path.join(workRoot, "host-result.txt"), "utf8")).toBe(
          "Host work verified.\n",
        );
        await invokeIpc(page, "agent-runtime:session:message", {
          sessionId: turn.activeChat.session_id,
          message: { messageId: randomUUID(), text: "Refuse this hosted reply" },
        });
        await expect
          .poll(
            async () => {
              const snapshot = await invokeIpc(page, "agent-runtime:session:read", {
                sessionId: turn.activeChat!.session_id,
              });
              return snapshot.snapshot.projection.runs.at(-1)?.status;
            },
            { timeout: 30_000 },
          )
          .toBe("failed");
        await expect(page.getByText("Not sent", { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText("Sending", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: path.join(screenshots, "04c-not-sent.png") });
        await invokeIpc(page, "agent-runtime:session:message", {
          sessionId: turn.activeChat.session_id,
          message: { messageId: randomUUID(), text: "Continue after the refused reply" },
        });
        await expect
          .poll(
            async () =>
              (
                await invokeIpc(page, "agent-runtime:session:read", {
                  sessionId: turn.activeChat!.session_id,
                })
              ).snapshot.projection.runs.at(-1)?.status,
            { timeout: 30_000 },
          )
          .toBe("completed");
        // A Member starts a chat of their own on the host from New chat, as on their own
        // desktop, and edits the message they sent there; no other Member may.
        const { memberId: desktopMember } = await invokeIpc(page, "spaces:context");
        /** The started chats Core records this desktop's Member as having opened, read-only. */
        const ownChats = (projectId: string | null) => {
          const database = new DatabaseSync(path.join(home, "nodex.db"), { readOnly: true });
          try {
            return (
              database
                .prepare(
                  "SELECT session.id AS id FROM project_sessions session JOIN session_requesting_members opener ON opener.session_id=session.id AND opener.message_id='session:created' WHERE session.project_id IS ? AND opener.member_id=? AND EXISTS(SELECT 1 FROM project_session_execution_bindings binding WHERE binding.session_id=session.id)",
                )
                .all(projectId, desktopMember) as { id: string }[]
            ).map(({ id }) => id);
          } finally {
            database.close();
          }
        };
        const startedBefore = ownChats(null);
        // The Chats section reveals its New chat action on hover; keyboard activation needs none.
        const newProjectlessChat = page.getByRole("button", {
          name: "New projectless chat",
          exact: true,
        });
        await newProjectlessChat.focus();
        await newProjectlessChat.press("Enter");
        await expect(page.getByRole("button", { name: "Location", exact: true })).toHaveText(
          "Host Crew",
        );
        const opening = `Plan the release notes for ${created.page_id}`;
        await page
          .locator('[data-codex-composer="true"][contenteditable="true"]')
          .first()
          .fill(opening);
        await page.getByRole("button", { name: "Send prompt" }).click();
        const bubbles = page.locator("[data-user-message-bubble='true']");
        await expect(bubbles.filter({ hasText: opening })).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByText("Nodex is monitoring the team Space.", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        // Core records the Member who started it as the chat's owner.
        let startedChat: string | undefined;
        await expect
          .poll(
            () => {
              startedChat = ownChats(null).find((id) => !startedBefore.includes(id));
              return startedChat;
            },
            { timeout: 20_000 },
          )
          .toBeDefined();
        // The chat runs on the host without a Project, and it is its starter's to manage.
        const startedSession = await invokeIpc(page, "project-sessions:get", startedChat!);
        expect(startedSession).toMatchObject({ projectId: null, canManage: true });
        expect(startedSession?.executionRef).toBeTruthy();
        await page.screenshot({ path: path.join(screenshots, "04d-new-hosted-chat.png") });
        const ownTurn = page.locator("[data-thread-turn-id]", {
          has: bubbles.filter({ hasText: opening }),
        });
        await ownTurn.locator("[data-user-message-bubble='true']").hover();
        await ownTurn.getByRole("button", { name: "Edit message" }).click();
        const editor = page.getByRole("textbox", { name: "Edit message" });
        await expect(editor).toHaveValue(opening);
        const rewritten = `Plan the changelog instead for ${created.page_id}`;
        await editor.fill(rewritten);
        await editor.press("Enter");
        // The host rewinds the chat to the edited message and runs it again.
        await expect(editor).toHaveCount(0, { timeout: 30_000 });
        await expect
          .poll(
            async () =>
              (await events()).some(
                (entry) =>
                  entry.event === "prompt" &&
                  typeof entry.prompt === "string" &&
                  entry.prompt.includes(rewritten),
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
        await expect(bubbles.filter({ hasText: rewritten })).toBeVisible({ timeout: 30_000 });
        await expect(bubbles.filter({ hasText: opening })).toHaveCount(0, { timeout: 30_000 });
        await page.screenshot({ path: path.join(screenshots, "04e-edited-own-message.png") });
        const editedRun = (
          await invokeIpc(page, "agent-runtime:session:read", { sessionId: startedChat! })
        ).snapshot.projection.runs.at(-1)?.id;
        if (!editedRun) throw new Error("Missing the edited Run");
        await expect(
          otherDesktop.hostCall({
            operation: "session_rewrite_message",
            input: {
              sessionId: startedChat!,
              requestId: randomUUID(),
              runId: editedRun,
              message: { messageId: randomUUID(), text: "Bob rewrites Alice's message" },
            },
          }),
        ).rejects.toThrow(/Only the person who sent this message can edit it/u);
        // A chat in a Project starts where the host runs that Project, never in a folder here.
        const projectChatsBefore = ownChats(initialized.projectId);
        const newProjectChat = page.getByRole("button", {
          name: "Start new chat in Host Project",
          exact: true,
        });
        await newProjectChat.focus();
        await newProjectChat.press("Enter");
        await expect(page.getByText("What should we build in Host Project?")).toBeVisible();
        await expect(page.getByRole("button", { name: "Location", exact: true })).toHaveText(
          "Host Crew",
        );
        const projectOpening = `Review the host checkout for ${created.page_id}`;
        await page
          .locator('[data-codex-composer="true"][contenteditable="true"]')
          .first()
          .fill(projectOpening);
        await page.getByRole("button", { name: "Send prompt" }).click();
        await expect(bubbles.filter({ hasText: projectOpening })).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(
            () =>
              ownChats(initialized.projectId).filter((id) => !projectChatsBefore.includes(id))
                .length,
            { timeout: 20_000 },
          )
          .toBe(1);
        const delayed = await createConvergenceBoardPage(
          page,
          {
            projectId: initialized.projectId,
            storeEpoch,
            defaultDatabaseViewId: parseDatabaseViewId(boardViewId),
          },
          "Delayed host task",
          "Verify an independent checkout and a delayed Inbox continuation.",
        );
        await assign(delayed.pageId);
        const independentHistory = await invokeIpc(page, "pages:history:list", {
          requestingProjectId: initialized.projectId,
          pageId: delayed.pageId,
        });
        if (!independentHistory.ok) throw new Error(independentHistory.error.message);
        await writeFile(
          testInfo.outputPath("independent-history.json"),
          JSON.stringify(independentHistory.value, null, 2),
        );
        expect(
          independentHistory.value.entries.find((entry) => entry.kind === "block_mutation"),
        ).toMatchObject({
          mutationKind: "property_batch",
          evidence: { status: "verified" },
          display: { actorLabel: "by You" },
        });
        await writeFile(
          path.join(fake, "plan.json"),
          JSON.stringify({ scenario: "team-host", pageId: delayed.pageId }),
        );
        await invokeIpc(page, "work:start", { operationId: randomUUID(), pageId: delayed.pageId });
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        const delayedRow = page.locator(`[data-inbox-page-id="${delayed.pageId}"]:visible`);
        await expect(
          delayedRow.getByText("Which scope should the host use?", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        const delayedTurn = await invokeIpc(page, "work:turn", delayed.pageId);
        if (!delayedTurn.activeChat) throw new Error("Missing delayed Session");
        await expect
          .poll(async () => {
            const snapshot = await invokeIpc(page, "agent-runtime:session:read", {
              sessionId: delayedTurn.activeChat!.session_id,
            });
            return snapshot.snapshot.projection.runs[0]?.status;
          })
          .toBe("completed");
        const independent = await invokeIpc(page, "work:workspace", delayed.pageId);
        const secondWork = (await events()).filter((entry) => entry.event === "host.work")[1]!;
        expect(secondWork.cwd).toBe(independent.workspace?.worktree_path);
        expect(secondWork.cwd).not.toBe(workRoot);
        expect(independent.workspace?.branch_name).not.toBe(workspace.workspace?.branch_name);
        expect(secondWork.shell).toMatchObject({
          status: 0,
          stdout: `${independent.workspace?.worktree_path}\n${independent.workspace?.branch_name}\n`,
        });
        // The reply outlives native completion and the idle provider lease.
        const replyDelayStarted = Date.now();
        // Elapsed time ages the lease as a fault input; the following Run and
        // delivery assertions synchronize on their actual Core state.
        await expect
          .poll(() => Date.now() - replyDelayStarted, {
            timeout: 365_000,
            intervals: [5_000],
          })
          .toBeGreaterThanOrEqual(355_000);
        await delayedRow.getByRole("button", { name: "Project", exact: true }).click();
        const delayedReplyMs = Date.now() - replyDelayStarted;
        await expect(delayedRow.getByRole("button", { name: "Accept", exact: true })).toBeVisible({
          timeout: 30_000,
        });
        const delayedSnapshot = (
          await invokeIpc(page, "agent-runtime:session:read", {
            sessionId: delayedTurn.activeChat.session_id,
          })
        ).snapshot;
        expect(delayedSnapshot.projection.thread.worktreePath).toBe(
          independent.workspace?.worktree_path,
        );
        expect(delayedSnapshot.projection.thread.branch).toBe(independent.workspace?.branch_name);
        expect(delayedSnapshot.projection.runs).toHaveLength(2);
        expect(delayedSnapshot.projection.runs.every((run) => run.status === "completed")).toBe(
          true,
        );
        expect(delayedSnapshot.projection.providerTurns).toHaveLength(2);
        expect(
          (await events()).filter((entry) => entry.event === "host.answer").at(-1)?.threadId,
        ).toBe(secondWork.threadId);
        expect(
          new Set(delayedSnapshot.projection.providerTurns.map((turn) => turn.providerThreadId))
            .size,
        ).toBe(1);
        const runRequesters: Record<string, string> = {};
        const database = new DatabaseSync(path.join(home, "nodex.db"), { readOnly: true });
        try {
          for (const run of delayedSnapshot.projection.runs) {
            const requester = database
              .prepare("SELECT member_id FROM session_run_members WHERE session_id=? AND run_id=?")
              .get(delayedTurn.activeChat.session_id, run.id) as { member_id: string };
            expect(requester.member_id).toBe(member);
            runRequesters[run.id] = requester.member_id;
          }
        } finally {
          database.close();
        }
        await delayedRow.getByRole("button", { name: "Accept", exact: true }).click();
        await expect
          .poll(
            async () =>
              (await invokeIpc(page, "work:workspace", delayed.pageId)).workspace?.lifecycle,
            { timeout: 30_000 },
          )
          .toBe("removed");
        expect(
          await stat(String(secondWork.cwd)).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        expect(
          (
            await exec(
              "git",
              ["show-ref", "--verify", `refs/heads/${independent.workspace!.branch_name}`],
              { cwd: clone },
            )
          ).stdout,
        ).toContain("refs/heads/");
        await serve("rename", "Delivery Crew");
        await stop();
        // Reproduce the persisted consumer location left by the old hosted Start,
        // using Runtime's relocation boundary while the host is fully stopped.
        // The Page still owns its physical checkout, which restart must clean up.
        // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- Playwright owns this test; the offline Runtime fixture has one scoped NodeServices root.
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* acquireAgentRuntimeProcess({
                executable: process.execPath,
                entryPath: path.resolve("out/agent-runtime/entry.mjs"),
                environment,
                configuration: {
                  home: path.join(root, "space-execution/agent-runtime"),
                  cwd: clone,
                  providers: {},
                },
                host: () => Effect.die("The historical-location fixture must not execute work"),
              });
              expect(runtime.identity.runtimeId).toBe(initialExecution.runtimeId);
              const threadId = initialExecution.threadId;
              const thread = yield* runtime.request("thread.read", { threadId });
              expect(thread?.worktreePath).toBe(workRoot);
              const sourceLocation = thread?.executionLocation ?? {
                hostId: "local",
                cwd: workRoot,
                workspaceRoots: [workRoot],
                managedWorktreePath: workRoot,
                projectId: initialized.projectId,
                projectlessOutputDirectory: null,
                projectlessWorkspaceBrowserRoot: null,
              };
              const operationId = "test:historical-host-consumer";
              yield* runtime.request("execution.handoff.hold", {
                threadId,
                operationId,
                action: "acquire",
                sourceLocation,
              });
              yield* runtime.request("execution.handoff.quiesce", { threadId, operationId });
              yield* runtime.request("execution.handoff.commit", {
                threadId,
                operationId,
                location: {
                  ...sourceLocation,
                  cwd: clone,
                  workspaceRoots: [clone],
                  managedWorktreePath: null,
                },
              });
              yield* runtime.request("execution.handoff.hold", {
                threadId,
                operationId,
                action: "release",
              });
              expect((yield* runtime.request("thread.read", { threadId }))?.worktreePath).toBe(
                clone,
              );
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
        expect((await stat(workRoot)).isDirectory()).toBe(true);
        const foregroundHost = spawn(
          cli,
          ["--json", "serve", "start", "--home", home, "--foreground"],
          {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        foregroundChildren.push(foregroundHost);
        foregroundHost.stdout.on("data", (chunk) => {
          foregroundLog += String(chunk);
        });
        foregroundHost.stderr.on("data", (chunk) => {
          foregroundLog += String(chunk);
        });
        await expect
          .poll(
            async () => {
              if (foregroundHost.exitCode !== null || foregroundHost.signalCode !== null)
                throw new Error(`Foreground host stopped: ${foregroundLog}`);
              running = await serve<Status>("status");
              return running.running;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        if (process.platform !== "win32") expect(running!.pid).toBe(foregroundHost.pid);
        await expect
          .poll(() => invokeIpc(page, "work:host-status").catch(() => ({ available: false })), {
            timeout: 30_000,
          })
          .toMatchObject({ available: true });
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect
          .poll(
            async () =>
              (await invokeIpc(page, "spaces:list")).find(
                (space) => space.spaceId === initialized.spaceId,
              )?.name,
          )
          .toBe("Delivery Crew");
        await expect(
          page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByText("Delivery Crew", { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: path.join(screenshots, "05a-renamed-after-restart.png") });
        await row.getByRole("button", { name: "Accept", exact: true }).click();
        await page.getByRole("button", { name: "Open Host Project", exact: true }).click();
        await openProjectBoard(page);
        await expect(
          page
            .locator('[data-board-column-id="done"]')
            .locator(`[data-board-uuid-v7="${created.page_id}"]`),
        ).toBeVisible();
        await expect
          .poll(
            async () =>
              (await invokeIpc(page, "work:workspace", created.page_id)).workspace?.lifecycle,
            { timeout: 30_000 },
          )
          .toBe("removed");
        expect(
          await stat(workRoot).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        expect(
          (
            await exec(
              "git",
              ["show-ref", "--verify", `refs/heads/${workspace.workspace!.branch_name}`],
              { cwd: clone },
            )
          ).stdout,
        ).toContain("refs/heads/");
        expect((await events()).filter((entry) => entry.event === "host.work")).toHaveLength(2);
        expect(await providerLaunches()).toHaveLength(1);
        await page.screenshot({ path: path.join(screenshots, "05-accepted-after-restart.png") });
        // Interrupt another native Run while its question is outstanding. Recovery must
        // settle the old Run without replaying its launch or submitting an answer.
        const interruptedPage = await command<{ page_id: string }>(
          "--project",
          initialized.projectId,
          "page",
          "create",
          "--parent",
          `data_source:${hostDataSourceId}`,
          "--title",
          "Interrupted host task",
          "--empty",
          "--idempotency-key",
          "host-interrupted-page",
        );
        await writeFile(
          path.join(fake, "plan.json"),
          JSON.stringify({
            scenario: "team-host",
            pageId: interruptedPage.page_id,
            questionMode: "blocking",
          }),
        );
        const answersBeforeInterruption = (await events()).filter(
          (entry) => entry.event === "host.answer",
        ).length;
        const interruptedStart = await invokeIpc(page, "work:start", {
          operationId: createBoundedOperationId("interrupted-host-run"),
          pageId: interruptedPage.page_id,
          selection: { instanceId: "codex", model: "gpt-5.5", effort: "medium" },
        });
        if (!interruptedStart.ok) throw new Error(interruptedStart.error.message);
        await expect
          .poll(
            async () => (await events()).filter((entry) => entry.event === "host.work").length,
            { timeout: 30_000 },
          )
          .toBe(3);
        const interruptedTurn = await invokeIpc(page, "work:turn", interruptedPage.page_id);
        if (!interruptedTurn.activeChat) throw new Error("Missing interrupted Work Session");
        const interruptedSessionId = interruptedTurn.activeChat.session_id;
        const beforeRestart = await CoreClient.connect({
          nodexHome: home,
          clientKind: "native_cli",
          buildId: "mid-run-fault",
        });
        await expect
          .poll(
            async () => {
              const read = await beforeRestart.workspaceRead({
                kind: "session_execution_observer",
                session_id: interruptedSessionId,
              });
              return read.value.kind === "session_execution_observer"
                ? read.value.observer?.observation?.state
                : null;
            },
            { timeout: 20_000 },
          )
          .toBe("waiting");
        await stop();
        running = await serve<Status>("start");
        expect(running.listener.peer_policy).toBe("operator");
        expect(await readFile(personalIntent, "utf8")).toBe(savedPersonalIntent);
        await expect
          .poll(() => invokeIpc(page, "work:host-status").catch(() => ({ available: false })), {
            timeout: 30_000,
          })
          .toMatchObject({ available: true });
        const afterRestart = await CoreClient.connect({
          nodexHome: home,
          clientKind: "native_cli",
          buildId: "mid-run-recovered",
        });
        await expect
          .poll(
            async () => {
              const read = await afterRestart.workspaceRead({
                kind: "session_execution_observer",
                session_id: interruptedSessionId,
              });
              return read.value.kind === "session_execution_observer"
                ? read.value.observer?.observation?.pendingRequestIds
                : null;
            },
            { timeout: 30_000 },
          )
          .toEqual([]);
        expect((await events()).filter((entry) => entry.event === "host.work")).toHaveLength(3);
        expect((await events()).filter((entry) => entry.event === "host.answer")).toHaveLength(
          answersBeforeInterruption,
        );
        expect(
          (await events()).filter(
            (entry) =>
              entry.event === "prompt" &&
              typeof entry.prompt === "string" &&
              entry.prompt.startsWith("# ") &&
              entry.prompt.includes(`Page ID: ${interruptedPage.page_id}`),
          ),
        ).toHaveLength(1);
        await page.screenshot({ path: path.join(screenshots, "06-interrupted-run-recovered.png") });
        await writeFile(
          testInfo.outputPath("evidence.json"),
          JSON.stringify(
            {
              security,
              firstWorkspace: workspace.workspace,
              secondWorkspace: independent.workspace,
              firstShell: firstWork.shell,
              secondShell: secondWork.shell,
              delayedReplyMs,
              delayedRuns: delayedSnapshot.projection.runs,
              requestingMemberId: member,
              delayedRunRequesters: runRequesters,
              reusedNativeThreadId: secondWork.threadId,
              cleanupRemovedBothCheckouts: true,
              cleanupRecoveredBaseCloneConsumer: true,
              sessionId: turn.activeChat.session_id,
              launches: (await providerLaunches()).length,
              workExecutions: (await events()).filter((entry) => entry.event === "host.work")
                .length,
              foregroundPid: foregroundHost.pid,
              otherMemberQuestionRefused: true,
              followupRequesterMemberId: otherMember.member_id,
              acceptedAfterRestart: true,
              interruptedRunSettledWithoutDuplicateStartOrAnswer: true,
              spaceNameAfterRestart: "Delivery Crew",
            },
            null,
            2,
          ),
        );
        await stop();
        await expect
          .poll(() => foregroundHost.exitCode ?? foregroundHost.signalCode, { timeout: 15_000 })
          .not.toBeNull();
        await writeFile(testInfo.outputPath("foreground.log"), foregroundLog);
      },
    );
    completed = true;
  } catch (cause) {
    await writeFile(testInfo.outputPath("foreground.log"), foregroundLog);
    for (const [name, file] of [
      ["host.log", path.join(home, "logs/host.log")],
      ["native.jsonl", path.join(fake, "native.jsonl")],
    ] as const) {
      const content = await readFile(file, "utf8").catch(() => "Unavailable");
      await writeFile(testInfo.outputPath(name), content);
    }
    throw cause;
  } finally {
    await stop();
    for (const child of foregroundChildren)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (completed) await rm(root, { recursive: true, force: true });
    else await writeFile(testInfo.outputPath("home.txt"), root);
  }
});
