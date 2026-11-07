import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  createAgentSmokeDraft,
  readCodexModelCatalog,
  selectCodexExecutionProfile,
  sendAgentPromptWithEvidence,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";
import { openWorkbenchSettings } from "./support/workbench-settings";

interface ReceivedBatch {
  readonly apiKey: string | undefined;
  readonly user: {
    readonly userID: string;
    readonly statsigEnvironment: { readonly tier: string };
    readonly custom: Record<string, string>;
  };
  readonly events: readonly {
    readonly eventName: string;
    readonly metadata: Record<string, string>;
  }[];
}

const startReceiver = async () => {
  const batches: ReceivedBatch[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      batches.push({
        ...(JSON.parse(body) as Omit<ReceivedBatch, "apiKey">),
        apiKey: request.headers["statsig-api-key"] as string | undefined,
      });
      response.writeHead(202).end('{"success":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { batches, port, stop: () => new Promise((resolve) => server.close(resolve)) };
};

const evidenceDirectory = process.env.NODEX_E2E_EVIDENCE_DIR;
const capture = async (page: Page, name: string) => {
  if (!evidenceDirectory) return;
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDirectory, `${name}.png`) });
};

test("first launch discloses analytics, and delivery honors the person's choice", async () => {
  test.setTimeout(240_000);
  const receiver = await startReceiver();
  const harness = await ElectronScenarioHarness.create({
    label: "product-analytics",
    cwd: process.cwd(),
    // A receiver makes the preference govern, which is what a released build does. CI and
    // DO_NOT_TRACK are cleared so the run proves the default rather than the machine it runs on.
    environment: {
      NODEX_TELEMETRY_ENDPOINT: `http://127.0.0.1:${receiver.port}/v1/log_event`,
      CI: "",
      DO_NOT_TRACK: "",
    },
  });
  try {
    const page = await harness.launch();
    const notice = page.getByRole("status").filter({ hasText: "anonymous usage and crash data" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await capture(page, "01-first-launch-notice");
    expect(receiver.batches, "nothing leaves before the notice is acted on").toEqual([]);

    // A renderer event, end to end: the shortcut opens the palette, which reports its use.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    await notice.getByRole("button", { name: "Manage" }).click();
    await expect(notice).toHaveCount(0);
    const toggle = page.getByRole("switch", { name: "Share usage analytics" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.scrollIntoViewIfNeeded();
    await capture(page, "02-privacy-settings");

    await page.getByRole("button", { name: "See what is sent" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("installation_created")).toBeVisible();
    await expect(dialog.getByText("app_launched")).toBeVisible();
    await expect(dialog.getByText("feature=command_palette")).toBeVisible();
    await expect(dialog.getByText("feature=page")).toBeVisible();
    await expect(dialog.getByText("feature=inbox"), "a tab behind the page is not use").toHaveCount(
      0,
    );
    await capture(page, "03-see-what-is-sent");
    await dialog.getByRole("button", { name: "Done" }).click();

    await harness.stopElectron();
    const firstRun = receiver.batches.flatMap((batch) =>
      batch.events.map((event) => event.eventName),
    );
    expect(firstRun).toContain("installation_created");
    expect(firstRun).toContain("app_launched");
    expect(firstRun).toContain("feature_used");
    const batch = receiver.batches[0]!;
    expect(batch.user.userID).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.user.statsigEnvironment.tier).toBe("development");
    expect(batch.user.custom.channel).toBe("development");
    expect(JSON.stringify(receiver.batches)).not.toContain(process.cwd());

    const relaunched = await harness.launch();
    await expect(relaunched.getByRole("status").filter({ hasText: "anonymous usage" })).toHaveCount(
      0,
    );
    await openWorkbenchSettings(relaunched);
    const relaunchedToggle = relaunched.getByRole("switch", { name: "Share usage analytics" });
    await relaunchedToggle.scrollIntoViewIfNeeded();
    const before = receiver.batches.length;
    await relaunchedToggle.click();
    await expect(relaunchedToggle).toHaveAttribute("aria-checked", "false");
    await harness.stopElectron();
    expect(receiver.batches.length, "turning analytics off discards what had not been sent").toBe(
      before,
    );
  } finally {
    await harness.close().catch(() => undefined);
    await receiver.stop();
  }
});

/**
 * A real Agent turn proves the Runtime-to-Main path that a mocked test cannot: Thread and turn facts
 * reach the receiver from execution itself, and the conversation does not. It spends model credit,
 * so it runs only when a Codex home with credentials is named.
 */
test("a real conversation reports its Thread and turn, and none of its content", async () => {
  const sourceCodexHome = process.env.NODEX_E2E_REAL_AGENT_CODEX_HOME;
  test.skip(!sourceCodexHome, "Set NODEX_E2E_REAL_AGENT_CODEX_HOME to spend real model credit");
  test.setTimeout(420_000);
  const receiver = await startReceiver();
  const harness = await ElectronScenarioHarness.create({
    label: "product-analytics-real-turn",
    codex: "copy-auth",
    sourceCodexHome: sourceCodexHome!,
    cwd: process.cwd(),
    environment: {
      NODEX_TELEMETRY_ENDPOINT: `http://127.0.0.1:${receiver.port}/v1/log_event`,
      CI: "",
      DO_NOT_TRACK: "",
    },
  });
  const secretMarker = "ANALYTICS_PRIVATE_MARKER_7f3a";
  try {
    const page = await harness.launch();
    await page.getByRole("button", { name: "Got it" }).click();
    const { projectSessionId } = await createAgentSmokeDraft(
      page,
      process.cwd(),
      "Private analytics project name",
    );
    const models = await readCodexModelCatalog(page);
    const model = models.find((candidate) => !candidate.hidden && /luna/i.test(candidate.id));
    if (!model) throw new Error("A low-cost model is required for the real turn");
    await selectCodexExecutionProfile(page, model, {
      modelId: model.id,
      reasoningEffort: model.supportedReasoningEfforts[0]!.reasoningEffort,
      serviceTier: null,
    });
    const { threadId } = await sendAgentPromptWithEvidence(
      page,
      projectSessionId,
      `Reply with only this word: ${secretMarker}`,
    );
    await waitForRuntimeCompletedAgentTurn(
      page,
      { sessionId: projectSessionId, threadId },
      240_000,
    );
    await capture(page, "04-real-conversation");
    await harness.stopElectron();

    const events = receiver.batches.flatMap((batch) => batch.events);
    const started = events.find((event) => event.eventName === "thread_started");
    const completed = events.find((event) => event.eventName === "turn_completed");
    expect(started?.metadata).toMatchObject({
      provider: "codex",
      model: model.id.toLowerCase(),
      host: "local",
    });
    expect(completed?.metadata).toMatchObject({ provider: "codex", status: "completed" });
    expect(Number(completed?.metadata.input_tokens)).toBeGreaterThan(0);
    const wire = JSON.stringify(receiver.batches);
    expect(wire).not.toContain(secretMarker);
    expect(wire).not.toContain("Private analytics project name");
    expect(wire).not.toContain(process.cwd());
    if (evidenceDirectory) {
      writeFileSync(
        path.join(evidenceDirectory, "real-turn-wire.json"),
        JSON.stringify(receiver.batches, null, 2),
      );
    }
  } finally {
    await harness.close().catch(() => undefined);
    await receiver.stop();
  }
});
