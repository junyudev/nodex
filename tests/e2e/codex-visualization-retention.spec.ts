import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
  openNodexWindow,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { resolveCodexThreadVisualizationDirectory } from "../../src/main/codex/codex-dynamic-first-turn-context";
import {
  parseMcpAppSandboxPartition,
  parseMcpAppSandboxSourceUrl,
} from "../../src/shared/mcp-app/mcp-app-sandbox-contract";
import type { NativeSessionCatalogPage } from "../../src/shared/native-session-catalog";
import type { ProjectSession } from "../../src/shared/types";
import { invokeIpc } from "./support/agent-smoke-harness";
import { seedNativeHistoryBinding } from "./support/native-history-binding";
import { nativeReadOnlyBenchmarkEnvironment } from "./support/native-transcript-benchmark-preflight";
import {
  resolveNativeVisualizationFixtureRuntime,
  seedNativeVisualizationHistory,
} from "./support/native-visualization-history-fixture";
import { readOwnedWidget, clickOwnedWidget } from "./support/owned-inline-visualization-guest";

const documentFor = (label: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif;background:white;color:#222}main{padding:20px;min-height:180px}button{padding:8px}section{height:380px}</style></head><body><main id="retained-fixture"><strong>${label}</strong><button id="counter">Increment</button><output id="count">0</output><button id="toggle">Details</button><section id="details" hidden>Expanded body</section><button id="sdk">Try tool</button><output id="sdk-result"></output><output id="nonce"></output></main><script>window.retainedHtmlRuns=(window.retainedHtmlRuns??0)+1;let count=0;document.getElementById('nonce').textContent=crypto.randomUUID();document.getElementById('counter').addEventListener('click',()=>document.getElementById('count').textContent=String(++count));document.getElementById('toggle').addEventListener('click',()=>document.getElementById('details').hidden=!document.getElementById('details').hidden);document.getElementById('sdk').addEventListener('click',async()=>{try{await window.openai.callTool('ungranted_tool',{});document.getElementById('sdk-result').textContent='accepted'}catch{document.getElementById('sdk-result').textContent='denied'}});</script></body></html>`;

interface GuestEvidence {
  readonly id: number;
  readonly frameId: string;
  readonly partition: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
}
interface NativeFocusEvent {
  readonly at: number;
  readonly type: string;
  readonly id: number;
  readonly focusedWindowId: number | null;
  readonly focusedContentsId: number | null;
}
interface OwnerFocusObservation {
  readonly target: Element;
  readonly controller: AbortController;
  readonly events: Array<{ readonly tag: string; readonly target: boolean }>;
}
async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function activeGuests(page: Page): Promise<GuestEvidence[]> {
  return await page
    .locator(
      '[data-inline-visualization="true"][data-visualization-active="true"][data-visualization-status="ready"] webview',
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const root = element.closest('[data-inline-visualization="true"]')!;
        const bounds = element.getBoundingClientRect();
        return {
          id: (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
          frameId: root.getAttribute("data-visualization-frame-id")!,
          partition: element.getAttribute("partition")!,
          src: element.getAttribute("src")!,
          width: bounds.width,
          height: bounds.height,
        };
      }),
    );
}
async function state(application: ElectronApplication, id: number) {
  return await readOwnedWidget<{ nonce: string; count: number; api: boolean; htmlRuns: number }>(
    application,
    id,
    "retained-fixture",
    "({nonce:document.getElementById('nonce').textContent,count:Number(document.getElementById('count').textContent),api:typeof window.openai?.callTool==='function',htmlRuns:window.retainedHtmlRuns})",
  );
}
async function focusEvidence(application: ElectronApplication, id: number) {
  return await application.evaluate(
    ({ webContents }, guestId) => ({
      guest: webContents.fromId(guestId)?.isFocused() ?? false,
      owner: webContents.getFocusedWebContents()?.getType() ?? null,
    }),
    id,
  );
}

async function preparedGuest(page: Page, application: ElectronApplication) {
  const spare = page.locator('webview[data-inline-visualization-standby="ready"]');
  await expect(spare).toHaveCount(1, { timeout: 30_000 });
  const allStandbys = page.locator("webview[data-inline-visualization-standby]");
  expect(await allStandbys.count()).toBe(1);
  const identity = await spare.evaluate((element) => ({
    id: (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
    src: element.getAttribute("src")!,
    partition: element.getAttribute("partition")!,
  }));
  const metadata = await application.evaluate(async ({ webContents }, input) => {
    const guest = webContents.fromId(input.id);
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.getType() !== "webview" ||
      guest.getURL() !== input.src
    )
      throw new Error("The prepared guest does not belong to this scenario");
    const timeOrigin: unknown = await guest.mainFrame.executeJavaScript("performance.timeOrigin");
    const frames = guest.mainFrame.framesInSubtree;
    const frameStates = await Promise.all(
      frames.map(async (frame) => {
        const authored: unknown = await frame.executeJavaScript(
          "Boolean(document.getElementById('retained-fixture'))||typeof window.retainedHtmlRuns==='number'",
        );
        const focused: unknown = await frame.executeJavaScript("document.hasFocus()");
        if (typeof authored !== "boolean" || typeof focused !== "boolean")
          throw new Error("Invalid prepared frame metadata");
        return { authored, focused };
      }),
    );
    if (typeof timeOrigin !== "number") throw new Error("Invalid prepared guest metadata");
    return {
      timeOrigin,
      frameCount: frames.length,
      authored: frameStates.some((frame) => frame.authored),
      focused: frameStates.some((frame) => frame.focused),
    };
  }, identity);
  expect(metadata.authored).toBe(false);
  return { ...identity, ...metadata };
}

async function nativeGuestTimeOrigin(application: ElectronApplication, id: number) {
  return await application.evaluate(async ({ webContents }, guestId) => {
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview")
      throw new Error("Owned native guest is unavailable");
    const value: unknown = await guest.mainFrame.executeJavaScript("performance.timeOrigin");
    if (typeof value !== "number") throw new Error("Invalid native guest clock");
    return value;
  }, id);
}

// Focuses an element of the owner page with a real click on `pointer` (the target itself by
// default) and records every later focus change inside the page.
async function focusOwner(
  page: Page,
  application: ElectronApplication,
  target: Locator,
  pointer: Locator = target,
) {
  const ownerWindow = await application.browserWindow(page);
  const ownerId = await ownerWindow.evaluate((window) => {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    return window.webContents.id;
  });
  // Another application may take activation back while the test runs, so keep asking until the
  // owner window is key; the page keeps its focused element across activation changes.
  const activate = () =>
    application.evaluate(({ app, BrowserWindow, webContents }, id) => {
      const owner = webContents.fromId(id);
      if (!owner || owner.isDestroyed()) throw new Error("Owned contents is unavailable");
      if (owner.isFocused()) return true;
      app.focus({ steal: true });
      BrowserWindow.fromWebContents(owner)?.focus();
      owner.focus();
      return false;
    }, ownerId);
  await activate();
  await pointer.click();
  await expect(target).toBeFocused();
  await expect.poll(activate).toBe(true);
  await expect(target).toBeFocused();
  await target.evaluate((element) => {
    const state = window as typeof window & {
      retainedOwnerFocus?: OwnerFocusObservation;
    };
    state.retainedOwnerFocus?.controller.abort();
    const observation: OwnerFocusObservation = {
      target: element,
      controller: new AbortController(),
      events: [],
    };
    state.retainedOwnerFocus = observation;
    document.addEventListener(
      "focusin",
      (event) => {
        observation.events.push({
          tag: event.target instanceof Element ? event.target.tagName : "unknown",
          target: event.target === element,
        });
      },
      { capture: true, signal: observation.controller.signal },
    );
  });
  const eventIndex = await application.evaluate(
    () =>
      (globalThis as typeof globalThis & { retainedFocusEvents?: NativeFocusEvent[] })
        .retainedFocusEvents?.length ?? 0,
  );
  return { target, ownerId, eventIndex };
}

async function assertStandbyPreservesFocus(
  application: ElectronApplication,
  focus: Awaited<ReturnType<typeof focusOwner>>,
  spareId: number,
) {
  await expect(focus.target).toBeFocused();
  const dom = await focus.target.evaluate((element) => {
    const observation = (
      window as typeof window & {
        retainedOwnerFocus?: OwnerFocusObservation;
      }
    ).retainedOwnerFocus;
    if (!observation) throw new Error("Owner focus observation is unavailable");
    return {
      sameElement: observation.target === element && element.isConnected,
      focused: document.activeElement === observation.target,
      events: observation.events,
    };
  });
  expect(dom.sameElement && dom.focused).toBe(true);
  expect(dom.events.filter((event) => !event.target)).toEqual([]);
  const native = await application.evaluate(
    ({ BrowserWindow, webContents }, input) => {
      const owner = webContents.fromId(input.ownerId);
      if (!owner || owner.isDestroyed()) throw new Error("Owned contents is unavailable");
      const window = BrowserWindow.fromWebContents(owner);
      if (!window || window.isDestroyed()) throw new Error("Owned window is unavailable");
      return {
        windowFocused: window.isFocused(),
        focusedId: webContents.getFocusedWebContents()?.id ?? null,
        ownerFocused: owner.isFocused(),
        spareFocused: webContents.fromId(input.spareId)?.isFocused() ?? false,
        events:
          (
            globalThis as typeof globalThis & { retainedFocusEvents?: NativeFocusEvent[] }
          ).retainedFocusEvents?.slice(input.eventIndex) ?? [],
      };
    },
    { ownerId: focus.ownerId, spareId, eventIndex: focus.eventIndex },
  );
  // macOS reports no focused contents while the owner window is not key.
  // Child-frame isFocused/hasFocus proxies the root view, and the global getter
  // prefers webviews. DOM identity and focus events provide the exclusive check.
  if (!native.windowFocused) expect(native.focusedId).toBeNull();
  expect(native.ownerFocused).toBe(native.windowFocused);
  expect(
    native.events.filter((event) => event.type === "contents-focus" && event.id !== focus.ownerId),
  ).toEqual([]);
  return { ...native, dom };
}

test("retains native HTML guests across real Thread navigation and releases deleted Thread guests", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const repositoryRoot = path.resolve(".");
  const runtime = await resolveNativeVisualizationFixtureRuntime(repositoryRoot);
  const harness = await ElectronScenarioHarness.create({
    label: "codex-visualization-retention",
    // Guest focus follows real window activation.
    windows: "foreground",
    codex: "empty",
    // The real connection requires an account even for history; no Turn uses this synthetic key.
    codexApiKey: "nodex-read-only-history-test-key",
    cwd: repositoryRoot,
    prepareAgentRuntime: false,
    environment: nativeReadOnlyBenchmarkEnvironment(process.env),
  });
  const auth = path.join(harness.profile.codexHome, "auth.json");
  let page: Page | null = null;
  const nativeFixtures: Awaited<ReturnType<typeof seedNativeVisualizationHistory>>[] = [];
  let evidence: object | null = null;
  const rendererErrors: string[] = [];
  try {
    expect(await exists(auth)).toBe(false);
    const workspace = harness.profile.initialProjectsDirectory;
    for (const label of ["A", "B"] as const) {
      const fixture = await seedNativeVisualizationHistory({
        executable: runtime.executable,
        codexHome: harness.profile.codexHome,
        cwd: workspace,
        title: `Retained HTML ${label}`,
        turnId: `retained-history-${label}`,
        answer:
          label === "A"
            ? '::codex-inline-vis{file="retained.html" mode="wide"}\n\n::codex-inline-vis{file="retained.html" mode="wide"}'
            : '::codex-inline-vis{file="retained.html" mode="wide"}',
      });
      nativeFixtures.push(fixture);
      const directory = resolveCodexThreadVisualizationDirectory(
        harness.profile.codexHome,
        fixture.threadId,
      );
      if (!directory) throw new Error("Native Thread has no visualization directory");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "retained.html"), documentFor(label));
    }
    page = await harness.launch();
    page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));
    await harness.application.evaluate(({ app, BrowserWindow, webContents }) => {
      const state = globalThis as typeof globalThis & {
        retainedFocusEvents?: NativeFocusEvent[];
      };
      state.retainedFocusEvents = [];
      const record = (type: string, id: number) => {
        state.retainedFocusEvents!.push({
          at: Date.now(),
          type,
          id,
          focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
          focusedContentsId: webContents.getFocusedWebContents()?.id ?? null,
        });
      };
      app.on("browser-window-focus", (_event, window) => record("window-focus", window.id));
      app.on("browser-window-blur", (_event, window) => record("window-blur", window.id));
      const observe = (contents: Electron.WebContents) => {
        contents.on("focus", () => record("contents-focus", contents.id));
        contents.on("blur", () => record("contents-blur", contents.id));
        contents.on("did-finish-load", () => record("contents-loaded", contents.id));
      };
      for (const contents of webContents.getAllWebContents()) observe(contents);
      app.on("web-contents-created", (_event, contents) => observe(contents));
    });
    expect(await invokeIpc(page, "codex:connection:status")).toMatchObject({
      status: "connected",
    });
    expect(await invokeIpc(page, "codex:account:read")).toMatchObject({
      account: { type: "apiKey" },
    });
    await harness.application.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length !== 1) throw new Error("Retention fixture requires one owned window");
      windows[0]!.setBounds({ x: 0, y: 0, width: 1400, height: 900 });
    });
    const catalog = (await invokeIpc(page, "native-sessions:list", {
      backendKind: "codex",
    })) as NativeSessionCatalogPage;
    expect(path.resolve(catalog.nativeHome)).toBe(path.resolve(harness.profile.codexHome));
    const sessions: ProjectSession[] = [];
    for (const fixture of nativeFixtures) {
      const entry = catalog.entries.find(
        (candidate) => candidate.nativeSessionId === fixture.threadId,
      );
      if (!entry) throw new Error("Native visualization fixture was not found in the catalog.");
      const attached = await seedNativeHistoryBinding(harness.profile, catalog.nativeHome, entry);
      expect(attached.threadId).toBe(fixture.threadId);
      const session = (await invokeIpc(
        page,
        "project-sessions:get",
        attached.sessionId,
      )) as ProjectSession;
      expect(session.thread?.threadId).toBe(fixture.threadId);
      sessions.push(session);
    }
    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    // A launch opens no chat; the first standby is prepared while a new chat's Composer has focus.
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const initialFocus = await focusOwner(
      page,
      harness.application,
      page.locator('[data-codex-composer="true"][contenteditable="true"]').first(),
    );
    const initialSpare = await preparedGuest(page, harness.application);
    const initialNativeFocus = await assertStandbyPreservesFocus(
      harness.application,
      initialFocus,
      initialSpare.id,
    );
    // Attached native history is read-only, so later standbys are prepared while the reader
    // has focused the conversation itself.
    const focusConversation = async (index: number) => {
      const title = sessions[index]!.displayTitle;
      const conversation = page!
        .getByRole("region", { name: "Conversation", exact: true })
        .filter({ hasText: title });
      return await focusOwner(
        page!,
        harness.application,
        conversation,
        conversation.getByText(title, { exact: true }).first(),
      );
    };
    const navigate = async (index: number, count: number) => {
      await page!.getByText(sessions[index]!.displayTitle, { exact: true }).first().click();
      await expect
        .poll(async () => (await activeGuests(page!)).length, { timeout: 60_000 })
        .toBe(count);
      await page!.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      return await activeGuests(page!);
    };
    const a = await navigate(0, 2);
    expect(a[0]!.id).not.toBe(a[1]!.id);
    const claimedA = a.find((guest) => guest.id === initialSpare.id);
    expect(claimedA).toBeDefined();
    expect(claimedA!.src).toBe(initialSpare.src);
    expect(claimedA!.partition).toBe(initialSpare.partition);
    expect(await nativeGuestTimeOrigin(harness.application, claimedA!.id)).toBe(
      initialSpare.timeOrigin,
    );
    const replacementFocus = await focusConversation(0);
    const replacementSpare = await preparedGuest(page, harness.application);
    expect(replacementSpare.id).not.toBe(initialSpare.id);
    const replacementNativeFocus = await assertStandbyPreservesFocus(
      harness.application,
      replacementFocus,
      replacementSpare.id,
    );
    const nonceA = await state(harness.application, a[0]!.id);
    const nonceOther = await state(harness.application, a[1]!.id);
    expect(nonceA.nonce).not.toBe(nonceOther.nonce);
    expect(nonceA.htmlRuns).toBe(1);
    expect(nonceOther.htmlRuns).toBe(1);
    expect(nonceA.api && nonceOther.api).toBe(true);
    await clickOwnedWidget(harness.application, a[0]!.id, "retained-fixture", "#toggle");
    await expect
      .poll(
        async () =>
          (await page!.locator(`[data-visualization-frame-id="${a[0]!.frameId}"]`).boundingBox())!
            .height,
      )
      .toBeGreaterThan(380);
    await clickOwnedWidget(harness.application, a[0]!.id, "retained-fixture", "#counter");
    await clickOwnedWidget(harness.application, a[1]!.id, "retained-fixture", "#counter");
    await clickOwnedWidget(harness.application, a[1]!.id, "retained-fixture", "#counter");
    await expect.poll(async () => (await state(harness.application, a[0]!.id)).count).toBe(1);
    await expect.poll(async () => (await state(harness.application, a[1]!.id)).count).toBe(2);
    const heightA = (await page
      .locator(`[data-visualization-frame-id="${a[0]!.frameId}"]`)
      .boundingBox())!.height;
    const focusBefore = await focusEvidence(harness.application, a[1]!.id);
    const b = (await navigate(1, 1))[0]!;
    expect(b.id).toBe(replacementSpare.id);
    expect(b.src).toBe(replacementSpare.src);
    expect(b.partition).toBe(replacementSpare.partition);
    expect(await nativeGuestTimeOrigin(harness.application, b.id)).toBe(
      replacementSpare.timeOrigin,
    );
    const finalFocus = await focusConversation(1);
    const finalSpare = await preparedGuest(page, harness.application);
    expect(finalSpare.id).not.toBe(initialSpare.id);
    expect(finalSpare.id).not.toBe(replacementSpare.id);
    const finalNativeFocus = await assertStandbyPreservesFocus(
      harness.application,
      finalFocus,
      finalSpare.id,
    );
    expect((await state(harness.application, b.id)).htmlRuns).toBe(1);
    await expect(page.locator(`[data-visualization-frame-id="${a[0]!.frameId}"]`)).toHaveAttribute(
      "data-visualization-active",
      "false",
    );
    expect((await state(harness.application, a[0]!.id)).nonce).toBe(nonceA.nonce);
    const focusInactive = await focusEvidence(harness.application, a[1]!.id);
    await harness.application.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest || guest.isDestroyed()) throw new Error("Inactive guest was released prematurely");
      guest.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }, a[1]!.id);
    const inactiveDirectInput = await state(harness.application, a[1]!.id);
    const sandboxId = parseMcpAppSandboxPartition(a[0]!.partition);
    const initId = parseMcpAppSandboxSourceUrl(a[0]!.src)?.initId;
    if (!sandboxId || !initId) throw new Error("Guest has no typed presentation identity");
    expect(
      await invokeIpc(page, "codex:visualization:consume-gesture", { sandboxId, initId }),
    ).toBe(false);
    await expect(
      invokeIpc(page, "codex:visualization:capture-image", {
        sandboxId,
        initId,
        captureRect: { x: 5, y: 5, width: a[0]!.width - 10, height: a[0]!.height - 10 },
        viewportSize: { width: a[0]!.width, height: a[0]!.height },
      }),
    ).rejects.toThrow();
    // The resource query expires after 15 seconds; live guest retention has a separate owner.
    await page.waitForTimeout(16_001);
    expect((await state(harness.application, a[0]!.id)).nonce).toBe(nonceA.nonce);
    const returned = await navigate(0, 2);
    expect(returned.map((guest) => guest.id).sort((left, right) => left - right)).toEqual(
      a.map((guest) => guest.id).sort((left, right) => left - right),
    );
    expect(await state(harness.application, a[0]!.id)).toEqual({ ...nonceA, count: 1 });
    expect(await state(harness.application, a[1]!.id)).toEqual({
      ...nonceOther,
      count: inactiveDirectInput.count,
    });
    expect(
      Math.abs(
        (await page.locator(`[data-visualization-frame-id="${a[0]!.frameId}"]`).boundingBox())!
          .height - heightA,
      ),
    ).toBeLessThanOrEqual(1);
    await clickOwnedWidget(harness.application, a[0]!.id, "retained-fixture", "#sdk");
    await expect
      .poll(() =>
        readOwnedWidget(
          harness.application,
          a[0]!.id,
          "retained-fixture",
          "document.getElementById('sdk-result').textContent",
        ),
      )
      .toBe("denied");
    await clickOwnedWidget(harness.application, a[0]!.id, "retained-fixture", "#counter");
    await expect.poll(async () => (await state(harness.application, a[0]!.id)).count).toBe(2);
    expect((await state(harness.application, a[0]!.id)).htmlRuns).toBe(1);
    expect((await state(harness.application, a[1]!.id)).htmlRuns).toBe(1);
    const retentionEvidence = {
      runtime,
      nativeFixtures,
      retainedA: a,
      standby: {
        initialSpare,
        replacementSpare,
        finalSpare,
        initialNativeFocus,
        replacementNativeFocus,
        finalNativeFocus,
        unchangedNativeNavigation: true,
        capacityAtEachReadyObservation: 1,
      },
      returnedA: returned,
      stateA: await state(harness.application, a[0]!.id),
      stateOther: await state(harness.application, a[1]!.id),
      heightA,
      focusBefore,
      focusInactive,
      inactiveDirectInput,
      inputBoundary: "owned guest direct-target input; OS routing is not inferred",
      sameNativeIds: true,
      noAuthCopy: true,
      authentication: "public synthetic apiKey login; no model execution",
      noModelTurn: true,
    };
    evidence = retentionEvidence;
    expect(await invokeIpc(page, "codex:thread:archive", nativeFixtures[1]!.threadId)).toBe(true);
    expect(await invokeIpc(page, "codex:thread:delete-archived", nativeFixtures[1]!.threadId)).toBe(
      true,
    );
    await expect
      .poll(() =>
        harness.application.evaluate(
          ({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true,
          b.id,
        ),
      )
      .toBe(true);
    expect(
      (await activeGuests(page)).map((guest) => guest.id).sort((left, right) => left - right),
    ).toEqual(a.map((guest) => guest.id).sort((left, right) => left - right));
    expect(rendererErrors).toEqual([]);
    evidence = {
      ...retentionEvidence,
      deletedB: b,
      deletionVerified: true,
      rendererErrors,
    };
    const guestsBeforeClose = await page
      .locator('webview[title="Interactive response"]')
      .evaluateAll((elements) =>
        elements.map((element) =>
          (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
        ),
      );
    expect([...guestsBeforeClose].sort((left, right) => left - right)).toEqual(
      [...a.map((guest) => guest.id), finalSpare.id].sort((left, right) => left - right),
    );
    const opener = page;
    // Another window keeps the app running while this one closes.
    await openNodexWindow(harness.application, async () => {
      expect(
        await invokeIpc(opener, "window:new", {
          activeProjectId: sessions[0]!.projectId,
          activeProjectSessionId: null,
        }),
      ).toBe(true);
    });
    const closed = page.waitForEvent("close");
    const ownerWindow = await harness.application.browserWindow(page);
    await ownerWindow.evaluate((window) => window.close());
    await closed;
    await expect
      .poll(() =>
        harness.application.evaluate(
          ({ webContents }, ids) =>
            ids.every((id) => webContents.fromId(id)?.isDestroyed() ?? true),
          guestsBeforeClose,
        ),
      )
      .toBe(true);
    expect(rendererErrors).toEqual([]);
    evidence = {
      ...evidence,
      windowCloseVerified: true,
      releasedGuestIds: guestsBeforeClose,
      releasedUnusedStandbyId: finalSpare.id,
    };
  } catch (error) {
    if (page) {
      await writeFile(
        testInfo.outputPath("failure-state.json"),
        JSON.stringify(
          {
            rendererErrors,
            nativeFixtures,
            ownedHome: harness.profile.runRoot,
            dom: page.isClosed()
              ? null
              : await page.evaluate(() => ({
                  text: document.body.innerText.slice(0, 12_000),
                  frames: Array.from(
                    document.querySelectorAll("[data-inline-visualization]"),
                    (element) => ({
                      id: element.getAttribute("data-visualization-frame-id"),
                      active: element.getAttribute("data-visualization-active"),
                      status: element.getAttribute("data-visualization-status"),
                      text: element.textContent?.slice(0, 500),
                    }),
                  ),
                  anchors: document.querySelectorAll("[data-visualization-anchor]").length,
                  guests: document.querySelectorAll("webview").length,
                })),
            guests: await harness.application.evaluate(({ webContents }) =>
              webContents.getAllWebContents().map((guest) => ({
                id: guest.id,
                type: guest.getType(),
                url: guest.getURL(),
                destroyed: guest.isDestroyed(),
                focused: guest.isFocused(),
              })),
            ),
            nativeFocus: await harness.application.evaluate(({ BrowserWindow }) => ({
              events: (
                globalThis as typeof globalThis & { retainedFocusEvents?: NativeFocusEvent[] }
              ).retainedFocusEvents,
              windows: BrowserWindow.getAllWindows().map((window) => ({
                id: window.id,
                visible: window.isVisible(),
                focused: window.isFocused(),
              })),
            })),
          },
          null,
          2,
        ) + "\n",
      );
      await testInfo.attach("desktop-runtime", {
        body: await readBoundedElectronRuntimeLogs(harness.profile),
        contentType: "text/plain",
      });
    }
    throw error;
  } finally {
    await rm(auth, { force: true });
    await harness.close();
    await writeFile(
      testInfo.outputPath("retained-evidence.json"),
      JSON.stringify(
        {
          evidence,
          cleanup: {
            ownedHomeRemoved: !(await exists(harness.profile.runRoot)),
            authAbsent: !(await exists(auth)),
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
});
