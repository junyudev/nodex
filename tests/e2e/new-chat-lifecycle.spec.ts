import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";

const repositoryRoot = process.cwd();

interface NewChatTransitionSample {
  readonly atMs: number;
  readonly composerContainsPrompt: boolean;
  readonly userMessageCount: number;
  readonly clientUserMessageIds: readonly string[];
  readonly allUserMessageCount: number;
  readonly composerLabels: readonly string[];
  readonly hasNewThreadHome: boolean;
  readonly hasSessionThreadPage: boolean;
  readonly hasEmptySessionRoute: boolean;
  readonly hasThreadShell: boolean;
  readonly turnKeys: readonly string[];
  readonly threadBodyText: string;
}

interface NewChatTransitionCapture {
  readonly samples: readonly NewChatTransitionSample[];
  readonly blankFrameCount: number;
  readonly duplicateFrameCount: number;
  readonly homeAndUserMessageFrameCount: number;
  readonly submitToFirstVisibleUserMessageMs: number | null;
  readonly submitToThreadSurfaceMs: number | null;
}

const createHarness = async (
  label: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<ElectronScenarioHarness> => {
  const harness = await ElectronScenarioHarness.create({
    label,
    prepareAgentRuntime: false,
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
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

const beginTransitionCapture = async (page: Page, prompt: string): Promise<void> => {
  await page.evaluate((expectedPrompt) => {
    const scope = window as typeof window & {
      __newChatTransitionObserver?: MutationObserver;
      __newChatTransitionAnimationFrame?: number;
      __newChatTransitionSamples?: NewChatTransitionSample[];
      __newChatTransitionSubmittedAtMs?: number | null;
      __newChatFirstUserMessageAtMs?: number | null;
      __newChatThreadSurfaceAtMs?: number | null;
      __newChatBlankFrameCount?: number;
      __newChatDuplicateFrameCount?: number;
      __newChatHomeAndUserMessageFrameCount?: number;
    };
    scope.__newChatTransitionObserver?.disconnect();
    if (scope.__newChatTransitionAnimationFrame !== undefined) {
      cancelAnimationFrame(scope.__newChatTransitionAnimationFrame);
    }
    scope.__newChatTransitionSamples = [];
    scope.__newChatTransitionSubmittedAtMs = null;
    scope.__newChatFirstUserMessageAtMs = null;
    scope.__newChatThreadSurfaceAtMs = null;
    scope.__newChatBlankFrameCount = 0;
    scope.__newChatDuplicateFrameCount = 0;
    scope.__newChatHomeAndUserMessageFrameCount = 0;
    const sample = (animationFrame: boolean) => {
      const now = performance.now();
      const composers = Array.from(
        document.querySelectorAll<HTMLElement>("[data-codex-composer='true']"),
      );
      const composerContainsPrompt = composers.some(
        (composer) => composer.textContent?.includes(expectedPrompt) === true,
      );
      const allUserMessages = Array.from(
        document.querySelectorAll<HTMLElement>("[data-user-message-bubble='true']"),
      );
      const userMessages = allUserMessages.filter(
        (bubble) => bubble.textContent?.includes(expectedPrompt) === true,
      );
      const clientUserMessageIds = [
        ...new Set(
          userMessages.flatMap((bubble) => {
            const value = bubble.dataset.clientUserMessageId;
            return value ? [value] : [];
          }),
        ),
      ];
      const submittedAtMs = scope.__newChatTransitionSubmittedAtMs;
      const hasNewThreadHome =
        document.querySelector("[data-new-thread-home-main='true']") !== null;
      const hasThreadShell =
        document.querySelector("[data-local-conversation-thread-body='true']") !== null;
      const threadBody = document.querySelector<HTMLElement>(
        "[data-local-conversation-thread-body='true']",
      );
      if (submittedAtMs !== null && submittedAtMs !== undefined) {
        if (userMessages.length > 0 && scope.__newChatFirstUserMessageAtMs === null) {
          scope.__newChatFirstUserMessageAtMs = now;
        }
        if (hasThreadShell && !hasNewThreadHome && scope.__newChatThreadSurfaceAtMs === null) {
          scope.__newChatThreadSurfaceAtMs = now;
        }
        if (animationFrame && !composerContainsPrompt && userMessages.length === 0) {
          scope.__newChatBlankFrameCount = (scope.__newChatBlankFrameCount ?? 0) + 1;
        }
        if (animationFrame && userMessages.length > 1) {
          scope.__newChatDuplicateFrameCount = (scope.__newChatDuplicateFrameCount ?? 0) + 1;
        }
        if (animationFrame && hasNewThreadHome && userMessages.length > 0) {
          scope.__newChatHomeAndUserMessageFrameCount =
            (scope.__newChatHomeAndUserMessageFrameCount ?? 0) + 1;
        }
      }
      const next = {
        atMs: now,
        composerContainsPrompt,
        userMessageCount: userMessages.length,
        clientUserMessageIds,
        allUserMessageCount: allUserMessages.length,
        composerLabels: composers.flatMap((composer) => {
          const label = composer.getAttribute("aria-label");
          return label ? [label] : [];
        }),
        hasNewThreadHome,
        hasSessionThreadPage:
          document.querySelector('[data-testid="session-thread-page"]') !== null,
        hasEmptySessionRoute:
          document.body.textContent?.includes("Select a project session.") === true,
        hasThreadShell,
        turnKeys: Array.from(document.querySelectorAll<HTMLElement>("[data-turn-key]")).flatMap(
          (element) => element.dataset.turnKey ?? [],
        ),
        threadBodyText: threadBody?.innerText.slice(0, 240) ?? "",
      };
      const previous = scope.__newChatTransitionSamples?.at(-1);
      if (
        previous?.composerContainsPrompt === next.composerContainsPrompt &&
        previous.userMessageCount === next.userMessageCount &&
        previous.allUserMessageCount === next.allUserMessageCount &&
        previous.composerLabels.join(":") === next.composerLabels.join(":") &&
        previous.hasNewThreadHome === next.hasNewThreadHome &&
        previous.hasSessionThreadPage === next.hasSessionThreadPage &&
        previous.hasEmptySessionRoute === next.hasEmptySessionRoute &&
        previous.hasThreadShell === next.hasThreadShell &&
        previous.turnKeys.join(":") === next.turnKeys.join(":") &&
        previous.threadBodyText === next.threadBodyText &&
        previous.clientUserMessageIds.join(":") === next.clientUserMessageIds.join(":")
      ) {
        return;
      }
      scope.__newChatTransitionSamples?.push(next);
    };
    const sampleAnimationFrame = () => {
      sample(true);
      scope.__newChatTransitionAnimationFrame = requestAnimationFrame(sampleAnimationFrame);
    };
    sample(false);
    scope.__newChatTransitionAnimationFrame = requestAnimationFrame(sampleAnimationFrame);
    scope.__newChatTransitionObserver = new MutationObserver(() => sample(false));
    scope.__newChatTransitionObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }, prompt);
};

const markTransitionSubmitted = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __newChatTransitionSubmittedAtMs?: number | null;
    };
    scope.__newChatTransitionSubmittedAtMs = performance.now();
  });
};

const readTransitionCapture = async (page: Page): Promise<NewChatTransitionCapture> =>
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __newChatTransitionObserver?: MutationObserver;
      __newChatTransitionAnimationFrame?: number;
      __newChatTransitionSamples?: NewChatTransitionSample[];
      __newChatTransitionSubmittedAtMs?: number | null;
      __newChatFirstUserMessageAtMs?: number | null;
      __newChatThreadSurfaceAtMs?: number | null;
      __newChatBlankFrameCount?: number;
      __newChatDuplicateFrameCount?: number;
      __newChatHomeAndUserMessageFrameCount?: number;
    };
    scope.__newChatTransitionObserver?.disconnect();
    if (scope.__newChatTransitionAnimationFrame !== undefined) {
      cancelAnimationFrame(scope.__newChatTransitionAnimationFrame);
    }
    const submittedAtMs = scope.__newChatTransitionSubmittedAtMs;
    const firstUserMessageAtMs = scope.__newChatFirstUserMessageAtMs;
    const threadSurfaceAtMs = scope.__newChatThreadSurfaceAtMs;
    return {
      samples: scope.__newChatTransitionSamples ?? [],
      blankFrameCount: scope.__newChatBlankFrameCount ?? 0,
      duplicateFrameCount: scope.__newChatDuplicateFrameCount ?? 0,
      homeAndUserMessageFrameCount: scope.__newChatHomeAndUserMessageFrameCount ?? 0,
      submitToFirstVisibleUserMessageMs:
        submittedAtMs !== null &&
        submittedAtMs !== undefined &&
        firstUserMessageAtMs !== null &&
        firstUserMessageAtMs !== undefined
          ? firstUserMessageAtMs - submittedAtMs
          : null,
      submitToThreadSurfaceMs:
        submittedAtMs !== null &&
        submittedAtMs !== undefined &&
        threadSurfaceAtMs !== null &&
        threadSurfaceAtMs !== undefined
          ? threadSurfaceAtMs - submittedAtMs
          : null,
    };
  });

interface RpcEntry {
  readonly atMs: number;
  readonly processInstanceOrdinal?: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface ScenarioState {
  readonly appServerInstances?: ReadonlyArray<{
    readonly ordinal: number;
    readonly pid: number;
  }>;
}

const readRpcEntries = (logPath: string): RpcEntry[] => {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcEntry);
};

const readThreadStartParams = (logPath: string): Record<string, unknown> | null => {
  const entry = readRpcEntries(logPath).find((candidate) => candidate.method === "thread/start");
  return entry?.params ?? null;
};

const readScenarioState = (statePath: string): ScenarioState =>
  JSON.parse(fs.readFileSync(statePath, "utf8")) as ScenarioState;

const configureAcpFixture = async (page: Page, harness: ElectronScenarioHarness): Promise<void> => {
  await page.evaluate(
    async ({ packageRoot, nodeExecutable, credentialHome }) => {
      await window.api?.invoke("settings:acp-agents:update", {
        instances: [
          {
            id: "new-chat-lifecycle-acp",
            agentDefinitionId: "claude-agent-acp",
            packageRoot,
            nodeExecutable,
            enabled: true,
            credentials: { kind: "isolated-home", home: credentialHome },
            proxy: "isolated",
          },
        ],
      });
    },
    {
      packageRoot: repositoryRoot,
      nodeExecutable: process.execPath,
      credentialHome: harness.profile.runRoot,
    },
  );
};

for (const submission of ["keyboard", "pointer"] as const) {
  test(`${submission} submission atomically moves a New Chat draft into its first user message`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const harness = await createHarness(`new-chat-lifecycle-${submission}`, {
      NODEX_FAKE_CODEX_THREAD_START_DELAY_MS: "5000",
    });
    const promptText = `Trace the first-send lifecycle by ${submission}`;

    try {
      const page = await harness.launch();
      await configureAcpFixture(page, harness);
      await page.getByRole("button", { name: "New chat" }).first().click();
      await expect(page.locator("[data-new-thread-backend-selector='true']")).toBeVisible();

      const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
      await expect(composer).toBeVisible();
      await composer.fill(promptText);
      await expect(composer).toHaveText(promptText);
      await beginTransitionCapture(page, promptText);
      await markTransitionSubmitted(page);

      if (submission === "keyboard") {
        await composer.press("Enter");
      } else {
        await page.getByRole("button", { name: "Send prompt" }).click();
      }

      const userMessage = page.locator("[data-user-message-bubble='true']", {
        hasText: promptText,
      });
      await expect(userMessage).toBeVisible({ timeout: 30_000 });
      const activeComposer = page.locator("[data-codex-composer='true']").first();
      await expect(activeComposer).toHaveText("");

      const rpcLogPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
      await expect
        .poll(() => readThreadStartParams(rpcLogPath))
        .toMatchObject({
          historyMode: "paginated",
        });
      await expect
        .poll(() => readRpcEntries(rpcLogPath).some((entry) => entry.method === "turn/start"), {
          timeout: 30_000,
        })
        .toBe(true);
      const capture = await readTransitionCapture(page);
      await testInfo.attach("new-chat-transition.json", {
        body: Buffer.from(JSON.stringify(capture, null, 2)),
        contentType: "application/json",
      });
      expect(capture.submitToFirstVisibleUserMessageMs).not.toBeNull();
      expect(capture.submitToFirstVisibleUserMessageMs!).toBeLessThan(250);
      expect(capture.submitToThreadSurfaceMs).not.toBeNull();
      expect(capture.submitToThreadSurfaceMs!).toBeLessThan(250);
      expect(capture.blankFrameCount, JSON.stringify(capture, null, 2)).toBe(0);
      expect(capture.duplicateFrameCount).toBe(0);
      expect(capture.homeAndUserMessageFrameCount, JSON.stringify(capture, null, 2)).toBe(0);
      expect(capture.samples.at(-1)?.userMessageCount).toBe(1);
      expect(capture.samples.at(-1)?.clientUserMessageIds).toHaveLength(1);
      const firstVisibleUserMessage = capture.samples.find((sample) => sample.userMessageCount > 0);
      expect(firstVisibleUserMessage?.hasNewThreadHome).toBe(false);
      expect(firstVisibleUserMessage?.hasThreadShell).toBe(true);

      const rpcEntries = readRpcEntries(rpcLogPath);
      const threadStart = rpcEntries.find((entry) => entry.method === "thread/start");
      const turnStart = rpcEntries.find((entry) => entry.method === "turn/start");
      expect(threadStart).toBeDefined();
      expect(turnStart).toBeDefined();
      expect(turnStart!.atMs - threadStart!.atMs).toBeGreaterThanOrEqual(4_900);
      const runtimeLogs = await readBoundedElectronRuntimeLogs(harness.profile, 256_000);
      expect(runtimeLogs).not.toContain("codex:thread:prompt-rail:index");
      expect(runtimeLogs).not.toContain("Prompt rail history requires paginated Thread storage");
    } finally {
      await harness.close();
    }
  });
}

test("an unversioned host may prove a durable paginated start without enabling optional history", async () => {
  test.setTimeout(120_000);
  const harness = await createHarness("new-chat-unversioned-history", {
    NODEX_FAKE_CODEX_USER_AGENT: "codex-app-server/0.0.0",
  });
  const promptText = "Accept the concrete paginated Thread contract";

  try {
    const page = await harness.launch();
    await configureAcpFixture(page, harness);
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator("[data-new-thread-backend-selector='true']")).toBeVisible();
    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await expect(composer).toBeVisible();
    await composer.fill(promptText);
    await composer.press("Enter");
    await expect(
      page.locator("[data-user-message-bubble='true']", { hasText: promptText }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-codex-composer='true']").first()).toHaveText("");

    const rpcLogPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    await expect
      .poll(
        () => {
          const value = readRpcEntries(rpcLogPath).find((entry) => entry.method === "turn/start")
            ?.params.threadId;
          return typeof value === "string" ? value : null;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const rawThreadId = readRpcEntries(rpcLogPath).find((entry) => entry.method === "turn/start")
      ?.params.threadId;
    if (typeof rawThreadId !== "string") throw new Error("turn/start did not identify its Thread");

    const beforeOptionalReads = readRpcEntries(rpcLogPath);
    const outcome = await page.evaluate(async (threadId) => {
      const snapshot = (await window.api?.invoke("codex:thread:snapshot:request", threadId)) as {
        historyTopologyGeneration: number;
      };
      return {
        index: await window.api?.invoke("codex:thread:prompt-rail:index", {
          requestId: "unversioned-index",
          threadId,
          expectedTopologyGeneration: snapshot.historyTopologyGeneration,
        }),
        search: await window.api?.invoke("codex:thread:history-search", threadId, "concrete"),
      };
    }, rawThreadId);
    expect(outcome).toMatchObject({
      index: {
        status: "unavailable",
        availability: { feature: "prompt-rail", reason: "capability-unproven" },
      },
      search: {
        status: "unavailable",
        feature: "persisted-search",
        reason: "capability-unproven",
      },
    });

    const afterOptionalReads = readRpcEntries(rpcLogPath);
    const addedCalls = (method: string): RpcEntry[] => {
      const belongsToThread = (entry: RpcEntry): boolean =>
        entry.method === method && entry.params.threadId === rawThreadId;
      const previousCount = beforeOptionalReads.filter(belongsToThread).length;
      return afterOptionalReads.filter(belongsToThread).slice(previousCount);
    };
    expect(addedCalls("thread/turns/list")).toEqual([]);
    expect(addedCalls("thread/searchOccurrences")).toEqual([]);
    const runtimeLogs = await readBoundedElectronRuntimeLogs(harness.profile, 256_000);
    expect(runtimeLogs).not.toContain(
      "New durable Threads require proven paginated history support",
    );
    expect(runtimeLogs).not.toContain("Electron IPC handler failed");
  } finally {
    await harness.close();
  }
});

test("reconnect capability downgrades keep optional history resident-only without IPC errors", async () => {
  test.setTimeout(120_000);
  const harness = await createHarness("new-chat-history-capability-reconnect", {
    NODEX_FAKE_CODEX_RECONNECT_USER_AGENT: "codex-app-server/0.144.0",
  });
  const promptText = "Keep this resident message across reconnect";

  try {
    const page = await harness.launch();
    await configureAcpFixture(page, harness);
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator("[data-new-thread-backend-selector='true']")).toBeVisible();
    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await expect(composer).toBeVisible();
    await composer.fill(promptText);
    await composer.press("Enter");
    await expect(
      page.locator("[data-user-message-bubble='true']", { hasText: promptText }),
    ).toBeVisible({ timeout: 30_000 });

    const rpcLogPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const statePath = path.join(harness.profile.runRoot, ".fake-codex", "state.json");
    await expect
      .poll(
        () => {
          const value = readRpcEntries(rpcLogPath).find((entry) => entry.method === "turn/start")
            ?.params.threadId;
          return typeof value === "string" ? value : null;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const rawThreadId = readRpcEntries(rpcLogPath).find((entry) => entry.method === "turn/start")
      ?.params.threadId;
    if (typeof rawThreadId !== "string") throw new Error("turn/start did not identify its Thread");
    const threadId = rawThreadId;

    const firstInstance = readScenarioState(statePath).appServerInstances?.[0];
    expect(firstInstance?.ordinal).toBe(1);
    process.kill(firstInstance!.pid, "SIGKILL");
    await expect
      .poll(() => readScenarioState(statePath).appServerInstances?.length ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);
    const secondInstance = readScenarioState(statePath).appServerInstances?.at(-1);
    await expect
      .poll(
        () =>
          readRpcEntries(rpcLogPath).some(
            (entry) =>
              entry.processInstanceOrdinal === secondInstance?.ordinal &&
              entry.method === "initialize",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const connection = (await window.api?.invoke("codex:connection:status")) as {
              status?: string;
            };
            return connection.status;
          }),
        { timeout: 30_000 },
      )
      .toBe("connected");

    const beforeOptionalReads = readRpcEntries(rpcLogPath);
    const outcome = await page.evaluate(async (expectedThreadId) => {
      const snapshot = (await window.api?.invoke(
        "codex:thread:snapshot:request",
        expectedThreadId,
      )) as { historyTopologyGeneration: number };
      return {
        index: await window.api?.invoke("codex:thread:prompt-rail:index", {
          requestId: "reconnect-index",
          threadId: expectedThreadId,
          expectedTopologyGeneration: snapshot.historyTopologyGeneration,
        }),
        search: await window.api?.invoke(
          "codex:thread:history-search",
          expectedThreadId,
          "resident",
        ),
      };
    }, threadId);
    expect(outcome).toMatchObject({
      index: {
        status: "unavailable",
        availability: { feature: "prompt-rail", reason: "host-unsupported" },
      },
      search: {
        status: "unavailable",
        feature: "persisted-search",
        reason: "host-unsupported",
      },
    });
    await expect(
      page.locator("[data-user-message-bubble='true']", { hasText: promptText }),
    ).toBeVisible();

    const afterOptionalReads = readRpcEntries(rpcLogPath);
    const addedCalls = (method: string): RpcEntry[] => {
      const belongsToReplacement = (entry: RpcEntry): boolean =>
        entry.processInstanceOrdinal === secondInstance?.ordinal &&
        entry.method === method &&
        entry.params.threadId === threadId;
      const previousCount = beforeOptionalReads.filter(belongsToReplacement).length;
      return afterOptionalReads.filter(belongsToReplacement).slice(previousCount);
    };
    expect(addedCalls("thread/turns/list")).toEqual([]);
    expect(addedCalls("thread/searchOccurrences")).toEqual([]);
    const runtimeLogs = await readBoundedElectronRuntimeLogs(harness.profile, 256_000);
    expect(runtimeLogs).not.toContain("Electron IPC handler failed");
    expect(runtimeLogs).not.toContain("Prompt rail history requires paginated Thread storage");
  } finally {
    await harness.close();
  }
});
