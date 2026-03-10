import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NFM_AUTOLINK_SETTINGS,
  NFM_AUTOLINK_SETTINGS_STORAGE_KEY,
  normalizeNfmAutolinkSettings,
  readNfmAutolinkSettings,
  shouldAutoLinkMatchInText,
  shouldAutoLinkValue,
  writeNfmAutolinkSettings,
} from "./nfm-autolink-settings";

const storageMap = new Map<string, string>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? storageMap.get(key) ?? null : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, value);
  },
  removeItem(key: string): void {
    storageMap.delete(key);
  },
  clear(): void {
    storageMap.clear();
  },
};

function withMockLocalStorage(run: () => void): void {
  const storageGlobal = globalThis as { localStorage?: typeof mockStorage };
  const previousLocalStorage = storageGlobal.localStorage;
  storageGlobal.localStorage = mockStorage;
  try {
    run();
  } finally {
    if (previousLocalStorage) {
      storageGlobal.localStorage = previousLocalStorage;
      return;
    }
    delete storageGlobal.localStorage;
  }
}

describe("nfm autolink settings", () => {
  test("defaults to fully enabled autolink behavior", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      const settings = readNfmAutolinkSettings();
      expect(settings.autoLinkWhileTyping).toBeTrue();
      expect(settings.autoLinkOnPaste).toBeTrue();
      expect(settings.linkifyBareDomains).toBeTrue();
    });
  });

  test("persists normalized settings", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();

      const written = writeNfmAutolinkSettings({
        autoLinkWhileTyping: false,
        autoLinkOnPaste: "true",
        linkifyBareDomains: "nope",
      });

      expect(written.autoLinkWhileTyping).toBeFalse();
      expect(written.autoLinkOnPaste).toBeTrue();
      expect(written.linkifyBareDomains).toBeTrue();
      expect(mockStorage.getItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY)).not.toBeNull();

      const normalized = normalizeNfmAutolinkSettings({
        autoLinkWhileTyping: "false",
        autoLinkOnPaste: "true",
        linkifyBareDomains: true,
      });

      expect(normalized.autoLinkWhileTyping).toBeFalse();
      expect(normalized.autoLinkOnPaste).toBeTrue();
      expect(normalized.linkifyBareDomains).toBeTrue();
    });
  });

  test("recognizes explicit web URLs with the default settings", () => {
    expect(
      shouldAutoLinkValue("https://example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeTrue();
    expect(
      shouldAutoLinkValue("www.example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeTrue();
    expect(
      shouldAutoLinkValue("mailto:test@example.com", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeTrue();
  });

  test("rejects path-like and filename-like input even when bare-domain recognition is enabled", () => {
    expect(
      shouldAutoLinkValue(
        "nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeFalse();
    expect(
      shouldAutoLinkValue(
        "docs/product-specs/nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeFalse();
    expect(
      shouldAutoLinkValue(
        "./docs/product-specs/nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeFalse();
    expect(
      shouldAutoLinkValue(
        "C:\\repo\\docs\\nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeFalse();
  });

  test("rejects bare domains when the setting is disabled", () => {
    expect(
      shouldAutoLinkValue(
        "example.com",
        {
          ...DEFAULT_NFM_AUTOLINK_SETTINGS,
          linkifyBareDomains: false,
        },
      ),
    ).toBeFalse();
  });

  test("allows bare domains with the default settings", () => {
    expect(
      shouldAutoLinkValue("example.com", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeTrue();
    expect(
      shouldAutoLinkValue(
        "example.co.uk",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeTrue();
    expect(
      shouldAutoLinkValue(
        "example.com/docs",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeTrue();
  });

  test("rejects internal and unsupported explicit values", () => {
    expect(
      shouldAutoLinkValue("foo.internal", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeFalse();
    expect(
      shouldAutoLinkValue("localhost", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeFalse();
    expect(
      shouldAutoLinkValue("javascript:alert(1)", DEFAULT_NFM_AUTOLINK_SETTINGS),
    ).toBeFalse();
  });

  test("rejects protocol-less matches embedded in path segments on paste", () => {
    expect(
      shouldAutoLinkMatchInText(
        "local/code-block-mock-ui/action-menu-popper.com",
        "local/code-block-mock-ui/".length,
        "action-menu-popper.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeFalse();
    expect(
      shouldAutoLinkMatchInText(
        "docs/example.com",
        "docs/".length,
        "example.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeFalse();
  });

  test("allows protocol-less matches when surrounded by soft boundaries", () => {
    expect(
      shouldAutoLinkMatchInText(
        "(action-menu-popper.com)",
        1,
        "action-menu-popper.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeTrue();
    expect(
      shouldAutoLinkMatchInText(
        " action-menu-popper.com ",
        1,
        "action-menu-popper.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBeTrue();
  });
});
