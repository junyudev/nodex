import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import type { LanguageSettings } from "../../shared/i18n/locales";
import { installWindowApi } from "@/test/browser-globals";
import { getAppLocale, resetAppLocaleForTests } from "./i18n";
import { initializeRendererLanguageSettings } from "./renderer-language-settings";
import { useLanguageSettings } from "./use-language-settings";

afterEach(() => {
  act(resetAppLocaleForTests);
});

test("uses the Main-returned preference and activates the effective locale", async () => {
  const initial = { preference: "en-US", locale: "en-US" } as const;
  const listener = renderHook(useLanguageSettings);
  const updates: unknown[] = [];
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel !== "settings:language:update") throw new Error(`Unexpected channel: ${channel}`);
      updates.push(...args);
      return { preference: null, locale: "zh-CN" } satisfies LanguageSettings;
    },
  });
  const bootstrap = initializeRendererLanguageSettings({
    readLanguageSettings: async () => initial,
    onLanguageSettingsChanged: () => () => undefined,
  });
  await act(async () => bootstrap.ready);
  expect(listener.result.current).toMatchObject({ ...initial, isLoading: false });

  await act(async () => listener.result.current.updatePreference(null));
  expect(updates).toEqual([null]);
  expect(listener.result.current).toMatchObject({ preference: null, locale: "zh-CN" });
  expect(getAppLocale()).toBe("zh-CN");
  bootstrap.dispose();
});

test("activates a pushed language instead of a stale initial read", async () => {
  let resolveRead = (_settings: LanguageSettings): void => undefined;
  const read = new Promise<LanguageSettings>((resolve) => {
    resolveRead = resolve;
  });
  let publishChange: (settings: LanguageSettings) => void = () => undefined;
  const bootstrap = initializeRendererLanguageSettings({
    readLanguageSettings: () => read,
    onLanguageSettingsChanged: (listener) => {
      publishChange = listener;
      return () => undefined;
    },
  });
  await act(async () => {
    publishChange({ preference: "zh-CN", locale: "zh-CN" });
    resolveRead({ preference: null, locale: "en-US" });
    await bootstrap.ready;
  });
  expect(getAppLocale()).toBe("zh-CN");
  bootstrap.dispose();
});
