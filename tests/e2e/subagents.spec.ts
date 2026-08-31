import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";

const repositoryRoot = process.cwd();
const scenarioThreadTimestampHex = Date.now().toString(16).padStart(12, "0");
const scenarioThreadId = (suffix: string): string =>
  `${scenarioThreadTimestampHex.slice(0, 8)}-${scenarioThreadTimestampHex.slice(8)}-7000-8000-${suffix}`;
const rootThreadId = scenarioThreadId("000000000101");
const fallbackInterruptThreadId = scenarioThreadId("000000000201");
const selectedThreadId = scenarioThreadId("000000000202");
const nestedThreadId = scenarioThreadId("000000000205");
const relationshipReceiverThreadId = scenarioThreadId("000000000299");
const topologyRecoveredThreadId = scenarioThreadId("000000000312");
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
  readonly collabItemNotificationAtMs?: number;
  readonly lastDiscoveryThreadIds?: readonly string[];
  readonly receiverReadRespondedAtMs?: number | null;
  readonly receiverReadStartedAtMs?: number;
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
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const projects = (await window.api?.invoke("projects:list")) as
            | { items?: Array<{ id?: unknown }> }
            | undefined;
          const projectId = projects?.items?.[0]?.id;
          if (typeof projectId !== "string") return 0;
          const tasks = (await window.api?.invoke("workspace:tasks:list", projectId, {
            first: 50,
          })) as { items?: Array<{ thread?: unknown }> } | undefined;
          return tasks?.items?.filter((item) => item.thread == null).length ?? 0;
        }),
      { timeout: 30_000 },
    )
    .toBe(1);
  const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  await expect(composer).toBeVisible();
  await composer.fill(prompt);
  await expect(composer).toHaveText(prompt);
  const sendButton = page.getByRole("button", { name: "Send prompt" });
  await expect(sendButton).toBeEnabled();
  return sendButton;
};

const startSubagentScenario = async (harness: ElectronScenarioHarness): Promise<Page> => {
  const page = await harness.launch();
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

const waitForRpcQuiet = async (
  logPath: string,
  predicate: (entry: RpcEntry) => boolean,
  timeoutMs = 15_000,
  quietMs = 300,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let lastChangeAtMs = Date.now();
  while (Date.now() < deadline) {
    const count = readRpcEntries(logPath).filter(predicate).length;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAtMs = Date.now();
    } else if (count > 0 && Date.now() - lastChangeAtMs >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`RPC sequence did not settle within ${timeoutMs}ms`);
};

const beginCodexEventCapture = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __subagentScenarioCodexEvents?: unknown[];
      __stopSubagentScenarioCodexEvents?: () => void;
    };
    scope.__stopSubagentScenarioCodexEvents?.();
    scope.__subagentScenarioCodexEvents = [];
    scope.__stopSubagentScenarioCodexEvents = window.api?.on("codex:event", (event: unknown) => {
      scope.__subagentScenarioCodexEvents?.push({ observedAtMs: Date.now(), event });
    });
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

test("keeps overview metadata-only, expands bounded windows, and hydrates only the selection", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-overview-and-selected-hydration", {
    NODEX_LOG_FILE: "1",
    NODEX_LOG_FILE_LEVEL: "debug",
    NODEX_FAKE_SUBAGENT_TOPOLOGY_MISSED_EDGE: "1",
  });

  try {
    const page = await startSubagentScenario(harness);
    const rendererDiagnostics: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        rendererDiagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      rendererDiagnostics.push(`pageerror: ${error.stack ?? error.message}`);
    });
    const logPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const statePath = path.join(harness.profile.runRoot, ".fake-codex", "state.json");
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ expectedItemId, expectedRootThreadId }) => {
              const snapshot = (await window.api?.invoke(
                "codex:thread:snapshot:request",
                expectedRootThreadId,
              )) as {
                canonicalState?: {
                  turns?: Array<{ items?: Array<{ id?: unknown }> }>;
                } | null;
              } | null;
              return (
                snapshot?.canonicalState?.turns?.some((turn) =>
                  turn.items?.some((item) => item.id === expectedItemId),
                ) ?? false
              );
            },
            {
              expectedItemId: "activity-topology-missed-edge",
              expectedRootThreadId: rootThreadId,
            },
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.getByRole("button", { name: "Open subagents" }).first().click();

    const panel = page.locator(`[data-subagents-panel-overview="${rootThreadId}"]`);
    const active = panel.locator('[data-subagent-overview-section="active"]');
    const done = panel.locator('[data-subagent-overview-section="done"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(active.getByRole("heading", { name: "Active · 5" })).toBeVisible({
      timeout: 30_000,
    });
    // Topology repair may commit between the panel's first read and this DOM
    // observation, so both the pre-repair and repaired totals are valid here.
    await expect(done.getByRole("heading", { name: /^Done · (11|12)$/u })).toBeVisible({
      timeout: 30_000,
    });
    await expect(active.locator('[aria-label^="Open subagent "]')).toHaveCount(4);
    await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(10);
    await expect(active.getByText("Approval sentinel", { exact: true })).toBeVisible();
    await expect(active.getByText("Waiting", { exact: true })).toBeVisible();
    await expect(active.getByText("Reconnect scout", { exact: true })).toBeVisible();
    await expect(active.getByText("Nested verifier", { exact: true })).toHaveCount(0);

    const overviewEntries = readRpcEntries(logPath);
    const discovery = overviewEntries.find(
      (entry) => entry.method === "thread/list" && entry.params.ancestorThreadId === rootThreadId,
    );
    expect(discovery?.params).toMatchObject({
      ancestorThreadId: rootThreadId,
      archived: false,
      limit: 200,
      sourceKinds: ["subAgentThreadSpawn"],
    });
    expect(overviewEntries.filter(isChildTranscriptRequest)).toEqual([]);
    const initialTopologyMetadataReads = overviewEntries.filter(
      (entry) =>
        entry.method === "thread/read" && entry.params.threadId === topologyRecoveredThreadId,
    );
    expect(initialTopologyMetadataReads.length).toBeLessThanOrEqual(1);
    for (const entry of initialTopologyMetadataReads) {
      expect(entry.params).toEqual({
        threadId: topologyRecoveredThreadId,
        includeTurns: false,
      });
    }
    await attachRequestEvidence(testInfo, "metadata-only-overview-rpcs", overviewEntries);

    await expect
      .poll(
        () =>
          readRpcEntries(logPath).filter(
            (entry) =>
              entry.method === "thread/read" && entry.params.threadId === topologyRecoveredThreadId,
          ).length,
        { timeout: 15_000 },
      )
      .toBe(1);
    await expect
      .poll(() => readRpcEntries(logPath).filter(isBoundedTopologyRequest).length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(3);
    await waitForRpcQuiet(
      logPath,
      (entry) =>
        isBoundedTopologyRequest(entry) ||
        (entry.method === "thread/read" && entry.params.threadId === topologyRecoveredThreadId),
    );
    await expect(done.getByRole("heading", { name: "Done · 12" })).toBeVisible({
      timeout: 15_000,
    });

    type ExpandedOverview = {
      completeness?: unknown;
      active?: {
        knownCount?: unknown;
        rows?: Array<{ threadId?: unknown; parentThreadId?: unknown }>;
      };
      done?: {
        knownCount?: unknown;
        rows?: Array<{ threadId?: unknown; parentThreadId?: unknown }>;
      };
    };
    const readExpandedOverview = async (): Promise<ExpandedOverview> =>
      await page.evaluate(async (expectedRootThreadId) => {
        return (await window.api?.invoke("codex:subagents:overview:read", {
          rootThreadId: expectedRootThreadId,
          mode: "expanded",
        })) as ExpandedOverview;
      }, rootThreadId);
    const expandedOverview = await readExpandedOverview();
    await testInfo.attach("expanded-overview-after-topology", {
      body: JSON.stringify(expandedOverview, null, 2),
      contentType: "application/json",
    });
    await expect
      .poll(
        () =>
          readRpcEntries(logPath).filter(
            (entry) =>
              entry.method === "thread/read" && entry.params.threadId === topologyRecoveredThreadId,
          ),
        { timeout: 15_000 },
      )
      .toEqual([
        expect.objectContaining({
          method: "thread/read",
          params: { threadId: topologyRecoveredThreadId, includeTurns: false },
        }),
      ]);
    const topologyEntries = readRpcEntries(logPath).filter(
      (entry) =>
        isBoundedTopologyRequest(entry) ||
        (entry.method === "thread/read" && entry.params.threadId === topologyRecoveredThreadId),
    );
    const topologyPageEntries = topologyEntries.filter(isBoundedTopologyRequest);
    expect(topologyPageEntries.length).toBeGreaterThanOrEqual(3);
    expect(topologyPageEntries.length).toBeLessThanOrEqual(32);
    expect(topologyEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/turns/list",
          params: expect.objectContaining({
            threadId: fallbackInterruptThreadId,
            limit: 5,
            sortDirection: "asc",
            itemsView: "full",
          }),
        }),
      ]),
    );
    await attachRequestEvidence(testInfo, "bounded-topology-repair-rpcs", topologyEntries);

    await active.getByRole("button", { name: "Show more" }).click();
    await expect(active.locator('[aria-label^="Open subagent "]')).toHaveCount(5);
    await expect(active.getByText("Nested verifier", { exact: true })).toBeVisible();
    await done.getByRole("button", { name: "Show more" }).click();
    await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(12);
    expect(readRpcEntries(logPath).filter(isChildTranscriptRequest)).toEqual([]);

    const expandedRows = [
      ...(expandedOverview.active?.rows ?? []),
      ...(expandedOverview.done?.rows ?? []),
    ];
    const nestedRows = expandedRows.filter((row) => row.threadId === nestedThreadId);
    expect(nestedRows).toEqual([
      expect.objectContaining({
        threadId: nestedThreadId,
        parentThreadId: fallbackInterruptThreadId,
      }),
    ]);
    const discoveryOrder = readScenarioState(statePath).lastDiscoveryThreadIds;
    expect(readScenarioState(statePath).spawnNotificationThreadIds).toEqual([
      nestedThreadId,
      fallbackInterruptThreadId,
    ]);
    expect(discoveryOrder?.indexOf(nestedThreadId)).toBeLessThan(
      discoveryOrder?.indexOf(fallbackInterruptThreadId) ?? -1,
    );
    expect(readRpcEntries(logPath).filter(isChildTranscriptRequest)).toEqual([]);

    await active.getByRole("button", { name: "Show less" }).click();
    await expect(active.locator('[aria-label^="Open subagent "]')).toHaveCount(4);
    await done.getByRole("button", { name: "Show less" }).click();
    await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(10);

    await active.getByRole("button", { name: "Open subagent Deep investigator" }).click();
    const sidePanel = page.locator('[data-subagents-side-panel-tab^="subagents:"]');
    await expect(sidePanel.getByText("Deep investigator", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => readRpcEntries(logPath).filter(isChildTranscriptRequest).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await page.waitForTimeout(250);
    const selectedRouteState = await page.evaluate(() => ({
      panels: [...document.querySelectorAll<HTMLElement>("[data-subagents-side-panel-tab]")].map(
        (element) => ({
          id: element.dataset.subagentsSidePanelTab ?? null,
          hydration: element.dataset.subagentsSelectedHydration ?? null,
          text: element.textContent?.slice(0, 500) ?? "",
        }),
      ),
      overviews: [...document.querySelectorAll<HTMLElement>("[data-subagents-panel-overview]")].map(
        (element) => element.dataset.subagentsPanelOverview ?? null,
      ),
      alerts: [...document.querySelectorAll<HTMLElement>('[role="alert"]')].map(
        (element) => element.textContent?.slice(0, 500) ?? "",
      ),
      selectedTabs: [
        ...document.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]'),
      ].map((element) => element.textContent?.slice(0, 200) ?? ""),
    }));
    await testInfo.attach("selected-route-state-after-rpc", {
      body: JSON.stringify({ ...selectedRouteState, rendererDiagnostics }, null, 2),
      contentType: "application/json",
    });
    await expect(sidePanel).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    expect(rendererDiagnostics).toEqual([]);
    const selectedPanelState = await sidePanel.evaluate((element) => ({
      text: element.textContent,
      hydration: element.getAttribute("data-subagents-selected-hydration"),
      hasDetailStage: element.querySelector("[data-background-agent-side-panel-tab]") !== null,
      composerLabels: [...element.querySelectorAll("[data-codex-composer]")].map((composer) =>
        composer.getAttribute("aria-label"),
      ),
    }));
    await testInfo.attach("selected-panel-state", {
      body: JSON.stringify(selectedPanelState, null, 2),
      contentType: "application/json",
    });
    await expect(
      sidePanel.locator('[data-codex-composer="true"][aria-label="Ask for follow-up changes"]'),
      JSON.stringify(selectedPanelState),
    ).toBeVisible({ timeout: 30_000 });

    const selectedEntries = readRpcEntries(logPath).filter(isChildTranscriptRequest);
    expect(selectedEntries.length).toBeGreaterThan(0);
    expect([...new Set(selectedEntries.map((entry) => entry.params.threadId))]).toEqual([
      selectedThreadId,
    ]);
    expect(selectedEntries.filter((entry) => entry.method === "thread/resume")).toHaveLength(0);
    expect(
      readRpcEntries(logPath).filter(
        (entry) => entry.method === "thread/read" && entry.params.threadId === selectedThreadId,
      ),
    ).toEqual([
      expect.objectContaining({
        params: { threadId: selectedThreadId, includeTurns: false },
      }),
    ]);
    for (const entry of selectedEntries.filter(
      (candidate) =>
        candidate.method === "thread/turns/list" || candidate.method === "thread/items/list",
    )) {
      expect(entry.params.limit).toEqual(expect.any(Number));
      expect(entry.params.limit as number).toBeLessThanOrEqual(100);
    }
    await attachRequestEvidence(testInfo, "selected-only-hydration-rpcs", selectedEntries);

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
  });

  try {
    const page = await startSubagentScenario(harness);
    await page.getByRole("button", { name: "Open subagents" }).first().click();
    await page.setViewportSize({ width: 820, height: 720 });

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
        .getByRole("heading", { name: "Active · 4" }),
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

test("keeps later root notifications moving while panel-closed relationship repair is stalled", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-panel-closed-root-completion", {
    NODEX_FAKE_SUBAGENT_AUTO_COMPLETE_ROOT_MS: "1800",
    NODEX_FAKE_SUBAGENT_COLLAB_ITEM_DELAY_MS: "1000",
    NODEX_FAKE_SUBAGENT_RECEIVER_READ_DELAY_MS: "10000",
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
    await expect(page.getByRole("button", { name: "Open subagents" }).first()).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(
      page.locator('[data-codex-composer="true"][aria-label="Do anything"]'),
    ).toBeVisible();

    await expect
      .poll(
        () =>
          readRpcEntries(logPath).filter(
            (entry) =>
              entry.method === "thread/read" &&
              entry.params.threadId === relationshipReceiverThreadId,
          ).length,
        { timeout: 5_000 },
      )
      .toBe(1);
    const receiverRead = readRpcEntries(logPath).find(
      (entry) =>
        entry.method === "thread/read" && entry.params.threadId === relationshipReceiverThreadId,
    );
    expect(receiverRead?.params).toEqual({
      threadId: relationshipReceiverThreadId,
      includeTurns: false,
    });

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
    expect(state.receiverReadStartedAtMs).toEqual(expect.any(Number));
    expect(state.receiverReadRespondedAtMs).toBeNull();
    const notificationLaneLatencyMs =
      (rootIdleEvent?.observedAtMs ?? Number.POSITIVE_INFINITY) - (state.rootCompletedAtMs ?? 0);
    expect(notificationLaneLatencyMs).toBeGreaterThanOrEqual(0);
    expect(notificationLaneLatencyMs).toBeLessThanOrEqual(5_000);

    const entries = readRpcEntries(logPath);
    const descendantDiscoveryRequests = entries.filter(
      (entry) => entry.method === "thread/list" && entry.params.ancestorThreadId === rootThreadId,
    );
    expect(descendantDiscoveryRequests.map((entry) => entry.params.useStateDbOnly)).toEqual([
      true,
      false,
    ]);
    expect(entries.filter(isChildTranscriptRequest)).toEqual([]);
    await testInfo.attach("panel-closed-root-completion", {
      body: JSON.stringify(
        {
          rendererTerminalLatencyMs,
          fixtureCompletionLatencyMs,
          notificationLaneLatencyMs,
          receiverRead: receiverRead ?? null,
          receiverReadRespondedAtMs: state.receiverReadRespondedAtMs,
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

test("stops the root, interrupts only a still-running child, and converges through invalidation", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createSubagentHarness("subagent-root-stop-convergence", {
    NODEX_LOG_FILE: "1",
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

    const entriesAtFallback = readRpcEntries(logPath);
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
    expect(childSkeletons.length).toBeGreaterThan(0);
    expect(
      childSkeletons.some((entry) => entry.params.threadId === fallbackInterruptThreadId),
    ).toBe(true);
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
    await expect(active.getByRole("heading", { name: "Active · 5" })).toBeVisible({
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
            mode: "initial",
          })) as OverviewAuthority;
        } catch {
          return null;
        }
      }, rootThreadId);

    const initialAuthority = await readOverviewAuthority();
    expect(initialAuthority).not.toBeNull();
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
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        activeKnownCount: 5,
        complete: true,
        doneKnownCount: 12,
        generationAdvanced: true,
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
