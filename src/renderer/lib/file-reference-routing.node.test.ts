import { describe, expect, test, it, vi } from "vite-plus/test";
import {
  FILE_LINK_OPENER_STORAGE_KEY,
  readFileLinkOpener,
  writeFileLinkOpener,
} from "./file-link-opener-settings";
import { decideFileReferenceOpen } from "./file-reference-opening";
import {
  buildFileUrl,
  parseFileReferenceLocation,
  parseLocalFileLinkHref,
} from "../../shared/file-link-openers";
import { createLinkRouter } from "./link-opening";
import { DEFAULT_LINK_OPENING_SETTINGS } from "../../shared/link-opening-settings";

describe("file link opener settings", () => {
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

  describe("file link opener settings", () => {
    test("defaults to VS Code when nothing is stored", () => {
      withMockLocalStorage(() => {
        mockStorage.clear();
        expect(readFileLinkOpener()).toBe("vscode");
      });
    });

    test("persists and normalizes stored opener values", () => {
      withMockLocalStorage(() => {
        mockStorage.clear();

        expect(writeFileLinkOpener("cursor")).toBe("cursor");
        expect(mockStorage.getItem(FILE_LINK_OPENER_STORAGE_KEY)).toBe("cursor");
        expect(readFileLinkOpener()).toBe("cursor");

        mockStorage.setItem(FILE_LINK_OPENER_STORAGE_KEY, "not-real");
        expect(readFileLinkOpener()).toBe("vscode");
      });
    });
  });
});

describe("file reference opening", () => {
  const base = { target: { path: "/repo/report.html" }, hostId: "local", browserAvailable: true };
  describe("file opening intent", () => {
    test.each([
      [{}, "browser"],
      [{ sidePanel: false }, "browser"],
      [{ browserAvailable: false }, "files"],
      [{ browserAvailable: false, sidePanel: false }, "native"],
      [{ hostId: "ssh:build" }, "files"],
      [{ directory: true }, "file-manager"],
      [{ explicitTarget: true }, "native"],
      [{ target: { path: "/repo/report.html", line: 2, column: 4 } }, "files"],
      [{ target: { path: "/repo/report.html", column: 4 } }, "browser"],
      [{ target: { path: "/repo/report.xhtml" } }, "files"],
      [{ previewSource: true }, "files"],
    ] as const)("resolves %j to %s", (input, expected) => {
      expect(decideFileReferenceOpen({ ...base, ...input })).toBe(expected);
    });
    for (const platform of ["darwin", "win32"]) {
      const primary = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
      const other = platform === "darwin" ? { ctrlKey: true } : { metaKey: true };
      test.each([
        [{}, "files", "browser"],
        [{ shiftKey: true }, "files", "browser"],
        [{ altKey: true }, "save", "save"],
        [{ altKey: true, shiftKey: true }, "files", "browser"],
        [other, "files", "browser"],
        [primary, "native", "files"],
        [{ ...primary, shiftKey: true }, "native", "files"],
        [{ button: 1 }, "native", "files"],
        [{ button: 1, altKey: true }, "native", "files"],
      ] as const)(`${platform} gesture %j preserves source intent`, (gesture, source, html) => {
        const activation = { platform, ...gesture };
        expect(
          decideFileReferenceOpen({ ...base, target: { path: "/repo/file.ts" }, activation }),
        ).toBe(source);
        expect(decideFileReferenceOpen({ ...base, activation })).toBe(html);
        if (html === "files")
          expect(decideFileReferenceOpen({ ...base, sidePanel: false, activation })).toBe("native");
      });
    }
  });
  describe("file reference locations", () => {
    test.each(["/repo/a.ts:3:4-8:9", "/repo/a.ts:3:4–8:9", "/repo/a.ts#L3C4-L8C9"])(
      "shares range grammar for %s",
      (input) => {
        expect(parseFileReferenceLocation(input)).toEqual({
          path: "/repo/a.ts",
          line: 3,
          column: 4,
          endLine: 8,
          endColumn: 9,
        });
        expect(parseLocalFileLinkHref(input)).toEqual(parseFileReferenceLocation(input));
      },
    );
    test("encodes native file paths once and preserves Windows drives", () => {
      expect(buildFileUrl({ path: "/repo/a #?% report.html" })).toBe(
        "file:///repo/a%20%23%3F%25%20report.html",
      );
      expect(buildFileUrl({ path: "C:\\repo\\a #.htm" })).toBe("file:///C:/repo/a%20%23.htm");
      expect(parseLocalFileLinkHref("file:///repo/a%3A3")).toEqual({ path: "/repo/a:3" });
      expect(parseLocalFileLinkHref("file:///repo/a%20%23%3F%25%20report.html")).toEqual({
        path: "/repo/a #?% report.html",
      });
    });
  });
});

describe("link opening", () => {
  it("executes the resolved owner capability and captures it before asynchronous settings reads", async () => {
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => true);
    let open = first;
    const external = vi.fn(async () => true);
    const router = createLinkRouter({
      browserAvailable: true,
      browser: () => ({ available: true, open }),
      readSettings: async () => {
        open = second;
        return DEFAULT_LINK_OPENING_SETTINGS;
      },
      openExternal: external,
    });
    await router.openLink({ url: "http://localhost:3000", initiator: "test" });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    await router.openLink({
      url: "https://example.com",
      initiator: "test",
      openTarget: "external-browser",
    });
    expect(external).toHaveBeenCalledWith("https://example.com");
  });
  it("keeps unavailable contexts external, rejects invalid URLs and delegates Alt-only downloads", async () => {
    const open = vi.fn(async () => true);
    const external = vi.fn(async () => true);
    const saveLink = vi.fn(async () => true);
    const router = createLinkRouter({
      browserAvailable: false,
      browser: () => ({ available: false, open }),
      readSettings: async () => DEFAULT_LINK_OPENING_SETTINGS,
      openExternal: external,
      saveLink,
    });
    await router.openLink({
      url: "http://localhost:3000",
      initiator: "test",
      openTarget: "in-app-browser",
    });
    expect(external).toHaveBeenCalledWith("http://localhost:3000");
    expect(open).not.toHaveBeenCalled();
    expect(await router.openLink({ url: "javascript:alert(1)", initiator: "test" })).toBe(false);
    expect(external).toHaveBeenCalledOnce();
    await router.openLink({
      url: "https://example.com/file",
      initiator: "test",
      activation: { platform: "darwin", altKey: true },
    });
    expect(saveLink).toHaveBeenCalledWith("https://example.com/file");
    expect(external).toHaveBeenCalledOnce();
  });
});
