import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
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
import {
  parseMcpAppSandboxPartition,
  parseMcpAppSandboxSourceUrl,
} from "../../src/shared/mcp-app/mcp-app-sandbox-contract";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";

const widgetDocument = (id: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:16px sans-serif;background:white;color:#222}.content{padding:20px;min-height:140px}button{font:inherit}section{height:540px;background:#eef2f6;margin-top:16px}</style></head><body><main class="content" id="fixture-${id}"><button id="toggle-${id}">Show details</button><button id="increment-${id}">Increment</button><button id="tool-${id}">Try tool</button><output id="counter-${id}" aria-label="Interaction count">0</output><div role="status" id="tool-result-${id}" aria-label="Tool result">Pending</div><section id="details-${id}" hidden>Expanded content</section></main><script>let count=0;document.getElementById('increment-${id}').addEventListener('click',()=>{document.getElementById('counter-${id}').textContent=String(++count)});document.getElementById('toggle-${id}').addEventListener('click',()=>{const detail=document.getElementById('details-${id}');detail.hidden=!detail.hidden});document.getElementById('tool-${id}').addEventListener('click',async()=>{const result=document.getElementById('tool-result-${id}');if(typeof window.openai?.callTool!=='function'){result.textContent='API unavailable';return}try{await window.openai.callTool('ungranted_tool',{});result.textContent='Tool accepted'}catch(error){result.textContent=String(error?.message??error)}});</script></body></html>`;

function interactiveWidgetDocument(id: string): string {
  return widgetDocument(id)
    .replace(
      "</main>",
      `
    <button id="helpers-${id}">Show interactive content</button>
    <button id="state-${id}">Save selection</button><output id="state-result-${id}"></output>
    <a id="download-${id}" href="data:text/plain,widget%20download%20bytes" download="widget-data.txt">Download</a>
    <div id="helpers-content-${id}" hidden>
      <div class="nav" role="tablist"><button role="tab" id="tab-first-${id}" aria-controls="panel-first-${id}">First</button><button role="tab" disabled>Disabled</button><button role="tab" id="tab-second-${id}" aria-controls="panel-second-${id}">Second</button></div>
      <div id="panel-first-${id}" role="tabpanel">First panel</div><div id="panel-second-${id}" role="tabpanel">Second panel</div>
      <div class="viz-carousel" id="carousel-${id}"><div data-variant="One">First variant</div><div data-variant="Two">Second variant</div></div>
      <button id="tooltip-${id}" data-tooltip="Helpful detail">Tooltip</button><i data-lucide="circle-check" id="icon-${id}"></i>
      <viz-calendar id="calendar-${id}" interactive date="2026-10-12" start="09:00" end="11:00" events='[{"title":"First event","start":"09:00","end":"10:00"},{"title":"Overlap event","start":"09:30","end":"10:30"}]'></viz-calendar><output id="calendar-result-${id}"></output>
    </div></main>`,
    )
    .replace(
      "</script>",
      `
      document.getElementById('state-result-${id}').textContent=JSON.stringify(window.openai.widgetState);
      document.getElementById('state-${id}').addEventListener('click',async()=>{await window.openai.setWidgetState({selected:2,modelContent:{selected:2},privateContent:{privateSentinel:'excluded-from-model'}});document.getElementById('state-result-${id}').textContent=JSON.stringify(window.openai.widgetState)});
      document.getElementById('helpers-${id}').addEventListener('click',()=>{document.getElementById('helpers-content-${id}').hidden=false});
      document.getElementById('calendar-${id}').addEventListener('eventselect',event=>{document.getElementById('calendar-result-${id}').textContent=String(event.detail.index)});
    </script>`,
    );
}

const guestIds = async (page: Page): Promise<number[]> =>
  await page
    .locator('webview[title="Interactive response"]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
      ),
    );

/** Inspect only the owned native guest's actual document; no host RPC or renderer atom is synthesized. */
async function readGuest<T>(
  application: ElectronApplication,
  guestId: number,
  fixtureId: string,
  expression: string,
): Promise<T> {
  return (await application.evaluate(
    async ({ webContents }, input) => {
      const guest = webContents.fromId(input.guestId);
      if (!guest || guest.isDestroyed()) throw new Error("Interactive response guest was released");
      for (const frame of guest.mainFrame.framesInSubtree) {
        const belongs = await frame
          .executeJavaScript(
            `Boolean(document.getElementById(${JSON.stringify(`fixture-${input.fixtureId}`)}))`,
          )
          .catch(() => false);
        if (!belongs) continue;
        return await frame.executeJavaScript(input.expression);
      }
      throw new Error("Owned widget document is not ready");
    },
    { guestId, fixtureId, expression },
  )) as T;
}

async function findReadyGuest(
  application: ElectronApplication,
  page: Page,
  fixtureId: string,
): Promise<number> {
  let found: number | null = null;
  await expect
    .poll(
      async () => {
        for (const id of await guestIds(page)) {
          const ready = await page
            .locator('webview[title="Interactive response"]')
            .evaluateAll(
              (elements, guestId) =>
                elements.some(
                  (element) =>
                    (element as unknown as { getWebContentsId(): number }).getWebContentsId() ===
                      guestId &&
                    element
                      .closest('[data-inline-visualization="true"]')
                      ?.getAttribute("data-visualization-status") === "ready",
                ),
              id,
            );
          if (!ready) continue;
          const hasDocument = await readGuest<boolean>(
            application,
            id,
            fixtureId,
            "typeof window.openai?.callTool === 'function'",
          ).catch(() => false);
          if (!hasDocument) continue;
          found = id;
          return true;
        }
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  if (found === null) throw new Error("Interactive response has no owned guest");
  return found;
}

/** Native input reaches the owned guest document, including its normal user-gesture boundary. */
async function clickGuestButton(
  application: ElectronApplication,
  guestId: number,
  fixtureId: string,
  button: string,
  options: { click?: boolean; selector?: string; shadowSelector?: string } = {},
) {
  await application.evaluate(
    async ({ webContents }, input) => {
      const guest = webContents.fromId(input.guestId);
      if (!guest || guest.isDestroyed()) throw new Error("Interactive response guest was released");
      for (const frame of guest.mainFrame.framesInSubtree) {
        const point = (await frame
          .executeJavaScript(
            `(async () => { const marker = document.getElementById(${JSON.stringify(`fixture-${input.fixtureId}`)}); let button = ${input.options.selector ? `document.querySelector(${JSON.stringify(input.options.selector)})` : `document.getElementById(${JSON.stringify(`${input.button}-${input.fixtureId}`)})`}; ${input.options.shadowSelector ? `button = button?.shadowRoot?.querySelector(${JSON.stringify(input.options.shadowSelector)});` : ""} if (!marker || !button) return null; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); const box = button.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
          )
          .catch(() => null)) as { x: number; y: number } | null;
        if (!point) continue;
        let current = frame;
        while (current.parent) {
          const parent = current.parent;
          const owners = (await parent.executeJavaScript(
            `Array.from(document.querySelectorAll('iframe,frame')).map(element => { const box = element.getBoundingClientRect(); return { src: element.src, name: element.name, x: box.left + element.clientLeft, y: box.top + element.clientTop }; })`,
          )) as Array<{ src: string; name: string; x: number; y: number }>;
          const owner =
            owners.find((candidate) => current.name && candidate.name === current.name) ??
            owners.find((candidate) => candidate.src === current.url) ??
            (owners.length === 1 && parent.frames.length === 1 ? owners[0] : undefined);
          if (!owner)
            throw new Error("Owned widget frame has no unambiguous public iframe rectangle");
          point.x += owner.x;
          point.y += owner.y;
          current = parent;
        }
        point.x = Math.round(point.x);
        point.y = Math.round(point.y);
        guest.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
        if (input.options.click === false) return;
        guest.sendInputEvent({
          type: "mouseDown",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
        guest.sendInputEvent({
          type: "mouseUp",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
        return;
      }
      throw new Error("Owned widget document has no requested button");
    },
    { guestId, fixtureId, button, options },
  );
}

test("restores interactive HTML responses and retains guest state through fullscreen and release", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifactDirectory = path.resolve(
    process.env.NODEX_TRANSCRIPT_REVIEW_DIR ?? testInfo.outputPath(),
  );
  await mkdir(artifactDirectory, { recursive: true });
  const nativeThreadId = createUuidV7();
  const harness = await ElectronScenarioHarness.create({
    label: "codex-inline-visualization",
    codex: "empty",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_INJECTION_RELEASE_PATH: ".fake-codex/injection-release",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_FAKE_CODEX_THREAD_ID: nativeThreadId,
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
  const stateDirectory = path.join(harness.profile.runRoot, ".fake-codex");
  const statePath = path.join(stateDirectory, "state.json");
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
  try {
    const initial = await harness.launch();
    const draft = await createAgentSmokeDraft(
      initial,
      harness.profile.initialProjectsDirectory,
      "Interactive responses",
    );
    const threadId = await sendAgentPrompt(
      initial,
      draft.projectSessionId,
      "Prepare the interactive response history",
    );
    expect(threadId).toBe(nativeThreadId);
    await expect(
      initial.getByText("The task completed successfully.", { exact: true }),
    ).toBeVisible();
    const directory = resolveCodexThreadVisualizationDirectory(
      harness.profile.codexHome,
      nativeThreadId,
    );
    if (!directory) throw new Error("Synthetic native Thread has no visualization directory");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "directory-widget.html"), widgetDocument("directory"));
    const workspaceFile = path.join(
      harness.profile.initialProjectsDirectory,
      "workspace-widget.html",
    );
    await writeFile(workspaceFile, widgetDocument("workspace"));
    const publicState = JSON.parse(await readFile(statePath, "utf8")) as { turns: Turn[] };
    const turn: Turn = {
      id: "widget-history-turn",
      rootTurnId: null,
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1_800_000_000,
      completedAt: 1_800_000_001,
      durationMs: 1_000,
      items: [
        {
          type: "userMessage",
          id: "widget-history-user",
          clientId: null,
          content: [{ type: "text", text: "Interactive response history", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "widget-history-answer",
          text: `::codex-inline-vis{file="directory-widget.html" mode="wide"}\n\n::codex-inline-vis{path="${workspaceFile}"}`,
          phase: "final_answer",
          delivery: null,
          memoryCitation: null,
          questions: null,
        },
      ],
    };
    const replacement = path.join(stateDirectory, "widget-state.tmp");
    await writeFile(
      replacement,
      JSON.stringify({ ...publicState, turns: [...publicState.turns, turn] }),
    );
    await rename(replacement, statePath);
    const page = await harness.restart();
    await expect(
      page.locator('[data-inline-visualization="true"][data-visualization-status="ready"]'),
    ).toHaveCount(2, { timeout: 60_000 });
    const directoryGuest = await findReadyGuest(harness.application, page, "directory");
    const workspaceGuest = await findReadyGuest(harness.application, page, "workspace");
    expect(directoryGuest).not.toBe(workspaceGuest);
    const idsBeforeFullscreen = await guestIds(page);
    const visualization = page
      .locator('[data-inline-visualization="true"]')
      .filter({ has: page.locator('webview[title="Interactive response"]') })
      .first();
    await expect(
      visualization.getByRole("button", { name: "Open fullscreen", exact: true }),
    ).toHaveCount(1);
    const narrowVisualization = page
      .locator('[data-inline-visualization="true"]')
      .filter({ has: page.locator('webview[title="Interactive response"]') })
      .nth(1);
    await expect(
      narrowVisualization.getByRole("button", { name: "Open fullscreen", exact: true }),
    ).toHaveCount(0);
    const initialHeight = (await visualization.boundingBox())!.height;
    const paintBounds = await readGuest<{
      contentTop: number;
      contentHeight: number;
      width: number;
      height: number;
      maxWidth: number;
    }>(
      harness.application,
      directoryGuest,
      "directory",
      `(() => { const box = document.getElementById('fixture-directory').getBoundingClientRect(); return { contentTop: box.top, contentHeight: box.height, width: window.innerWidth, height: window.innerHeight, maxWidth: window.openai.maxWidth }; })()`,
    );
    expect(paintBounds.contentTop).toBe(5);
    expect(paintBounds.height - Math.ceil(paintBounds.contentHeight)).toBe(10);
    expect(paintBounds.maxWidth).toBe(paintBounds.width - 10);
    expect(Math.abs(initialHeight - Math.ceil(paintBounds.contentHeight))).toBeLessThanOrEqual(1);
    const threadViewport = page.locator(".thread-scroll-container").filter({
      has: page.locator('[data-local-conversation-transcript="true"]'),
    });
    const settleLayout = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
    const sampleWidgetViewport = async (phase: string) => {
      await settleLayout();
      const viewport = await threadViewport.evaluate((element) => ({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        bottomOffset: Math.max(0, -element.scrollTop),
        flexDirection: getComputedStyle(element).flexDirection,
      }));
      const wrapper = await visualization.boundingBox();
      if (!wrapper) throw new Error("Interactive response wrapper is not visible");
      const currentMode = await readGuest<string>(
        harness.application,
        directoryGuest,
        "directory",
        "window.openai.displayMode",
      );
      return { phase, viewport, wrapperTop: wrapper.y, wrapperHeight: wrapper.height, currentMode };
    };
    await clickGuestButton(harness.application, directoryGuest, "directory", "increment");
    const beforeExpansion = await sampleWidgetViewport("ordinary-before-expansion");
    expect(beforeExpansion.viewport.flexDirection).toBe("column-reverse");
    expect(beforeExpansion.viewport.bottomOffset).toBeLessThanOrEqual(1);
    expect(beforeExpansion.currentMode).toBe("inline");
    await clickGuestButton(harness.application, directoryGuest, "directory", "toggle");
    await expect
      .poll(async () => (await visualization.boundingBox())?.height ?? 0)
      .toBeGreaterThan(initialHeight + 400);
    const afterExpansion = await sampleWidgetViewport("ordinary-after-expansion");
    expect(afterExpansion.viewport.bottomOffset).toBeLessThanOrEqual(1);
    expect(afterExpansion.viewport.scrollHeight).toBeGreaterThan(
      beforeExpansion.viewport.scrollHeight,
    );
    expect(afterExpansion.wrapperTop).toBeLessThan(beforeExpansion.wrapperTop);
    expect(afterExpansion.currentMode).toBe("inline");
    await clickGuestButton(harness.application, directoryGuest, "directory", "toggle");
    await expect
      .poll(async () => (await visualization.boundingBox())?.height ?? 0)
      .toBeCloseTo(initialHeight, 0);
    const afterCollapse = await sampleWidgetViewport("ordinary-after-collapse");
    expect(afterCollapse.viewport.bottomOffset).toBeLessThanOrEqual(1);
    expect(Math.abs(afterCollapse.wrapperTop - beforeExpansion.wrapperTop)).toBeLessThanOrEqual(1);
    expect(afterCollapse.currentMode).toBe("inline");
    await testInfo.attach("ordinary-widget-viewport", {
      body: JSON.stringify([beforeExpansion, afterExpansion, afterCollapse], null, 2),
      contentType: "application/json",
    });
    await clickGuestButton(harness.application, directoryGuest, "directory", "toggle");
    await expect
      .poll(async () => (await visualization.boundingBox())?.height ?? 0)
      .toBeGreaterThan(initialHeight + 400);
    await expect
      .poll(() =>
        readGuest<string>(
          harness.application,
          directoryGuest,
          "directory",
          "document.getElementById('counter-directory').textContent",
        ),
      )
      .toBe("1");
    await clickGuestButton(harness.application, directoryGuest, "directory", "tool");
    await expect
      .poll(() =>
        readGuest<string>(
          harness.application,
          directoryGuest,
          "directory",
          "document.getElementById('tool-result-directory').textContent",
        ),
      )
      .toContain("cannot call tools");
    // A transformed containing block must not confine a fullscreen response to its Turn.
    const ancestor = await visualization.evaluateHandle((element) => {
      const row = element.closest<HTMLElement>("[data-turn-key]");
      if (!row) throw new Error("Interactive response has no Turn row");
      row.style.transform = "translateX(17px)";
      return row;
    });
    try {
      await visualization.getByRole("button", { name: "Open fullscreen", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Interactive response", exact: true });
      await expect(dialog).toBeVisible();
      for (const key of [
        "Tab",
        "Tab",
        "Tab",
        "Tab",
        "Shift+Tab",
        "Shift+Tab",
        "Shift+Tab",
        "Shift+Tab",
      ]) {
        await page.keyboard.press(key);
        await expect
          .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true);
      }
      const backgroundComposer = page
        .locator('[data-codex-composer="true"][contenteditable="true"]')
        .first();
      await expect
        .poll(() => backgroundComposer.evaluate((element) => Boolean(element.closest("[inert]"))))
        .toBe(true);
      expect(
        await backgroundComposer.evaluate((element) => {
          (element as HTMLElement).focus();
          return document.activeElement === element;
        }),
      ).toBe(false);
      const bounds = await dialog.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          rightInset: innerWidth - box.right,
          bottomInset: innerHeight - box.bottom,
        };
      });
      for (const inset of Object.values(bounds)) expect(inset).toBeCloseTo(0, 0);
      const previewBounds = await dialog
        .locator('webview[title="Interactive response"]')
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            centerX: box.left + box.width / 2,
            centerY: box.top + box.height / 2,
            viewportCenterX: innerWidth / 2,
            viewportCenterY: innerHeight / 2,
            width: box.width,
            viewportWidth: innerWidth,
            height: box.height,
          };
        });
      expect(Math.abs(previewBounds.centerX - previewBounds.viewportCenterX)).toBeLessThanOrEqual(
        3,
      );
      expect(Math.abs(previewBounds.centerY - previewBounds.viewportCenterY)).toBeLessThanOrEqual(
        3,
      );
      expect(previewBounds.width).toBeLessThan(previewBounds.viewportWidth * 0.8);
      expect(previewBounds.height).toBeGreaterThan(initialHeight + 400);
      expect(await guestIds(page)).toEqual(idsBeforeFullscreen);
      await clickGuestButton(harness.application, directoryGuest, "directory", "increment");
      await expect
        .poll(() =>
          readGuest<string>(
            harness.application,
            directoryGuest,
            "directory",
            "document.getElementById('counter-directory').textContent",
          ),
        )
        .toBe("2");
      await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        visualization.getByRole("button", { name: "Open fullscreen", exact: true }),
      ).toBeFocused();
      expect(await guestIds(page)).toEqual(idsBeforeFullscreen);
      await expect
        .poll(() =>
          readGuest<string>(
            harness.application,
            directoryGuest,
            "directory",
            "document.getElementById('counter-directory').textContent",
          ),
        )
        .toBe("2");
      await visualization.getByRole("button", { name: "Open fullscreen", exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.click({ position: { x: 4, y: 4 } });
      await expect(dialog).toHaveCount(0);
      expect(await guestIds(page)).toEqual(idsBeforeFullscreen);
      await expect(
        visualization.getByRole("button", { name: "Open fullscreen", exact: true }),
      ).toBeFocused();
      await expect
        .poll(() =>
          readGuest<string>(
            harness.application,
            directoryGuest,
            "directory",
            "document.getElementById('counter-directory').textContent",
          ),
        )
        .toBe("2");
    } finally {
      await ancestor.evaluate((element) => {
        element.style.removeProperty("transform");
      });
    }
    await writeFile(path.join(directory, "live-widget.html"), interactiveWidgetDocument("live"));
    const commandPath = path.join(stateDirectory, "commands.jsonl");
    await appendFile(commandPath, `${JSON.stringify({ type: "start" })}\n`);
    await expect(page.getByText("Stream baseline", { exact: true })).toBeVisible();
    await appendFile(
      commandPath,
      `${JSON.stringify({ type: "delta", delta: '\n\n::codex-inline-vis{file="live-widget.html"}\n\n' })}\n`,
    );
    const liveGuest = await findReadyGuest(harness.application, page, "live");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await testInfo.attach("live-widget-before-input", {
      body: JSON.stringify({
        host: await page.locator('[data-inline-visualization="true"]').evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            const guest = element.querySelector("webview");
            return {
              status: element.getAttribute("data-visualization-status"),
              bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
              guestId: guest
                ? (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
                : null,
            };
          }),
        ),
        guest: await readGuest(
          harness.application,
          liveGuest,
          "live",
          `(() => { const button = document.getElementById('increment-live'); const box = button.getBoundingClientRect(); return { button: {x:box.x,y:box.y,width:box.width,height:box.height},width:innerWidth,height:innerHeight,pointTarget:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.id,readyState:document.readyState }; })()`,
        ),
      }),
      contentType: "application/json",
    });
    await clickGuestButton(harness.application, liveGuest, "live", "increment");
    await expect
      .poll(() =>
        readGuest<string>(
          harness.application,
          liveGuest,
          "live",
          "document.getElementById('counter-live').textContent",
        ),
      )
      .toBe("1");
    await appendFile(commandPath, `${JSON.stringify({ type: "complete" })}\n`);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await guestIds(page)).includes(liveGuest)).toBe(true);
    await expect
      .poll(() =>
        readGuest<string>(
          harness.application,
          liveGuest,
          "live",
          "document.getElementById('counter-live').textContent",
        ),
      )
      .toBe("1");
    await clickGuestButton(harness.application, liveGuest, "live", "helpers");
    const readLive = <T>(expression: string) =>
      readGuest<T>(harness.application, liveGuest, "live", expression);
    await expect
      .poll(() =>
        readLive<boolean>(
          "document.getElementById('calendar-live').shadowRoot?.querySelectorAll('button[data-event-index]').length === 2",
        ),
      )
      .toBe(true);
    await expect
      .poll(() => readLive<boolean>("document.getElementById('panel-second-live').hidden"))
      .toBe(true);
    await clickGuestButton(harness.application, liveGuest, "live", "tab-second");
    await expect
      .poll(() =>
        readLive<boolean>(
          "document.getElementById('panel-first-live').hidden && !document.getElementById('panel-second-live').hidden",
        ),
      )
      .toBe(true);
    await clickGuestButton(harness.application, liveGuest, "live", "carousel", {
      selector: '#carousel-live button[aria-label="Next variant"]',
    });
    await testInfo.attach("carousel-native-input", {
      body: JSON.stringify(
        await readLive(
          `(() => { const button = document.querySelector('#carousel-live button[aria-label="Next variant"]'); const box = button.getBoundingClientRect(); return { button: {x:box.x,y:box.y,width:box.width,height:box.height},viewport: {width:innerWidth,height:innerHeight},target:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.outerHTML,variants:Array.from(document.querySelectorAll('#carousel-live > [data-variant]')).map(element=>({name:element.dataset.variant,hidden:element.hidden}))}; })()`,
        ),
      ),
      contentType: "application/json",
    });
    await expect
      .poll(() =>
        readLive<boolean>(
          "document.querySelector('#carousel-live > [data-variant=One]').hidden && !document.querySelector('#carousel-live > [data-variant=Two]').hidden",
        ),
      )
      .toBe(true);
    await clickGuestButton(harness.application, liveGuest, "live", "calendar", {
      shadowSelector: 'button[data-event-index="0"]',
    });
    await expect
      .poll(() => readLive<string>("document.getElementById('calendar-result-live').textContent"))
      .toBe("0");
    await expect
      .poll(
        () =>
          readLive<boolean>(
            "document.getElementById('icon-live')?.tagName.toLowerCase() === 'svg'",
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await clickGuestButton(harness.application, liveGuest, "live", "tooltip", { click: false });
    await expect
      .poll(() => readLive<string>("document.querySelector('[role=tooltip]')?.textContent ?? ''"))
      .toBe("Helpful detail");
    await clickGuestButton(harness.application, liveGuest, "live", "state");
    await expect
      .poll(() =>
        readLive<boolean>(
          "JSON.parse(document.getElementById('state-result-live').textContent)?.selected === 2",
        ),
      )
      .toBe(true);

    const downloadPath = path.join(harness.profile.runRoot, "artifacts", "widget-data.txt");
    await mkdir(path.dirname(downloadPath), { recursive: true });
    await harness.application.evaluate(({ session }, filename) => {
      session.defaultSession.on("will-download", (_event, item) => {
        if (item.getFilename() === "widget-data.txt") item.setSavePath(filename);
      });
    }, downloadPath);
    await clickGuestButton(harness.application, liveGuest, "live", "download");
    await expect
      .poll(async () => await readFile(downloadPath, "utf8").catch(() => ""), { timeout: 20_000 })
      .toBe("widget download bytes");

    const descriptor = await page
      .locator('webview[title="Interactive response"]')
      .evaluateAll((elements, id) => {
        const element = elements.find(
          (candidate) =>
            (candidate as unknown as { getWebContentsId(): number }).getWebContentsId() === id,
        );
        if (!element) throw new Error("Native response surface was released");
        const box = element.getBoundingClientRect();
        return {
          partition: element.getAttribute("partition") ?? "",
          src: element.getAttribute("src") ?? "",
          width: box.width,
          height: box.height,
        };
      }, liveGuest);
    const sandboxId = parseMcpAppSandboxPartition(descriptor.partition);
    const initId = parseMcpAppSandboxSourceUrl(descriptor.src)?.initId;
    if (!sandboxId || !initId) throw new Error("Native response has no capture identity");
    const capture = await page.evaluate(
      async (input) => {
        const bytes = await window.api?.invoke("codex:visualization:capture-image", input);
        if (!(bytes instanceof Uint8Array)) throw new Error("Invalid native response image");
        const data = new Uint8Array(bytes);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return {
          signature: Array.from(data.subarray(0, 8)),
          width: view.getUint32(16),
          height: view.getUint32(20),
          byteLength: data.byteLength,
        };
      },
      {
        sandboxId,
        initId,
        captureRect: { x: 5, y: 5, width: descriptor.width - 10, height: descriptor.height - 10 },
        viewportSize: { width: descriptor.width, height: descriptor.height },
      },
    );
    expect(capture.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(capture.width).toBeGreaterThan(0);
    expect(capture.height).toBeGreaterThan(0);
    expect(capture.byteLength).toBeGreaterThan(1000);
    await testInfo.attach("native-response-capture", {
      body: JSON.stringify(capture),
      contentType: "application/json",
    });
    expect(await guestIds(page)).toContain(liveGuest);

    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    const restoredGuest = await findReadyGuest(harness.application, page, "live");
    expect(restoredGuest).not.toBe(liveGuest);
    expect(
      await harness.application.evaluate(
        ({ webContents }, id) => !webContents.fromId(id) || webContents.fromId(id)!.isDestroyed(),
        liveGuest,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        readGuest<boolean>(
          harness.application,
          restoredGuest,
          "live",
          "window.openai.widgetState?.selected === 2 && window.openai.statePersistence === 'host' && window.openai.stateModelContext === 'untrusted'",
        ),
      )
      .toBe(true);
    expect(
      await readGuest<string>(
        harness.application,
        restoredGuest,
        "live",
        "document.getElementById('counter-live').textContent",
      ),
    ).toBe("0");
    const requestPath = path.join(stateDirectory, "requests.jsonl");
    const readRequests = async (): Promise<{ method: string; params: Record<string, unknown> }[]> =>
      (await readFile(requestPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const submitFollowUp = async (prompt: string) => {
      const composer = page.locator('[data-codex-composer="true"][contenteditable="true"]').first();
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      await expect(page.getByText(prompt, { exact: true })).toBeVisible();
      await expect
        .poll(async () =>
          (await readRequests()).some(
            (record) =>
              record.method === "turn/start" &&
              JSON.stringify(record.params.input).includes(prompt),
          ),
        )
        .toBe(true);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    };
    const beforeFollowUp = (await readRequests()).length;
    await submitFollowUp("Use the saved interactive selection");
    const afterFirstFollowUp = (await readRequests()).slice(beforeFollowUp);
    const injectedIndex = afterFirstFollowUp.findIndex(
      (record) => record.method === "injection-held",
    );
    const startIndex = afterFirstFollowUp.findIndex((record) => record.method === "turn/start");
    expect(injectedIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(injectedIndex);
    const injected = afterFirstFollowUp[injectedIndex]!.params;
    const releasedIndex = afterFirstFollowUp.findIndex(
      (record) =>
        record.method === "injection-released" && record.params.requestId === injected.requestId,
    );
    expect(releasedIndex).toBeGreaterThan(injectedIndex);
    expect(startIndex).toBeGreaterThan(releasedIndex);
    expect(afterFirstFollowUp.filter((record) => record.method === "injection-held")).toHaveLength(
      1,
    );
    expect(injected.threadId).toBe(nativeThreadId);
    expect(injected.items).toEqual([
      {
        type: "function_call",
        name: "untrusted_input",
        arguments: "{}",
        call_id: expect.any(String),
      },
      {
        type: "function_call_output",
        call_id: expect.any(String),
        output: [
          {
            type: "input_text",
            text: JSON.stringify({
              path: path.join(directory, "live-widget.html"),
              state: { selected: 2 },
            }),
          },
        ],
      },
    ]);
    if (!Array.isArray(injected.items)) throw new Error("Native context has no response items");
    expect(injected.items[0].call_id).toBe(injected.items[1].call_id);
    expect(JSON.stringify(injected.items)).not.toContain("excluded-from-model");
    const beforeSecondFollowUp = (await readRequests()).length;
    await submitFollowUp("Keep using the saved selection");
    expect(
      (await readRequests())
        .slice(beforeSecondFollowUp)
        .filter((record) => record.method === "injection-held"),
    ).toHaveLength(0);
    await testInfo.attach("passive-widget-context", {
      body: JSON.stringify({
        injectedBeforeStart: true,
        confirmedBeforeStart: true,
        savedState: { selected: 2 },
        repeatedInjectionCount: 0,
        privateStateExcluded: true,
      }),
      contentType: "application/json",
    });
    const idsBeforeRelease = await guestIds(page);
    await page
      .getByRole("button", { name: "Start new chat in Interactive responses", exact: true })
      .click();
    await expect(page.locator('webview[title="Interactive response"]')).toHaveCount(0);
    await expect
      .poll(() =>
        harness.application.evaluate(
          ({ webContents }, ids) =>
            ids.every((id) => {
              const guest = webContents.fromId(id);
              return !guest || guest.isDestroyed();
            }),
          [...idsBeforeRelease, directoryGuest, workspaceGuest, liveGuest],
        ),
      )
      .toBe(true);
    await writeFile(
      path.join(artifactDirectory, "widget-native-result.json"),
      `${JSON.stringify(
        {
          runId: process.env.NODEX_TRANSCRIPT_REVIEW_RUN_ID ?? null,
          paintBounds,
          beforeExpansion,
          afterExpansion,
          capture,
          download: { name: "widget-data.txt", contents: "widget download bytes" },
          state: { selected: 2, persistence: "host", modelContext: "untrusted" },
          passiveContext: {
            injectedBeforeStart: true,
            confirmedBeforeStart: true,
            repeatedInjectionCount: 0,
            privateStateExcluded: true,
          },
          originalGuestId: liveGuest,
          restoredGuestId: restoredGuest,
          releasedGuestIds: [
            ...new Set([...idsBeforeRelease, directoryGuest, workspaceGuest, liveGuest]),
          ],
          sameGuestFullscreenAndCompletion: true,
          defaultHelpers: ["calendar", "tabs", "carousel", "tooltip", "icons"],
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    failed = true;
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
