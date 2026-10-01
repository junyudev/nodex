import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import type { DictationSettings } from "../../src/shared/dictation";
import type { CommandKeymapState } from "../../src/shared/command-keybindings";
import type { CodexDictationStateSnapshot } from "../../src/shared/types";
import {
  installDictationPolicyHttpFixture,
  readDictationPolicyHttpEvidence,
} from "./fixtures/dictation-policy-http";

const dictionaryWord = "Nodex";
const readSettings = (page: Page) =>
  page.evaluate(
    () => window.api!.invoke("codex:dictation:settings:read") as Promise<DictationSettings>,
  );
const readState = (page: Page) =>
  page.evaluate(
    () => window.api!.invoke("codex:dictation:state:read") as Promise<CodexDictationStateSnapshot>,
  );
const readGlobalShortcuts = async (page: Page) =>
  page.evaluate(async () => {
    const keymap = (await window.api!.invoke("codex-command-keymap-state")) as CommandKeymapState;
    return keymap.entries
      .filter((entry) => entry.id === "globalDictationHold" || entry.id === "globalDictationToggle")
      .map(({ id, available, keybindings }) => ({ id, available, keybindings }));
  });

const openVoice = async (page: Page): Promise<void> => {
  const settings = page.getByTestId("settings-route-shell");
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings.or(settingsButton).first()).toBeVisible();
  if (!(await settings.isVisible())) await settingsButton.click();
  await settings.getByRole("link", { name: "Voice", exact: true }).click();
};

test("keeps Voice configuration available when dictation capture is disabled", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "dictation-global-availability" });
  const artifactDirectory =
    process.env.NODEX_DICTATION_GLOBAL_UI_ARTIFACT_DIR ?? testInfo.outputPath("ui-review");
  await mkdir(artifactDirectory, { recursive: true });
  let recordingPage: Page | null = null;
  const expectedIdentity = {
    nodexHome: harness.profile.nodexHome,
    userData: path.join(harness.profile.nodexHome, "electron-user-data"),
  };
  const launchIdentities: Array<typeof expectedIdentity> = [];
  try {
    const launch = async () => {
      await harness.launch({ phase: "first-window" });
      const identity = await harness.application.evaluate(({ app }) => ({
        nodexHome: process.env.NODEX_HOME,
        userData: app.getPath("userData"),
      }));
      expect(identity).toEqual(expectedIdentity);
      launchIdentities.push(identity as typeof expectedIdentity);
      await installDictationPolicyHttpFixture(harness.application, {
        composer: false,
        streaming: false,
        sounds: false,
      });
      await harness.waitForApplicationReady();
      const page = harness.page;
      await expect
        .poll(async () => {
          await page.evaluate(() => window.api!.invoke("codex:account:read"));
          return readState(page);
        })
        .toMatchObject({
          authMethod: "chatgpt",
          capabilities: { composer: false, global: false, history: true, sounds: true },
        });
      await page.setViewportSize({ width: 1280, height: 800 });
      await openVoice(page);
      return page;
    };
    const assertControls = async (page: Page) => {
      const advanced = page.getByRole("button", { name: "Advanced", exact: true });
      await expect(advanced).toBeVisible();
      if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
      const controls = {
        primaryShortcut: page.getByRole("button", {
          name: "Set shortcut for Dictation shortcut",
          exact: true,
        }),
        singleTapShortcut: page.getByRole("button", {
          name: "Set shortcut for Single-tap shortcut",
          exact: true,
        }),
        dictationSounds: page.getByRole("switch", { name: "Toggle dictation sounds", exact: true }),
        localDictionary: page.getByRole("textbox", { name: "Dictionary entry 1", exact: true }),
        webmTranscription: page.getByRole("button", { name: "Transcribe WebM…", exact: true }),
      };
      const evidence: Record<string, { visible: boolean; enabled: boolean }> = {};
      for (const [name, control] of Object.entries(controls)) {
        await expect(control).toBeVisible();
        await expect(control).toBeEnabled();
        evidence[name] = { visible: await control.isVisible(), enabled: await control.isEnabled() };
      }
      return evidence;
    };
    const page = await launch();
    await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const initialControls = await assertControls(page);
    const shortcuts = await readGlobalShortcuts(page);
    expect(shortcuts).toEqual([
      { id: "globalDictationHold", available: true, keybindings: [] },
      { id: "globalDictationToggle", available: true, keybindings: [] },
    ]);
    const sound = page.getByRole("switch", { name: "Toggle dictation sounds", exact: true });
    await expect(sound).toBeChecked();
    await page.screencast.start({
      path: path.join(artifactDirectory, "review.webm"),
      size: { width: 1280, height: 800 },
      annotate: { position: "bottom", fontSize: 14 },
    });
    recordingPage = page;
    // Keep each verified state visible long enough for the native screencast to capture it.
    await page.waitForTimeout(300);
    const advanced = page.getByRole("button", { name: "Advanced", exact: true });
    const primaryShortcut = page.getByRole("button", {
      name: "Set shortcut for Dictation shortcut",
      exact: true,
    });
    const singleTapShortcut = page.getByRole("button", {
      name: "Set shortcut for Single-tap shortcut",
      exact: true,
    });
    await advanced.click();
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(primaryShortcut).toBeVisible();
    await expect(singleTapShortcut).toBeHidden();
    const collapsed = {
      advancedExpanded: (await advanced.getAttribute("aria-expanded")) === "true",
      primaryVisible: await primaryShortcut.isVisible(),
      singleTapVisible: await singleTapShortcut.isVisible(),
    };
    await page.waitForTimeout(250);
    await advanced.click();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(singleTapShortcut).toBeVisible();
    const expanded = {
      advancedExpanded: (await advanced.getAttribute("aria-expanded")) === "true",
      primaryVisible: await primaryShortcut.isVisible(),
      singleTapVisible: await singleTapShortcut.isVisible(),
    };
    await page.waitForTimeout(250);
    await primaryShortcut.click();
    const capture = page.getByRole("textbox", { name: "Dictation shortcut capture", exact: true });
    await expect(capture).toBeVisible();
    const captureWasVisible = await capture.isVisible();
    await page.waitForTimeout(250);
    await capture.press("Escape");
    await expect(capture).toBeHidden();
    const captureCancelled = {
      opened: captureWasVisible,
      visibleAfterEscape: await capture.isVisible(),
      shortcuts: await readGlobalShortcuts(page),
    };
    expect(captureCancelled.shortcuts).toEqual(shortcuts);
    await sound.click();
    await expect(sound).not.toBeChecked();
    await expect.poll(() => readSettings(page)).toMatchObject({ dictationSoundsEnabled: false });
    await page
      .getByRole("textbox", { name: "Dictionary entry 1", exact: true })
      .fill(dictionaryWord);
    await page.getByRole("heading", { name: "Voice", exact: true }).click();
    await expect.poll(() => readSettings(page)).toMatchObject({ dictionary: [dictionaryWord] });
    await assertControls(page);
    await page.getByRole("heading", { name: "Voice", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.screenshot({ path: path.join(artifactDirectory, "final.png"), fullPage: true });
    await page.waitForTimeout(600);
    await page.screencast.stop();
    recordingPage = null;
    const http = await readDictationPolicyHttpEvidence(harness.application);
    expect(http.invalidRequests).toEqual([]);
    expect(http.bootstrapRequests).toBeGreaterThan(0);
    await harness.stopElectron();
    const restarted = await launch();
    const retainedControls = await assertControls(restarted);
    expect(retainedControls).toEqual(initialControls);
    await expect(
      restarted.getByRole("switch", { name: "Toggle dictation sounds", exact: true }),
    ).not.toBeChecked();
    await expect(
      restarted.getByRole("textbox", { name: "Dictionary entry 1", exact: true }),
    ).toHaveValue(dictionaryWord);
    const persisted = await readSettings(restarted);
    expect(persisted).toMatchObject({
      dictationSoundsEnabled: false,
      dictionary: [dictionaryWord],
    });
    const physicalSettings = JSON.parse(
      await readFile(path.join(harness.profile.nodexHome, "dictation-settings.json"), "utf8"),
    ) as DictationSettings;
    expect(physicalSettings).toEqual(persisted);
    const retainedShortcuts = await readGlobalShortcuts(restarted);
    expect(retainedShortcuts).toEqual(shortcuts);
    const capabilities = (await readState(restarted)).capabilities;
    await writeFile(
      path.join(artifactDirectory, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          fixture: "isolated ChatGPT account; remote composer/global/streaming/sounds gates false",
          boundary:
            "Voice configuration through production preload/Main IPC and restart. Native hotkey activation and OS permissions are covered separately by Main integration/manager tests.",
          assertions: {
            captureAvailability: {
              expected: { composer: false, global: false, sounds: true, history: true },
              actual: {
                composer: capabilities.composer,
                global: capabilities.global,
                sounds: capabilities.sounds,
                history: capabilities.history,
              },
            },
            configurableShortcutsAfterRestart: { expected: shortcuts, actual: retainedShortcuts },
            advancedCollapsed: {
              expected: { advancedExpanded: false, primaryVisible: true, singleTapVisible: false },
              actual: collapsed,
            },
            advancedExpanded: {
              expected: { advancedExpanded: true, primaryVisible: true, singleTapVisible: true },
              actual: expanded,
            },
            shortcutCaptureCancelled: {
              expected: { opened: true, visibleAfterEscape: false, shortcuts },
              actual: captureCancelled,
            },
            visibleEnabledControlsAfterRestart: {
              expected: initialControls,
              actual: retainedControls,
            },
            isolatedProfileIdentity: {
              expected: [expectedIdentity, expectedIdentity],
              actual: launchIdentities,
            },
            isolatedPhysicalSettings: { expected: persisted, actual: physicalSettings },
            soundsAfterRestart: { expected: false, actual: persisted.dictationSoundsEnabled },
            dictionaryAfterRestart: { expected: [dictionaryWord], actual: persisted.dictionary },
            accountMatchedPolicy: { expected: [], actual: http.invalidRequests },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(artifactDirectory, "README.md"),
      "# Voice configuration availability\n\nThe isolated account disables dictation capture and sends false remote global, streaming, and sound gates. Voice keeps its primary Dictation shortcut available and reveals the independent Single-tap shortcut under Advanced. The recording shows Advanced collapsing and reopening, cancelling primary shortcut capture without changing either assignment, a real sound toggle and a local dictionary edit. Production IPC and an application restart verify the preferences persisted. All exact assertions in `result.json` passed.\n\nBoth launches assert NODEX_HOME and Electron userData match the disposable Profile; the saved IPC settings also match its physical dictation-settings.json. This proof exercises configuration and capability admission, keeps native shortcut assignments empty, and does not trigger recording or an OS permission prompt. Main integration and manager tests separately cover native enablement and session routing.\n",
    );
    await testInfo.attach("Voice configuration result", {
      path: path.join(artifactDirectory, "final.png"),
      contentType: "image/png",
    });
  } finally {
    if (recordingPage) await recordingPage.screencast.stop().catch(() => undefined);
    try {
      await writeFile(
        testInfo.outputPath("runtime.log"),
        await readBoundedElectronRuntimeLogs(harness.profile),
      );
    } finally {
      await harness.close();
    }
  }
});
