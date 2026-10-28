import { describe, expect, test } from "vite-plus/test";
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
    return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
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

describe("markdown autolink settings", () => {
  test("defaults to fully enabled autolink behavior", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      const settings = readNfmAutolinkSettings();
      expect(settings.autoLinkWhileTyping).toBe(true);
      expect(settings.autoLinkOnPaste).toBe(true);
      expect(settings.linkifyBareDomains).toBe(true);
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

      expect(written.autoLinkWhileTyping).toBe(false);
      expect(written.autoLinkOnPaste).toBe(true);
      expect(written.linkifyBareDomains).toBe(true);
      expect(mockStorage.getItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY)).not.toBeNull();

      const normalized = normalizeNfmAutolinkSettings({
        autoLinkWhileTyping: "false",
        autoLinkOnPaste: "true",
        linkifyBareDomains: true,
      });

      expect(normalized.autoLinkWhileTyping).toBe(false);
      expect(normalized.autoLinkOnPaste).toBe(true);
      expect(normalized.linkifyBareDomains).toBe(true);
    });
  });

  test("recognizes explicit web URLs with the default settings", () => {
    expect(shouldAutoLinkValue("https://example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(
      true,
    );
    expect(shouldAutoLinkValue("www.example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
    expect(shouldAutoLinkValue("mailto:test@example.com", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(
      true,
    );
  });

  test("rejects path-like and filename-like input even when bare-domain recognition is enabled", () => {
    expect(shouldAutoLinkValue("nfm-editor-copy-behavior.md", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(
      false,
    );
    expect(
      shouldAutoLinkValue(
        "docs/product-specs/nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(false);
    expect(
      shouldAutoLinkValue(
        "./docs/product-specs/nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(false);
    expect(
      shouldAutoLinkValue(
        "C:\\repo\\docs\\nfm-editor-copy-behavior.md",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(false);
  });

  test("rejects bare domains when the setting is disabled", () => {
    expect(
      shouldAutoLinkValue("example.com", {
        ...DEFAULT_NFM_AUTOLINK_SETTINGS,
        linkifyBareDomains: false,
      }),
    ).toBe(false);
  });

  test("allows bare domains with the default settings", () => {
    expect(shouldAutoLinkValue("example.com", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
    expect(shouldAutoLinkValue("example.co.uk", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
    expect(shouldAutoLinkValue("example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
  });

  test("rejects internal and unsupported explicit values", () => {
    expect(shouldAutoLinkValue("foo.internal", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(false);
    expect(shouldAutoLinkValue("localhost", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(false);
    expect(shouldAutoLinkValue("javascript:alert(1)", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(false);
  });

  test("rejects protocol-less matches embedded in path segments on paste", () => {
    expect(
      shouldAutoLinkMatchInText(
        "local/code-block-mock-ui/action-menu-popper.com",
        "local/code-block-mock-ui/".length,
        "action-menu-popper.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(false);
    expect(
      shouldAutoLinkMatchInText(
        "docs/example.com",
        "docs/".length,
        "example.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(false);
  });

  test("allows protocol-less matches when surrounded by soft boundaries", () => {
    expect(
      shouldAutoLinkMatchInText(
        "(action-menu-popper.com)",
        1,
        "action-menu-popper.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(true);
    expect(
      shouldAutoLinkMatchInText(
        " action-menu-popper.com ",
        1,
        "action-menu-popper.com",
        DEFAULT_NFM_AUTOLINK_SETTINGS,
      ),
    ).toBe(true);
  });
});
