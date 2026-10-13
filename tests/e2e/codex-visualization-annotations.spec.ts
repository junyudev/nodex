import { expect, test } from "@playwright/test";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { resolveCodexThreadVisualizationDirectory } from "../../src/main/codex/codex-dynamic-first-turn-context";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { codexVisualizationInteractionAtomKey } from "../../src/shared/codex-visualization-state";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";
import { readOwnedWidget, clickOwnedWidget } from "./support/owned-inline-visualization-guest";

const fixture = `<main id="annotation-fixture"><section id="chart" aria-label="Chart"><button id="counter">Increment</button><output id="count">0</output><output id="settings"></output></section><button id="outside">Outside</button><div class="viz-carousel" id="variants" aria-label="Chart variants"><section id="bars" data-variant="Bars">Bars</section><section id="dots" data-variant="Dots">Dots</section></div></main><script>
const state={radius:10,tint:'#112233',details:true,density:'compact'};
const render=()=>document.getElementById('settings').textContent=JSON.stringify(state);render();
let count=0;document.getElementById('counter').onclick=()=>document.getElementById('count').textContent=String(++count);
new Tweak({container:document.getElementById('chart'),onChange:render}).addSlider(state,'radius',{min:0,max:100,label:'Radius'}).addColorPicker(state,'tint',{label:'Tint'}).addToggle(state,'details',{label:'Details'}).addSelect(state,'density',{label:'Density',options:[{label:'Compact',value:'compact'},{label:'Relaxed',value:'relaxed'}]});
new Tweak({container:document.getElementById('bars')}).addSlider({size:3},'size',{min:0,max:10,label:'Bars size'});
new Tweak({container:document.getElementById('dots')}).addSlider({size:5},'size',{min:0,max:10,label:'Dots size'});
</script>`;

test("authors, previews and persists HTML adjustments as untrusted queued context", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const threadId = createUuidV7();
  const harness = await ElectronScenarioHarness.create({
    label: "codex-visualization-annotations",
    codex: "empty",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_INJECTION_RELEASE_PATH: ".fake-codex/injection-release",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_FAKE_CODEX_THREAD_ID: threadId,
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "120",
      NODEX_FAKE_CODEX_RESUMED_COMPLETION_DELAY_MS: "120",
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.162.0-alpha.17.2",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-transcript-performance-app-server.mjs"),
    "0.162.0-alpha.17.2",
  );
  const stateDirectory = path.join(harness.profile.runRoot, ".fake-codex"),
    statePath = path.join(stateDirectory, "state.json");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "injection-release"), "accepted");
  await writeFile(
    statePath,
    JSON.stringify({
      thread: null,
      turns: [],
      turnSequence: 0,
      queueSequence: 0,
      queuedSubmissions: [],
    }),
  );
  let failed = false;
  let activePage: import("@playwright/test").Page | null = null;
  try {
    const initial = await harness.launch();
    const draft = await createAgentSmokeDraft(
      initial,
      harness.profile.initialProjectsDirectory,
      "HTML adjustments",
    );
    expect(
      await sendAgentPrompt(initial, draft.projectSessionId, "Prepare adjustment history"),
    ).toBe(threadId);
    await expect(
      initial.getByText("The task completed successfully.", { exact: true }),
    ).toBeVisible();
    const directory = resolveCodexThreadVisualizationDirectory(harness.profile.codexHome, threadId);
    if (!directory) throw new Error("Native Thread has no owned visualization path");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "annotations.html");
    await writeFile(file, fixture);
    const state = JSON.parse(await readFile(statePath, "utf8")) as { turns: Turn[] };
    const turn: Turn = {
      id: "annotation-history",
      rootTurnId: null,
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1_800_000_000,
      completedAt: 1_800_000_001,
      durationMs: 1000,
      items: [
        {
          type: "agentMessage",
          id: "annotation-answer",
          text: `::codex-inline-vis{file="annotations.html" mode="wide"}`,
          phase: "final_answer",
          delivery: null,
          memoryCitation: null,
          questions: null,
        },
      ],
    };
    const temp = path.join(stateDirectory, "history.tmp");
    await writeFile(temp, JSON.stringify({ ...state, turns: [...state.turns, turn] }));
    await rename(temp, statePath);
    const page = await harness.restart();
    activePage = page;
    const response = page.locator(
      '[data-inline-visualization="true"][data-visualization-status="ready"]',
    );
    await expect(response).toHaveCount(1, { timeout: 60_000 });
    const historyFrameId = await response.getAttribute("data-visualization-frame-id");
    if (!historyFrameId) throw new Error("History visualization has no resource identity");
    const guestId = await response
      .locator("webview")
      .evaluate((element) =>
        (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
      );
    const read = <T>(expression: string) =>
      readOwnedWidget<T>(harness.application, guestId, "annotation-fixture", expression);
    const click = (selector: string) =>
      clickOwnedWidget(harness.application, guestId, "annotation-fixture", selector);
    await expect(
      response.getByRole("button", { name: "Adjust visualization", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await click("#counter");
    await expect.poll(() => read<string>("document.getElementById('count').textContent")).toBe("1");
    await response.getByRole("button", { name: "Adjust visualization", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Tint", exact: true })).toBeVisible();
    await page.getByRole("slider", { name: "Radius", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("textbox", { name: "Tint", exact: true }).fill("#aabbcc");
    await page.getByRole("checkbox", { name: "Details", exact: true }).uncheck();
    await page.getByRole("button", { name: "Density", exact: true }).click();
    await page.getByRole("menuitem", { name: "Relaxed", exact: true }).click();
    await expect
      .poll(() => read<unknown>("JSON.parse(document.getElementById('settings').textContent)"))
      .toEqual({ radius: 11, tint: "#aabbcc", details: false, density: "relaxed" });
    await click("#counter");
    await expect.poll(() => read<string>("document.getElementById('count').textContent")).toBe("1");
    await response.getByRole("button", { name: "Open fullscreen", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Adjust visualization", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    expect(
      await response
        .locator("webview")
        .evaluate((element) =>
          (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
        ),
    ).toBe(guestId);
    await response.getByRole("button", { name: "Adjust visualization", exact: true }).click();
    await click('#variants button[aria-label="Next variant"]');
    await expect
      .poll(() =>
        read<boolean>(
          "document.getElementById('bars').hidden&&!document.getElementById('dots').hidden",
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Reset all", exact: true }).click();
    await expect
      .poll(() =>
        read<number>("JSON.parse(document.getElementById('settings').textContent).radius"),
      )
      .toBe(10);
    const interactionKey = codexVisualizationInteractionAtomKey({ hostId: "local", threadId });
    const persisted = () =>
      page.evaluate(
        async ({ key, file }) => {
          const snapshot = (await window.api?.invoke("persisted-atom:sync-request")) as
            | import("../../src/shared/ipc-api").PersistedAtomSnapshot
            | undefined;
          const record = snapshot?.values[key] as
            | Record<string, { state: { modelContent: unknown } }>
            | undefined;
          return record?.[file]?.state.modelContent;
        },
        { key: interactionKey, file },
      );
    await expect.poll(persisted).toEqual({
      edits: [],
      selectedVariants: [{ carousel: 0, label: "Chart variants", variant: "Dots" }],
    });
    const composer = page.locator('[data-codex-composer="true"][contenteditable="true"]').first();
    await page
      .getByRole("textbox", { name: "Request changes", exact: true })
      .fill("Use the selected variant");
    const requestsPath = path.join(stateDirectory, "requests.jsonl");
    const requests = async () =>
      (await readFile(requestsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const before = (await requests()).length;
    await page.getByRole("button", { name: "Send changes", exact: true }).click();
    await expect
      .poll(async () =>
        (await requests())
          .slice(before)
          .some((record) => ["turn/start", "queue-turn/start"].includes(record.method)),
      )
      .toBe(true);
    const captured = (await requests()).slice(before);
    const injectionIndex = captured.findIndex((record) => record.method === "injection-held");
    const startIndex = captured.findIndex((record) =>
      ["turn/start", "queue-turn/start"].includes(record.method),
    );
    expect(injectionIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(injectionIndex);
    const injection = captured[injectionIndex]!.params;
    const confirmedIndex = captured.findIndex(
      (record) =>
        record.method === "injection-released" && record.params.requestId === injection.requestId,
    );
    expect(confirmedIndex).toBeGreaterThan(injectionIndex);
    expect(startIndex).toBeGreaterThan(confirmedIndex);
    const items = injection.items as {
      type: string;
      name?: string;
      call_id: string;
      output?: { type: string; text: string }[];
    }[];
    expect(items[0]).toMatchObject({ type: "function_call", name: "untrusted_input" });
    expect(items[1]?.call_id).toBe(items[0]?.call_id);
    expect(JSON.parse(items[1]!.output![0]!.text)).toEqual({
      kind: "model_context",
      source: "mcp_app",
      sourceId: file,
      title: "Visualization changes",
      text: null,
      structuredContent: {
        edits: [],
        selectedVariants: [{ carousel: 0, label: "Chart variants", variant: "Dots" }],
      },
    });
    expect(captured[startIndex]!.params.input).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Use the selected variant",
        text_elements: expect.any(Array),
      }),
    ]);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Request changes", exact: true })).toHaveCount(
      0,
    );
    // An ordinary Markdown stream keeps inline document permissions and resource identity.
    await writeFile(path.join(directory, "stream.html"), fixture);
    await appendFile(
      path.join(stateDirectory, "commands.jsonl"),
      `${JSON.stringify({ type: "start" })}\n`,
    );
    await expect(page.getByText("Stream baseline", { exact: true })).toBeVisible();
    await appendFile(
      path.join(stateDirectory, "commands.jsonl"),
      `${JSON.stringify({ type: "delta", delta: '\n\n::codex-inline-vis{file="stream.html" mode="wide"}\n\n' })}\n`,
    );
    const newFrames = page.locator(
      `[data-inline-visualization="true"]:not([data-visualization-frame-id="${historyFrameId}"])`,
    );
    await expect(newFrames).toHaveCount(1);
    const streamingFrameId = await newFrames.getAttribute("data-visualization-frame-id");
    if (!streamingFrameId) throw new Error("Streaming visualization has no resource identity");
    const streamed = page.locator(`[data-visualization-frame-id="${streamingFrameId}"]`);
    await expect(
      streamed.getByRole("button", { name: "Open fullscreen", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      streamed.getByRole("button", { name: "Adjust visualization", exact: true }),
    ).toBeVisible();
    const streamingGuest = await streamed
      .locator("webview")
      .evaluate((element) =>
        (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
      );
    await appendFile(
      path.join(stateDirectory, "commands.jsonl"),
      `${JSON.stringify({ type: "complete" })}\n`,
    );
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect(
      await streamed
        .locator("webview")
        .evaluate((element) =>
          (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
        ),
    ).toBe(streamingGuest);
    await expect(composer).toBeVisible();
    await testInfo.attach("html-annotations-native-contract", {
      body: JSON.stringify({
        threadId,
        guestId,
        streamingGuest,
        queuedContext: captured,
        interaction: await persisted(),
        sameGuestFullscreen: true,
        markdownStreamingIndependent: true,
      }),
      contentType: "application/json",
    });
  } catch (error) {
    failed = true;
    // Capture the disposable fixture and public queue ingress before the harness deletes its home.
    const diagnosis = await Promise.allSettled([
      readFile(path.join(stateDirectory, "requests.jsonl"), "utf8"),
      readFile(statePath, "utf8"),
      activePage?.evaluate(async (threadId) => {
        const queue = await window.api?.invoke("codex:queued-messages:read");
        const host = await window.api?.invoke("codex:app-server:host-context", "local");
        return {
          queue:
            queue !== null && typeof queue === "object" ? (Reflect.get(queue, threadId) ?? []) : [],
          host:
            host !== null && typeof host === "object"
              ? {
                  supportsThreadQueue: Reflect.get(host, "supportsThreadQueue"),
                  supportsThreadTimeline: Reflect.get(host, "supportsThreadTimeline"),
                  generation: Reflect.get(host, "generation"),
                }
              : null,
          composer: document.querySelector('[data-codex-composer="true"]')?.textContent,
          buttons: Array.from(document.querySelectorAll("button")).map((button) => ({
            label: button.getAttribute("aria-label") ?? button.textContent,
            disabled: button.disabled,
          })),
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
            (node) => node.textContent,
          ),
        };
      }, threadId),
    ]);
    await testInfo.attach("html-annotations-failure-state", {
      body: JSON.stringify({
        threadId,
        observations: diagnosis.map((result, index) => ({
          kind: ["native-request-tail", "native-fixture-state", "public-queue-and-renderer-dom"][
            index
          ],
          ...(result.status === "fulfilled"
            ? {
                value:
                  index === 0 && typeof result.value === "string"
                    ? result.value.trim().split("\n").slice(-120)
                    : result.value,
              }
            : { error: String(result.reason) }),
        })),
      }),
      contentType: "application/json",
    });
    await testInfo.attach("desktop-runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    try {
      await harness.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
});
