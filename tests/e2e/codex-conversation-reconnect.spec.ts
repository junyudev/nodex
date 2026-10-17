import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentFollowUp,
  sendAgentPrompt,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

interface LogEntry {
  readonly method: string;
  readonly pid?: number;
  readonly params: {
    readonly args?: string[];
    readonly cwd?: string;
    readonly threadId?: string;
    readonly input?: Array<{ type: string; text?: string }>;
  };
}

test("two windows keep an Agent chat going after its Codex process exits", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "conversation-agent-reconnect",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  const readLog = (): LogEntry[] => {
    const file = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  };
  const turnStarts = () => readLog().filter((entry) => entry.method === "turn/start");
  const prompts = () =>
    turnStarts().map((entry) => entry.params.input?.find((item) => item.type === "text")?.text);
  const bubble = (page: Page, prompt: string) =>
    page.locator("[data-user-message-bubble='true']").filter({ hasText: prompt });
  const firstPrompt = "Preserve this history across the Codex restart";
  const secondPrompt = "Continue after Codex comes back";
  let failure: unknown;
  try {
    const first = await harness.launch();
    const draft = await createAgentSmokeDraft(
      first,
      harness.profile.initialProjectsDirectory,
      "Reconnect history",
    );
    const threadId = await sendAgentPrompt(first, draft.projectSessionId, firstPrompt);
    const target = { sessionId: draft.projectSessionId, threadId };
    await waitForRuntimeCompletedAgentTurn(first, target);
    const opened = harness.application.waitForEvent("window");
    expect(
      await invokeIpc(first, "window:new", {
        activeProjectSessionId: draft.projectSessionId,
        activeProjectId: draft.projectId,
      }),
    ).toBe(true);
    const second = await opened;
    await second.waitForURL((url) => url.protocol !== "about:");
    await second.waitForLoadState("domcontentloaded");
    await second.evaluate(() => window.api?.awaitInitialization?.());
    for (const page of [first, second]) await expect(bubble(page, firstPrompt)).toHaveCount(1);

    // Only this fresh Profile's fixture log names the process; never a user's running app.
    const [started] = turnStarts();
    const pid = started?.pid;
    if (!pid || pid === process.pid) throw new Error("The Codex process of this chat is unknown");
    const nativeThreadId = started.params.threadId;
    process.kill(pid, "SIGTERM");

    await sendAgentFollowUp(second, secondPrompt);
    await expect.poll(prompts, { timeout: 30_000 }).toEqual([firstPrompt, secondPrompt]);
    await waitForRuntimeCompletedAgentTurn(second, target, 30_000);
    const resumed = turnStarts()[1]!;
    // A new Codex process resumes the same native thread at the same location.
    expect(resumed.pid).not.toBe(pid);
    expect(resumed.params.threadId).toBe(nativeThreadId);
    expect(resumed.params.cwd).toBe(started.params.cwd);
    expect(
      readLog().some(
        (entry) =>
          entry.pid === resumed.pid &&
          entry.method === "rpc" &&
          (entry.params as { method?: string }).method === "thread/resume",
      ),
    ).toBe(true);
    for (const page of [first, second]) {
      await expect(bubble(page, firstPrompt)).toHaveCount(1);
      await expect(bubble(page, secondPrompt)).toHaveCount(1);
      await expect(page.getByText("The task completed successfully.", { exact: true })).toHaveCount(
        2,
      );
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    }
  } catch (error) {
    failure = error;
    await test.info().attach("reconnect-runtime.log", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    await test.info().attach("reconnect-requests.json", {
      body: JSON.stringify(readLog(), null, 2),
      contentType: "application/json",
    });
    throw error;
  } finally {
    try {
      await harness.close();
    } catch (error) {
      if (!failure) throw error;
      throw new AggregateError([failure, error], "Reconnect workflow and cleanup failed", {
        cause: error,
      });
    }
  }
});
