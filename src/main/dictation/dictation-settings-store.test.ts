import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DictationSettingsStore } from "./dictation-settings-store";

const temporaryDirectories: string[] = [];

const createStore = async (): Promise<{ directory: string; store: DictationSettingsStore }> => {
  const directory = await mkdtemp(join(tmpdir(), "nodex-dictation-settings-"));
  temporaryDirectories.push(directory);
  return { directory, store: new DictationSettingsStore(directory) };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("DictationSettingsStore", () => {
  test("persists strict typed patches and rejects unknown settings", async () => {
    const { store } = await createStore();
    expect(await store.read()).toMatchObject({
      microphoneInputDeviceId: null,
      dictationSoundsEnabled: true,
      globalShortcutNudgeDismissed: false,
      dictionary: [],
    });

    await expect(store.update({ microphoneInputDeviceId: "mic-1" })).resolves.toMatchObject({
      microphoneInputDeviceId: "mic-1",
    });
    await expect(store.update({ dictationSoundsEnabled: false })).resolves.toMatchObject({
      dictationSoundsEnabled: false,
    });
    expect(() => store.update({ microphoneInputDeviceId: "" })).toThrow();
    expect(() => store.update({ dictationSoundsEnabled: "yes" })).toThrow();
    expect(() => store.update({ unknown: true })).toThrow("Unknown dictation setting");
    expect((await store.read()).microphoneInputDeviceId).toBe("mic-1");
  });

  test("persists a bounded dictation dictionary and migrates older settings to an empty list", async () => {
    const { directory, store } = await createStore();
    await expect(
      store.update({ dictionary: ["  Nodex  ", "useCartState"] }),
    ).resolves.toMatchObject({
      dictionary: ["  Nodex  ", "useCartState"],
    });
    expect(() => store.update({ dictionary: Array.from({ length: 101 }, () => "entry") })).toThrow(
      "dictionary",
    );

    await writeFile(
      join(directory, "dictation-settings.json"),
      JSON.stringify({
        microphoneInputDeviceId: null,
        globalShortcutNudgeDismissed: false,
      }),
      { mode: 0o600 },
    );

    expect((await store.read()).dictionary).toEqual([]);
  });

  test("lets exactly one concurrent renderer claim the global shortcut nudge", async () => {
    const { store } = await createStore();
    const claims = await Promise.all([
      store.consumeGlobalShortcutNudge(),
      store.consumeGlobalShortcutNudge(),
      store.consumeGlobalShortcutNudge(),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await store.read()).globalShortcutNudgeDismissed).toBe(true);
  });

  test("reads settings written before the nudge flag existed", async () => {
    const { directory, store } = await createStore();
    await writeFile(
      join(directory, "dictation-settings.json"),
      JSON.stringify({
        microphoneInputDeviceId: null,
      }),
      { mode: 0o600 },
    );

    expect((await store.read()).globalShortcutNudgeDismissed).toBe(false);
  });
});
