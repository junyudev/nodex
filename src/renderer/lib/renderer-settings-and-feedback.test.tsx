import { act, render, screen, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, test, describe, beforeEach } from "vite-plus/test";
import {
  activateAppLocale,
  FormattedMessage,
  resetAppLocaleForTests,
  useIntl,
  getAppLocale,
} from "./i18n";
import { createMaitaiStore, MaitaiProvider } from "./maitai";
import { useSpellcheck } from "./use-spellcheck";
import type { LanguageSettings } from "../../shared/i18n/locales";
import { installWindowApi } from "@/test/browser-globals";
import { initializeRendererLanguageSettings } from "./renderer-language-settings";
import { useLanguageSettings } from "./use-language-settings";

describe("i18n", () => {
  afterEach(() => {
    act(resetAppLocaleForTests);
  });

  function LocaleProbe() {
    const intl = useIntl();
    return (
      <div>
        <output>{intl.locale}</output>
        <FormattedMessage id="settings.general.title" defaultMessage="General" />
      </div>
    );
  }

  test("switches useIntl subscribers, catalog messages and the document language together", async () => {
    render(<LocaleProbe />);
    expect(screen.getByRole("status").textContent).toBe("en-US");
    expect(screen.getByText("General")).toBeTruthy();

    await act(async () => activateAppLocale("zh-CN"));
    expect(screen.getByRole("status").textContent).toBe("zh-CN");
    expect(screen.getByText("常规")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  test("supersedes a pending catalog load with the latest locale", async () => {
    render(<LocaleProbe />);
    await act(async () => {
      const earlier = activateAppLocale("zh-CN");
      await activateAppLocale("en-US");
      await earlier;
    });
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
  });
});

describe("renderer preference atoms", () => {
  const SPELLCHECK_STORAGE_KEY = "nodex-spellcheck";

  function SpellcheckProbe({ label }: { label: string }) {
    const { spellcheck, toggleSpellcheck } = useSpellcheck();
    return (
      <button type="button" onClick={toggleSpellcheck}>
        {label}:{spellcheck ? "on" : "off"}
      </button>
    );
  }

  describe("renderer preference App atoms", () => {
    beforeEach(() => {
      localStorage.removeItem(SPELLCHECK_STORAGE_KEY);
    });

    test("shares one preference value within a renderer and initializes each renderer from storage", () => {
      const firstStore = createMaitaiStore();
      const firstView = render(
        <MaitaiProvider store={firstStore}>
          <SpellcheckProbe label="first" />
          <SpellcheckProbe label="second" />
        </MaitaiProvider>,
      );

      expect(screen.getByRole("button", { name: "first:on" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "second:on" })).toBeTruthy();

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "first:on" }));
      });

      expect(screen.getByRole("button", { name: "first:off" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "second:off" })).toBeTruthy();
      expect(localStorage.getItem(SPELLCHECK_STORAGE_KEY)).toBe("false");
      firstView.unmount();

      localStorage.setItem(SPELLCHECK_STORAGE_KEY, "true");
      render(
        <MaitaiProvider store={createMaitaiStore()}>
          <SpellcheckProbe label="third" />
        </MaitaiProvider>,
      );

      expect(screen.getByRole("button", { name: "third:on" })).toBeTruthy();
    });
  });
});

describe("use language settings", () => {
  afterEach(() => {
    act(resetAppLocaleForTests);
  });

  test("uses the Main-returned preference and activates the effective locale", async () => {
    const initial = { preference: "en-US", locale: "en-US" } as const;
    const listener = renderHook(useLanguageSettings);
    const updates: unknown[] = [];
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel !== "settings:language:update")
          throw new Error(`Unexpected channel: ${channel}`);
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
});
