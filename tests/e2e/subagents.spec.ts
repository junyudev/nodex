import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { CodexConversationSnapshot, CodexHostMessage } from "../../src/shared/types";
import { attachComposerFailureEvidence } from "./support/composer-failure-evidence";
import { openNewChatDraft } from "./support/new-chat-draft";

const repositoryRoot = process.cwd();
const scenarioThreadTimestampHex = Date.now().toString(16).padStart(12, "0");
const scenarioThreadId = (suffix: string): string =>
  `${scenarioThreadTimestampHex.slice(0, 8)}-${scenarioThreadTimestampHex.slice(8)}-7000-8000-${suffix}`;
const rootThreadId = scenarioThreadId("000000000101");
const fallbackInterruptThreadId = scenarioThreadId("000000000201");
const selectedThreadId = scenarioThreadId("000000000202");
const reconnectScoutThreadId = scenarioThreadId("000000000204");
const childThreadIds = new Set([
  ...Array.from({ length: 5 }, (_, index) =>
    scenarioThreadId(String(201 + index).padStart(12, "0")),
  ),
  ...Array.from({ length: 12 }, (_, index) =>
    scenarioThreadId(String(301 + index).padStart(12, "0")),
  ),
]);
const transcriptMethods = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
]);

interface RpcEntry {
  readonly atMs: number;
  readonly processInstanceOrdinal?: number;
  readonly processPid?: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface ScenarioState {
  readonly activeNotificationChildIds?: readonly string[];
  readonly appServerInstances?: ReadonlyArray<{
    readonly ordinal: number;
    readonly pid: number;
    readonly startedAtMs: number;
  }>;
  readonly childIdleNotificationAtMs?: number;
  readonly childInterruptAcceptedAtMs?: number;
  readonly discoveryListStartedAtMs?: number;
  readonly discoveryListRespondedAtMs?: number | null;
  readonly lastDiscoveryThreadIds?: readonly string[];
  readonly reconnectNotificationAtMs?: number;
  readonly reconnectNotificationInstances?: readonly number[];
  readonly reconnectReadRespondedAtMs?: number | null;
  readonly reconnectReadStartedAtMs?: number;
  readonly rootCompletedAtMs?: number | null;
  readonly rootTurnStartedAtMs?: number;
  readonly selectedDeletedAtMs?: number;
  readonly spawnNotificationThreadIds?: readonly string[];
}

interface CapturedCodexEvent {
  readonly observedAtMs: number;
  readonly event: Record<string, unknown>;
}

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

const prepareSubagentDraft = async (page: Page, prompt: string): Promise<Locator> => {
  const scene = await openNewChatDraft(page);
  const composer = scene.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  const sendButton = scene.getByRole("button", { name: "Send prompt" });
  try {
    await expect(composer).toBeVisible();
    await composer.fill(prompt);
    await expect(composer).toHaveText(prompt);
    await expect(sendButton).toBeEnabled();
  } catch (error) {
    await attachComposerFailureEvidence(page, test.info());
    throw error;
  }
  return sendButton;
};

const startSubagentScenario = async (harness: ElectronScenarioHarness): Promise<Page> => {
  const page = await harness.launch();
  const diagnosticsPath = test.info().outputPath("scenario-runtime.log");
  fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
  fs.writeFileSync(diagnosticsPath, `Disposable Profile: ${harness.profile.runRoot}\n`);
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      fs.appendFileSync(diagnosticsPath, `${message.type()}: ${message.text()}\n`);
    }
  });
  page.on("pageerror", (error) =>
    fs.appendFileSync(diagnosticsPath, `${error.stack ?? error.message}\n`),
  );
  harness.application
    .process()
    .stderr?.on("data", (chunk) => fs.appendFileSync(diagnosticsPath, chunk));
  const sendButton = await prepareSubagentDraft(page, "Coordinate the bounded subagent scenario");
  await beginCodexEventCapture(page);
  await sendButton.click();
  await expect(page.getByRole("button", { name: "Open subagents" }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => capturedRootInvalidationCount(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  return page;
};

const readRpcEntries = (logPath: string): RpcEntry[] =>
  fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcEntry);

const readScenarioState = (statePath: string): ScenarioState =>
  JSON.parse(fs.readFileSync(statePath, "utf8")) as ScenarioState;

const isBoundedTopologyRequest = (entry: RpcEntry): boolean =>
  entry.method === "thread/turns/list" &&
  entry.params.limit === 5 &&
  entry.params.sortDirection === "asc" &&
  entry.params.itemsView === "full";

const isChildTranscriptRequest = (entry: RpcEntry): boolean => {
  if (!transcriptMethods.has(entry.method)) return false;
  const threadId = entry.params.threadId;
  if (typeof threadId !== "string" || !childThreadIds.has(threadId)) return false;
  if (isBoundedTopologyRequest(entry)) return false;
  return entry.method !== "thread/read" || entry.params.includeTurns !== false;
};

const attachRequestEvidence = async (
  testInfo: TestInfo,
  name: string,
  entries: readonly RpcEntry[],
): Promise<void> => {
  const body = JSON.stringify(
    {
      rpcCount: entries.length,
      wireBytes: Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join("\n")),
      byMethod: Object.fromEntries(
        [...new Set(entries.map((entry) => entry.method))]
          .sort()
          .map((method) => [method, entries.filter((entry) => entry.method === method).length]),
      ),
    },
    null,
    2,
  );
  await testInfo.attach(name, { body, contentType: "application/json" });
};

const beginCodexEventCapture = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __subagentScenarioCodexEvents?: unknown[];
      __subagentScenarioHostMessages?: CodexHostMessage[];
      __stopSubagentScenarioCodexEvents?: () => void;
    };
    scope.__stopSubagentScenarioCodexEvents?.();
    scope.__subagentScenarioCodexEvents = [];
    scope.__subagentScenarioHostMessages = [];
    const stopEvents = window.api?.on("codex:event", (event: unknown) => {
      scope.__subagentScenarioCodexEvents?.push({ observedAtMs: Date.now(), event });
    });
    const stopHostMessages = window.api?.on("codex:host-message", (message) => {
      scope.__subagentScenarioHostMessages?.push(message as CodexHostMessage);
    });
    scope.__stopSubagentScenarioCodexEvents = () => {
      stopEvents?.();
      stopHostMessages?.();
    };
  });
};

const capturedCodexEvents = async (page: Page): Promise<CapturedCodexEvent[]> =>
  await page.evaluate(() => {
    const scope = window as typeof window & { __subagentScenarioCodexEvents?: unknown[] };
    return (scope.__subagentScenarioCodexEvents ?? []) as CapturedCodexEvent[];
  });

const capturedRootInvalidationCount = async (page: Page): Promise<number> =>
  await page.evaluate((expectedRootThreadId) => {
    const scope = window as typeof window & { __subagentScenarioCodexEvents?: unknown[] };
    return (scope.__subagentScenarioCodexEvents ?? []).filter((entry) => {
      if (typeof entry !== "object" || entry === null || !("event" in entry)) return false;
      const candidate = (entry as { event?: unknown }).event;
      if (typeof candidate !== "object" || candidate === null) return false;
      const event = candidate as { type?: unknown; rootThreadId?: unknown };
      return (
        event.type === "subagentOverviewInvalidated" && event.rootThreadId === expectedRootThreadId
      );
    }).length;
  }, rootThreadId);

const captureSubagentPresentationDiagnostics = async (page: Page) =>
  await page.evaluate(async (rootId) => {
    const snapshot = (await window.api?.invoke("codex:thread:snapshot:request", rootId)) as
      | CodexConversationSnapshot
      | null
      | undefined;
    const elements = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          attributes: Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          text: element.textContent?.slice(0, 100),
        };
      });
    return {
      rootSnapshot: snapshot
        ? {
            threadId: snapshot.threadId,
            source: snapshot.source,
            archived: snapshot.archived,
            resumeState: snapshot.resumeState,
          }
        : null,
      composers: elements("[data-codex-composer]"),
      shells: elements("[data-local-conversation-composer-shell]"),
      footers: elements("[data-thread-find-composer]"),
      overlays: elements(
        "[data-right-panel-composer-overlay], [data-above-composer-queue-portal], [data-above-composer-portal]",
      ),
      panels: elements("[data-background-agent-side-panel-tab], [data-subagents-side-panel-tab]"),
    };
  }, rootThreadId);

test("renders compact subagent activity, expands the overview, and reads only the selected child", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-overview-and-selected-hydration", {
    NODEX_LOG_FILE: "1",
    NODEX_LOG_FILE_LEVEL: "debug",
    NODEX_FAKE_SUBAGENT_ACTIVITY: "1",
  });
  const artifactDirectory =
    process.env.NODEX_SUBAGENT_UI_ARTIFACT_DIR ?? testInfo.outputPath("ui-review");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.rmSync(path.join(artifactDirectory, "result.json"), { force: true });
  let recordingPage: Page | null = null;
  try {
    const page = await startSubagentScenario(harness);
    await page.setViewportSize({ width: 1440, height: 960 });
    const logPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const activity = page.getByTestId("subagent-activity-inline-group").first();
    await expect(activity).toBeVisible();
    await expect(activity.locator("[data-subagent-avatar-seed]")).toHaveCount(4);
    await expect(activity).toContainText("and 2 more");
    const portal = page.locator(
      `[data-above-composer-queue-portal="true"][data-above-composer-conversation-id="${rootThreadId}"]`,
    );
    await expect(portal.getByRole("button", { name: "Open subagents" })).toHaveCount(0);
    await expect(portal.getByRole("button", { name: "Stop all" })).toHaveCount(0);
    await page.screencast.start({
      path: path.join(artifactDirectory, "review.webm"),
      size: { width: 1440, height: 960 },
      annotate: { position: "bottom", fontSize: 14 },
    });
    recordingPage = page;
    await page.screenshot({ path: path.join(artifactDirectory, "root-activity.png") });
    await page.getByRole("button", { name: "Open subagents" }).first().click();
    const panel = page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`);
    const active = panel.locator('[data-subagent-overview-section="active"]');
    const done = panel.locator('[data-subagent-overview-section="done"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(active.getByRole("heading", { name: "Active · 4" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(done.getByRole("heading", { name: "Done · 13" })).toBeVisible();
    await expect(active.locator('[aria-label^="Open subagent "]')).toHaveCount(4);
    await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(10);
    await expect(active.getByText("Approval sentinel", { exact: true })).toBeVisible();
    await expect(active.getByText("Waiting", { exact: true })).toHaveCount(0);
    await expect(done.getByText("Reconnect scout", { exact: true })).toBeVisible();
    expect(readRpcEntries(logPath).filter(isChildTranscriptRequest)).toEqual([]);
    await done.getByRole("button", { name: "Show more" }).click();
    await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(13);
    expect(readRpcEntries(logPath).filter(isChildTranscriptRequest)).toEqual([]);
    await page.screenshot({ path: path.join(artifactDirectory, "overview-expanded.png") });
    await done.getByRole("button", { name: "Show less" }).click();
    await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(10);
    const rootHistoryRequestsBefore = readRpcEntries(logPath).filter(
      (entry) => transcriptMethods.has(entry.method) && entry.params.threadId === rootThreadId,
    ).length;
    await expect(page.locator('[data-codex-composer="true"]')).toHaveCount(1);
    const beforeSelection = await captureSubagentPresentationDiagnostics(page);
    await active.getByRole("button", { name: "Open subagent Deep investigator" }).click();
    const sidePanel = page.locator('[data-subagents-side-panel-tab^="subagents:"]');
    await expect(sidePanel).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    await expect(sidePanel.locator('[data-codex-composer="true"]')).toHaveCount(0);
    await expect(
      sidePanel.getByText("Checking the selected child history.", { exact: true }),
    ).toBeVisible();
    await expect(sidePanel.getByText("GPT-5.5 · High", { exact: true })).toBeVisible();
    const selectedEntries = readRpcEntries(logPath).filter(isChildTranscriptRequest);
    expect([...new Set(selectedEntries.map((entry) => entry.params.threadId))]).toEqual([
      selectedThreadId,
    ]);
    expect(selectedEntries.filter((entry) => entry.method === "thread/resume")).toEqual([]);
    const afterSelection = await captureSubagentPresentationDiagnostics(page);
    fs.writeFileSync(
      path.join(artifactDirectory, "composer-diagnostics.json"),
      JSON.stringify({ beforeSelection, afterSelection }, null, 2),
    );
    await page.screenshot({ path: path.join(artifactDirectory, "final.png") });
    await expect(page.locator('[data-codex-composer="true"]')).toHaveCount(1);
    await expect(page.locator('[data-codex-composer="true"]')).toBeVisible();
    expect(
      readRpcEntries(logPath).filter(
        (entry) => transcriptMethods.has(entry.method) && entry.params.threadId === rootThreadId,
      ).length,
    ).toBe(rootHistoryRequestsBefore);
    const result = {
      status: "passed",
      scenario: "codex-subagent-app-server.mjs",
      profile: harness.profile.runId,
      assertions: [
        {
          claim: "root composers after read-only child selection",
          expected: 1,
          actual: await page.locator('[data-codex-composer="true"]').count(),
        },
        {
          claim: "inline avatars",
          expected: 4,
          actual: await activity.locator("[data-subagent-avatar-seed]").count(),
        },
        {
          claim: "portal subagent controls",
          expected: 0,
          actual: await portal.getByRole("button", { name: /Open subagents|Stop all/u }).count(),
        },
        {
          claim: "selected child composers",
          expected: 0,
          actual: await sidePanel.locator('[data-codex-composer="true"]').count(),
        },
        {
          claim: "child transcript targets",
          expected: [selectedThreadId],
          actual: [...new Set(selectedEntries.map((entry) => entry.params.threadId))],
        },
        {
          claim: "child execution resumes",
          expected: 0,
          actual: selectedEntries.filter((entry) => entry.method === "thread/resume").length,
        },
      ],
    };
    fs.writeFileSync(path.join(artifactDirectory, "result.json"), JSON.stringify(result, null, 2));
    await testInfo.attach("subagent-ui-result", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    await attachRequestEvidence(testInfo, "selected-only-hydration-rpcs", selectedEntries);
    await sidePanel.getByRole("button", { name: "Back to subagents" }).click();
    await expect(panel).toBeVisible();
    fs.copyFileSync(
      testInfo.outputPath("scenario-runtime.log"),
      path.join(artifactDirectory, "scenario-runtime.log"),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDirectory, "result.json"),
      JSON.stringify(
        {
          status: "failed",
          scenario: "codex-subagent-app-server.mjs",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (recordingPage) await recordingPage.screencast.stop();
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
    await page.getByRole("button", { name: "Toggle summary" }).click();
    const summary = page.locator('[data-thread-summary-panel-mode="popover"]');
    await expect(summary).toBeVisible();
    await summary.getByRole("button", { name: "Open subagents" }).click();

    const panel = page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("heading", { name: "Active · 5" })).toBeVisible();
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

test("returns to the overview when the selected Subagent is deleted remotely", async () => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-selected-delete-authority", {
    // Fire after the selected detail has mounted its lifecycle subscription. This
    // models an actual remote delete instead of racing the detail hydration RPC.
    NODEX_FAKE_SUBAGENT_DELETE_SELECTED_MS: "2000",
  });

  try {
    const page = await startSubagentScenario(harness);
    const statePath = path.join(harness.profile.runRoot, ".fake-codex", "state.json");
    await page.getByRole("button", { name: "Open subagents" }).first().click();
    const overview = page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`);
    await expect(overview).toBeVisible({ timeout: 30_000 });
    await overview.getByRole("button", { name: "Open subagent Deep investigator" }).click();

    const selected = page.locator(
      '[data-subagents-side-panel-tab^="subagents:"][data-subagents-selected-hydration="ready"]',
    );
    await expect(selected).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    await expect
      .poll(() => readScenarioState(statePath).selectedDeletedAtMs)
      .toEqual(expect.any(Number));
    await expect
      .poll(
        async () =>
          (await capturedCodexEvents(page)).some(
            ({ event }) => event.type === "threadDeleted" && event.threadId === selectedThreadId,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(selected).toHaveCount(0, { timeout: 15_000 });
    await expect(overview).toBeVisible();
    await expect(
      overview
        .locator('[data-subagent-overview-section="active"]')
        .getByRole("heading", { name: "Active · 3" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      overview.getByRole("button", { name: "Open subagent Deep investigator" }),
    ).toHaveCount(0);

    const events = await capturedCodexEvents(page);
    expect(
      events.some(
        ({ event }) => event.type === "threadDeleted" && event.threadId === selectedThreadId,
      ),
    ).toBe(true);
    expect(
      events.some(
        ({ event }) =>
          event.type === "subagentOverviewInvalidated" && event.rootThreadId === rootThreadId,
      ),
    ).toBe(true);
  } finally {
    await harness.close();
  }
});

test("keeps later root notifications moving while panel-closed metadata discovery is stalled", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-panel-closed-root-completion", {
    NODEX_FAKE_SUBAGENT_AUTO_COMPLETE_ROOT_MS: "1800",
    NODEX_FAKE_SUBAGENT_DISCOVERY_LIST_DELAY_MS: "10000",
  });

  try {
    const page = await harness.launch();
    const logPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const statePath = path.join(harness.profile.runRoot, ".fake-codex", "state.json");
    const sendButton = await prepareSubagentDraft(
      page,
      "Complete without opening the subagent panel",
    );
    await beginCodexEventCapture(page);

    const observedStartMs = Date.now();
    await sendButton.click();
    // The compact strip waits for discovery too, so it is not a readiness signal in this case.
    await expect
      .poll(() => readScenarioState(statePath).rootTurnStartedAtMs, { timeout: 5_000 })
      .toEqual(expect.any(Number));
    await expect
      .poll(() => readScenarioState(statePath).discoveryListStartedAtMs, { timeout: 5_000 })
      .toEqual(expect.any(Number));
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(
      page.locator('[data-codex-composer="true"][aria-label="Do anything"]'),
    ).toBeVisible();
    await expect(page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`)).toHaveCount(0);

    // Completion must read the known overview without joining the stalled native discovery.
    await expect
      .poll(
        async () =>
          (await capturedCodexEvents(page)).some(
            ({ event }) =>
              event.type === "threadStatus" &&
              event.threadId === rootThreadId &&
              event.statusType === "idle",
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
    const rootIdleEvent = (await capturedCodexEvents(page)).find(
      ({ event }) =>
        event.type === "threadStatus" &&
        event.threadId === rootThreadId &&
        event.statusType === "idle",
    );
    expect(rootIdleEvent).toBeDefined();
    const rendererTerminalLatencyMs =
      (rootIdleEvent?.observedAtMs ?? Number.POSITIVE_INFINITY) - observedStartMs;
    expect(rendererTerminalLatencyMs).toBeLessThanOrEqual(5_000);

    await expect
      .poll(() => readScenarioState(statePath).rootCompletedAtMs, { timeout: 5_000 })
      .toEqual(expect.any(Number));
    const state = readScenarioState(statePath);
    const fixtureCompletionLatencyMs =
      (state.rootCompletedAtMs ?? Number.POSITIVE_INFINITY) - (state.rootTurnStartedAtMs ?? 0);
    expect(fixtureCompletionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(fixtureCompletionLatencyMs).toBeLessThanOrEqual(5_000);
    expect(state.discoveryListStartedAtMs).toEqual(expect.any(Number));
    expect(state.discoveryListRespondedAtMs).toBeNull();
    expect(rootIdleEvent!.observedAtMs).toBeGreaterThanOrEqual(state.discoveryListStartedAtMs!);
    const notificationLaneLatencyMs =
      (rootIdleEvent?.observedAtMs ?? Number.POSITIVE_INFINITY) - (state.rootCompletedAtMs ?? 0);
    expect(notificationLaneLatencyMs).toBeGreaterThanOrEqual(0);
    expect(notificationLaneLatencyMs).toBeLessThanOrEqual(5_000);

    const entries = readRpcEntries(logPath);
    const descendantDiscoveryRequests = entries.filter(
      (entry) => entry.method === "thread/list" && entry.params.ancestorThreadId === rootThreadId,
    );
    // Fallback is considered only after a terminal first page identifies a missing spawn.
    // The first page is still pending here, and concurrent callers must share that one scan.
    expect(descendantDiscoveryRequests.map((entry) => entry.params.useStateDbOnly)).toEqual([true]);
    expect(entries.filter(isChildTranscriptRequest)).toEqual([]);
    await testInfo.attach("panel-closed-root-completion", {
      body: JSON.stringify(
        {
          rendererTerminalLatencyMs,
          fixtureCompletionLatencyMs,
          notificationLaneLatencyMs,
          discoveryListStartedAtMs: state.discoveryListStartedAtMs,
          discoveryListRespondedAtMs: state.discoveryListRespondedAtMs,
          descendantDiscoveryRpcCount: descendantDiscoveryRequests.length,
          childTranscriptRpcCount: entries.filter(isChildTranscriptRequest).length,
          rpcCount: entries.length,
          wireBytes: Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join("\n")),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await harness.close();
  }
});

test("stops the root, interrupts remaining active children once, and updates from notifications", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-root-stop-convergence", {
    NODEX_LOG_FILE: "1",
    NODEX_FAKE_SUBAGENT_SCOUT_ACTIVE: "1",
    NODEX_LOG_FILE_LEVEL: "debug",
  });

  try {
    const page = await startSubagentScenario(harness);
    const logPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const statePath = path.join(harness.profile.runRoot, ".fake-codex", "state.json");
    await page.getByRole("button", { name: "Open subagents" }).first().click();

    const panel = page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`);
    const active = panel.locator('[data-subagent-overview-section="active"]');
    const done = panel.locator('[data-subagent-overview-section="done"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(active.getByRole("heading", { name: "Active · 5" })).toBeVisible();
    await expect(done.getByRole("heading", { name: "Done · 12" })).toBeVisible();
    expect(readScenarioState(statePath).activeNotificationChildIds).toContain(
      fallbackInterruptThreadId,
    );
    await beginCodexEventCapture(page);
    const invalidationsBeforeStop = await capturedRootInvalidationCount(page);
    const rendererClientIdBeforeStop = await page.evaluate(
      async () => await window.api?.invoke("codex:renderer-client:id"),
    );

    const rootComposer = page.locator('[data-codex-composer="true"]').first();
    await rootComposer.click();
    await rootComposer.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await rootComposer.press("Backspace");
    const stopButton = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stopButton).toBeVisible();
    const requestsBeforeStop = readRpcEntries(logPath).length;
    await stopButton.click();

    await expect
      .poll(
        () =>
          readRpcEntries(logPath).filter(
            (entry) =>
              entry.method === "turn/interrupt" &&
              entry.params.threadId === fallbackInterruptThreadId,
          ).length,
        { timeout: 15_000 },
      )
      .toBe(1);

    const entriesAtFallback = readRpcEntries(logPath).slice(requestsBeforeStop);
    const rootInterrupts = entriesAtFallback.filter(
      (entry) => entry.method === "turn/interrupt" && entry.params.threadId === rootThreadId,
    );
    const childSkeletons = entriesAtFallback.filter(
      (entry) =>
        entry.method === "thread/turns/list" &&
        entry.params.itemsView === "notLoaded" &&
        typeof entry.params.threadId === "string" &&
        childThreadIds.has(entry.params.threadId),
    );
    const childInterrupts = entriesAtFallback.filter(
      (entry) =>
        entry.method === "turn/interrupt" &&
        typeof entry.params.threadId === "string" &&
        childThreadIds.has(entry.params.threadId),
    );
    expect(rootInterrupts).toHaveLength(1);
    expect(childSkeletons).toHaveLength(1);
    expect(childSkeletons[0]?.params.threadId).toBe(fallbackInterruptThreadId);
    for (const entry of childSkeletons) {
      expect(entry.params).toMatchObject({
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
    }
    expect(childInterrupts.map((entry) => entry.params.threadId)).toEqual([
      fallbackInterruptThreadId,
    ]);

    const rootInterruptIndex = entriesAtFallback.indexOf(rootInterrupts[0]!);
    const fallbackReadIndex = entriesAtFallback.indexOf(childSkeletons[0]!);
    const fallbackInterruptIndex = entriesAtFallback.indexOf(childInterrupts[0]!);
    expect(rootInterruptIndex).toBeLessThan(fallbackReadIndex);
    expect(fallbackReadIndex).toBeLessThan(fallbackInterruptIndex);
    expect(
      entriesAtFallback
        .slice(rootInterruptIndex + 1, fallbackReadIndex)
        .some(
          (entry) =>
            entry.method === "thread/list" && entry.params.ancestorThreadId === rootThreadId,
        ),
    ).toBe(true);

    const discoveryReadsBeforeInterruptedNotification = entriesAtFallback.filter(
      (entry) => entry.method === "thread/list" && entry.params.ancestorThreadId === rootThreadId,
    ).length;
    await expect
      .poll(() => readScenarioState(statePath).childIdleNotificationAtMs, { timeout: 5_000 })
      .toEqual(expect.any(Number));
    const rendererClientIdAfterStop = await page.evaluate(
      async () => await window.api?.invoke("codex:renderer-client:id"),
    );

    type CanonicalOverview = {
      active?: { rows?: Array<{ threadId?: unknown; status?: unknown }>; knownCount?: unknown };
      done?: {
        rows?: Array<{ threadId?: unknown; status?: unknown }>;
        knownCount?: unknown;
      };
    };
    const readCanonicalOverview = async (): Promise<CanonicalOverview> =>
      await page.evaluate(async (expectedRootThreadId) => {
        return (await window.api?.invoke("codex:subagents:overview:read", {
          rootThreadId: expectedRootThreadId,
          mode: "initial",
        })) as CanonicalOverview;
      }, rootThreadId);
    await expect
      .poll(async () => (await readCanonicalOverview()).active?.knownCount, { timeout: 15_000 })
      .toBe(0);
    const canonicalOverview = await readCanonicalOverview();
    const invalidationsAfterStop = await capturedRootInvalidationCount(page);
    const rootSnapshotAfterStop = await page.evaluate(async (expectedRootThreadId) => {
      return await window.api?.invoke("codex:thread:snapshot:request", expectedRootThreadId);
    }, rootThreadId);
    const codexEventsAfterStop = await capturedCodexEvents(page);
    await testInfo.attach("root-stop-renderer-convergence", {
      body: JSON.stringify(
        {
          rootSnapshotAfterStop,
          codexEventsAfterStop,
          rendererClientIdBeforeStop,
          rendererClientIdAfterStop,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(invalidationsAfterStop).toBeGreaterThan(invalidationsBeforeStop);

    await expect(active.getByRole("heading", { name: "Active · 0" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(active.getByText("No active subagents", { exact: true })).toBeVisible();
    await expect(done.getByRole("heading", { name: "Done · 17" })).toBeVisible();
    expect(canonicalOverview.active?.knownCount).toBe(0);
    expect(canonicalOverview.done?.knownCount).toBe(17);
    expect(canonicalOverview.done?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: fallbackInterruptThreadId, status: "done" }),
      ]),
    );
    await expect(stopButton).toHaveCount(0);
    // The fixture emits interrupted at 500 ms and idle at 650 ms. Cleanup accepts
    // the interruption once; these later notifications update the overview.
    const finalStopRequests = readRpcEntries(logPath).slice(requestsBeforeStop);
    const fallbackSkeletons = finalStopRequests.filter(
      (entry) =>
        entry.method === "thread/turns/list" &&
        entry.params.threadId === fallbackInterruptThreadId &&
        entry.params.itemsView === "notLoaded" &&
        entry.params.limit === 1,
    );
    expect(fallbackSkeletons).toHaveLength(1);
    expect(
      finalStopRequests.filter(
        (entry) =>
          entry.method === "thread/goal/set" && entry.params.threadId === fallbackInterruptThreadId,
      ),
    ).toEqual([]);
    const terminalState = readScenarioState(statePath);
    expect(terminalState.childInterruptAcceptedAtMs).toEqual(expect.any(Number));
    expect(terminalState.childIdleNotificationAtMs).toEqual(expect.any(Number));
    const childTerminalLatencyMs =
      (terminalState.childIdleNotificationAtMs ?? Number.POSITIVE_INFINITY) -
      (terminalState.childInterruptAcceptedAtMs ?? 0);
    expect(childTerminalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(childTerminalLatencyMs).toBeLessThanOrEqual(5_000);

    await testInfo.attach("root-stop-convergence", {
      body: JSON.stringify(
        {
          rootInterrupts,
          childSkeletons,
          childInterrupts,
          invalidationsBeforeStop,
          invalidationsAfterStop,
          discoveryReadsBeforeInterruptedNotification,
          canonicalCounts: {
            active: canonicalOverview.active?.knownCount,
            done: canonicalOverview.done?.knownCount,
          },
          interruptedChildStatus: canonicalOverview.done?.rows?.find(
            (row) => row.threadId === fallbackInterruptThreadId,
          )?.status,
          childTerminalLatencyMs,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } catch (cause) {
    for (const name of ["requests.jsonl", "state.json"]) {
      const evidencePath = path.join(harness.profile.runRoot, ".fake-codex", name);
      if (!fs.existsSync(evidencePath)) continue;
      await testInfo.attach(`root-stop-failure-${name}`, {
        body: fs.readFileSync(evidencePath),
        contentType: name.endsWith("jsonl") ? "application/x-ndjson" : "application/json",
      });
    }
    throw cause;
  } finally {
    await harness.close();
  }
});

test("fences a disconnected app-server generation without flashing an active Subagent as Done", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-app-server-generation-reconnect", {
    NODEX_LOG_FILE: "1",
    NODEX_LOG_FILE_LEVEL: "debug",
    NODEX_FAKE_SUBAGENT_RECONNECT_NOTIFICATION: "1",
    NODEX_FAKE_SUBAGENT_RECONNECT_READ_DELAY_MS: "60000",
  });

  try {
    const page = await startSubagentScenario(harness);
    const logPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const statePath = path.join(harness.profile.runRoot, ".fake-codex", "state.json");
    await page.getByRole("button", { name: "Open subagents" }).first().click();

    const panel = page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`);
    const active = panel.locator('[data-subagent-overview-section="active"]');
    const done = panel.locator('[data-subagent-overview-section="done"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(active.getByRole("heading", { name: "Active · 4" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(active.getByText("Deep investigator", { exact: true })).toBeVisible();

    type OverviewAuthority = {
      readonly generation: number;
      readonly revision: number;
      readonly completeness: "complete" | "incomplete";
      readonly active: {
        readonly knownCount: number;
        readonly rows: ReadonlyArray<{ threadId: string; status: string }>;
      };
      readonly done: {
        readonly knownCount: number;
        readonly rows: ReadonlyArray<{ threadId: string; status: string }>;
      };
    };
    const readOverviewAuthority = async (): Promise<OverviewAuthority | null> =>
      await page.evaluate(async (expectedRootThreadId) => {
        try {
          return (await window.api?.invoke("codex:subagents:overview:read", {
            rootThreadId: expectedRootThreadId,
            mode: "expanded",
          })) as OverviewAuthority;
        } catch {
          return null;
        }
      }, rootThreadId);

    const initialAuthority = await readOverviewAuthority();
    expect(initialAuthority).not.toBeNull();
    expect(initialAuthority?.active.knownCount).toBe(4);
    expect(initialAuthority?.done.knownCount).toBe(13);
    expect(initialAuthority?.done.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: reconnectScoutThreadId, status: "done" }),
      ]),
    );
    expect(initialAuthority?.active.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: selectedThreadId, status: "active" }),
      ]),
    );
    const invalidationsBeforeDisconnect = await capturedRootInvalidationCount(page);

    await page.evaluate((selectedName) => {
      const scope = window as typeof window & {
        __stopSubagentReconnectObserver?: () => void;
        __subagentReconnectObservations?: Array<Record<string, unknown>>;
      };
      scope.__stopSubagentReconnectObserver?.();
      scope.__subagentReconnectObservations = [];
      const sample = () => {
        const overview = document.querySelector<HTMLElement>("[data-subagents-panel-overview]");
        const activeSection = overview?.querySelector<HTMLElement>(
          '[data-subagent-overview-section="active"]',
        );
        const doneSection = overview?.querySelector<HTMLElement>(
          '[data-subagent-overview-section="done"]',
        );
        scope.__subagentReconnectObservations?.push({
          atMs: Date.now(),
          revision: overview?.dataset.subagentsOverviewRevision ?? null,
          activeHeading: activeSection?.querySelector("h2")?.textContent ?? null,
          doneHeading: doneSection?.querySelector("h2")?.textContent ?? null,
          selectedInActive: activeSection?.textContent?.includes(selectedName) ?? false,
          selectedInDone: doneSection?.textContent?.includes(selectedName) ?? false,
        });
      };
      sample();
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      scope.__stopSubagentReconnectObserver = () => observer.disconnect();
    }, "Deep investigator");

    await page.evaluate(
      ({ expectedRootThreadId, expectedSelectedThreadId }) => {
        const scope = window as typeof window & {
          __staleSubagentHydration?: {
            settled: boolean;
            result?: unknown;
            error?: string;
          };
        };
        scope.__staleSubagentHydration = { settled: false };
        void window.api
          ?.invoke("codex:subagents:selected:hydrate", {
            rootThreadId: expectedRootThreadId,
            threadId: expectedSelectedThreadId,
          })
          .then(
            (result) => {
              scope.__staleSubagentHydration = { settled: true, result };
            },
            (cause: unknown) => {
              scope.__staleSubagentHydration = {
                settled: true,
                error: cause instanceof Error ? cause.message : String(cause),
              };
            },
          );
      },
      { expectedRootThreadId: rootThreadId, expectedSelectedThreadId: selectedThreadId },
    );
    await expect
      .poll(() => readScenarioState(statePath).reconnectReadStartedAtMs, { timeout: 15_000 })
      .toEqual(expect.any(Number));
    expect(readScenarioState(statePath).reconnectReadRespondedAtMs).toBeNull();
    const firstInstance = readScenarioState(statePath).appServerInstances?.[0];
    expect(firstInstance?.ordinal).toBe(1);
    expect(firstInstance?.pid).toEqual(expect.any(Number));
    process.kill(firstInstance!.pid, 0);
    process.kill(firstInstance!.pid, "SIGKILL");

    await expect
      .poll(() => readScenarioState(statePath).appServerInstances?.length ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);
    const secondInstance = readScenarioState(statePath).appServerInstances?.at(-1);
    expect(secondInstance?.ordinal).toBeGreaterThan(1);
    expect(secondInstance?.pid).not.toBe(firstInstance?.pid);
    await expect
      .poll(
        () =>
          readRpcEntries(logPath).some(
            (entry) =>
              entry.processInstanceOrdinal === secondInstance?.ordinal &&
              entry.method === "initialize",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect
      .poll(() => readScenarioState(statePath).reconnectNotificationAtMs, { timeout: 15_000 })
      .toEqual(expect.any(Number));
    await expect
      .poll(() => capturedRootInvalidationCount(page), { timeout: 15_000 })
      .toBeGreaterThan(invalidationsBeforeDisconnect);

    await expect
      .poll(
        async () => {
          const authority = await readOverviewAuthority();
          return {
            activeKnownCount: authority?.active.knownCount ?? 0,
            complete: authority?.completeness === "complete",
            doneKnownCount: authority?.done.knownCount ?? 0,
            generationAdvanced: (authority?.generation ?? 0) > (initialAuthority?.generation ?? 0),
            selectedStatus: authority?.active.rows.find((row) => row.threadId === selectedThreadId)
              ?.status,
            scoutStatus: authority?.done.rows.find((row) => row.threadId === reconnectScoutThreadId)
              ?.status,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        activeKnownCount: 4,
        complete: true,
        doneKnownCount: 13,
        generationAdvanced: true,
        selectedStatus: "active",
        scoutStatus: "done",
      });
    const recoveredAuthority = await readOverviewAuthority();
    expect(recoveredAuthority?.generation).toBeGreaterThan(initialAuthority?.generation ?? 0);
    expect(recoveredAuthority?.active.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: selectedThreadId, status: "active" }),
      ]),
    );
    expect(recoveredAuthority?.done.rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ threadId: selectedThreadId })]),
    );
    await expect(active.getByText("Deep investigator", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(done.getByText("Deep investigator", { exact: true })).toHaveCount(0);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const scope = window as typeof window & {
              __staleSubagentHydration?: { settled?: boolean };
            };
            return scope.__staleSubagentHydration?.settled ?? false;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);

    const observations = await page.evaluate(() => {
      const scope = window as typeof window & {
        __stopSubagentReconnectObserver?: () => void;
        __subagentReconnectObservations?: Array<Record<string, unknown>>;
      };
      scope.__stopSubagentReconnectObserver?.();
      return scope.__subagentReconnectObservations ?? [];
    });
    expect(observations.some((observation) => observation.selectedInDone === true)).toBe(false);

    const finalState = readScenarioState(statePath);
    const entries = readRpcEntries(logPath);
    // Explicit notLoaded status remains Done after a generation change; metadata discovery
    // does not load that child's transcript to manufacture a second status authority.
    expect(
      entries.some(
        (entry) =>
          entry.processInstanceOrdinal === secondInstance?.ordinal &&
          entry.method === "thread/turns/list" &&
          entry.params.threadId === reconnectScoutThreadId,
      ),
    ).toBe(false);
    expect(finalState.reconnectReadRespondedAtMs).toBeNull();
    expect(
      entries.some(
        (entry) =>
          entry.processInstanceOrdinal === firstInstance?.ordinal &&
          entry.method === "thread/read" &&
          entry.params.threadId === selectedThreadId,
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.processInstanceOrdinal === secondInstance?.ordinal && entry.method === "initialize",
      ),
    ).toBe(true);

    await testInfo.attach("app-server-generation-reconnect", {
      body: JSON.stringify(
        {
          initialAuthority,
          recoveredAuthority,
          processInstances: finalState.appServerInstances,
          reconnectNotificationAtMs: finalState.reconnectNotificationAtMs,
          invalidationsBeforeDisconnect,
          invalidationsAfterReconnect: await capturedRootInvalidationCount(page),
          staleSelectedHydration: {
            request: await page.evaluate(() => {
              const scope = window as typeof window & { __staleSubagentHydration?: unknown };
              return scope.__staleSubagentHydration ?? null;
            }),
            startedAtMs: finalState.reconnectReadStartedAtMs,
            respondedAtMs: finalState.reconnectReadRespondedAtMs,
          },
          rpcByProcessInstance: Object.fromEntries(
            [...new Set(entries.map((entry) => entry.processInstanceOrdinal))].map((ordinal) => [
              ordinal,
              entries
                .filter((entry) => entry.processInstanceOrdinal === ordinal)
                .map((entry) => ({ method: entry.method, params: entry.params })),
            ]),
          ),
          observations,
          codexEvents: await capturedCodexEvents(page),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await harness.close();
  }
});
