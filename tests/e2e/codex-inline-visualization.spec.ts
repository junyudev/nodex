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
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";

const widgetDocument = (id: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:16px sans-serif;background:white;color:#222}.content{padding:20px;min-height:140px}button{font:inherit}section{height:540px;background:#eef2f6;margin-top:16px}</style></head><body><main class="content" id="fixture-${id}"><button id="toggle-${id}">Show details</button><button id="increment-${id}">Increment</button><button id="tool-${id}">Try tool</button><output id="counter-${id}" aria-label="Interaction count">0</output><div role="status" id="tool-result-${id}" aria-label="Tool result">Pending</div><section id="details-${id}" hidden>Expanded content</section></main><script>let count=0;document.getElementById('increment-${id}').addEventListener('click',()=>{document.getElementById('counter-${id}').textContent=String(++count)});document.getElementById('toggle-${id}').addEventListener('click',()=>{const detail=document.getElementById('details-${id}');detail.hidden=!detail.hidden});document.getElementById('tool-${id}').addEventListener('click',async()=>{const result=document.getElementById('tool-result-${id}');if(typeof window.openai?.callTool!=='function'){result.textContent='API unavailable';return}try{await window.openai.callTool('ungranted_tool',{});result.textContent='Tool accepted'}catch(error){result.textContent=String(error?.message??error)}});</script></body></html>`;

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

async function findGuest(
  application: ElectronApplication,
  page: Page,
  fixtureId: string,
): Promise<number> {
  let found: number | null = null;
  await expect
    .poll(
      async () => {
        for (const id of await guestIds(page)) {
          const ready = await readGuest<boolean>(
            application,
            id,
            fixtureId,
            "typeof window.openai?.callTool === 'function'",
          ).catch(() => false);
          if (!ready) continue;
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
) {
  await application.evaluate(
    async ({ webContents }, input) => {
      const guest = webContents.fromId(input.guestId);
      if (!guest || guest.isDestroyed()) throw new Error("Interactive response guest was released");
      for (const frame of guest.mainFrame.framesInSubtree) {
        const point = (await frame
          .executeJavaScript(
            `(() => { const marker = document.getElementById(${JSON.stringify(`fixture-${input.fixtureId}`)}); const button = document.getElementById(${JSON.stringify(`${input.button}-${input.fixtureId}`)}); if (!marker || !button) return null; const box = button.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
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
    { guestId, fixtureId, button },
  );
}

test("restores interactive HTML responses and retains guest state through fullscreen and release", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const nativeThreadId = createUuidV7();
  const harness = await ElectronScenarioHarness.create({
    label: "codex-inline-visualization",
    codex: "empty",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_FAKE_CODEX_THREAD_ID: nativeThreadId,
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "120",
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
    const directoryGuest = await findGuest(harness.application, page, "directory");
    const workspaceGuest = await findGuest(harness.application, page, "workspace");
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
    await writeFile(path.join(directory, "live-widget.html"), widgetDocument("live"));
    const commandPath = path.join(stateDirectory, "commands.jsonl");
    await appendFile(commandPath, `${JSON.stringify({ type: "start" })}\n`);
    await expect(page.getByText("Stream baseline", { exact: true })).toBeVisible();
    await appendFile(
      commandPath,
      `${JSON.stringify({ type: "delta", delta: '\n\n::codex-inline-vis{file="live-widget.html"}\n\n' })}\n`,
    );
    const liveGuest = await findGuest(harness.application, page, "live");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
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
          [directoryGuest, workspaceGuest, liveGuest],
        ),
      )
      .toBe(true);
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
