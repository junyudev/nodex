import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SANS_FONT_SIZE,
  MAX_SANS_FONT_SIZE,
  MIN_SANS_FONT_SIZE,
  SANS_FONT_SIZE_STORAGE_KEY,
  applySansFontSizeRootVariables,
  getSansFontSizeCssVariables,
  normalizeSansFontSize,
  readSansFontSize,
  writeSansFontSize,
} from "./sans-font-size";

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
};

if (!(globalThis as { localStorage?: unknown }).localStorage) {
  (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
}

describe("sans-font-size", () => {
  test("normalizes invalid values to the default size", () => {
    expect(normalizeSansFontSize(null)).toBe(DEFAULT_SANS_FONT_SIZE);
    expect(normalizeSansFontSize("")).toBe(DEFAULT_SANS_FONT_SIZE);
    expect(normalizeSansFontSize("abc")).toBe(DEFAULT_SANS_FONT_SIZE);
  });

  test("clamps persisted values to the supported range", () => {
    expect(normalizeSansFontSize(MIN_SANS_FONT_SIZE - 10)).toBe(MIN_SANS_FONT_SIZE);
    expect(normalizeSansFontSize(MAX_SANS_FONT_SIZE + 10)).toBe(MAX_SANS_FONT_SIZE);
  });

  test("reads and writes the persisted font size", () => {
    mockStorage.removeItem(SANS_FONT_SIZE_STORAGE_KEY);
    expect(readSansFontSize()).toBe(DEFAULT_SANS_FONT_SIZE);

    const written = writeSansFontSize(15);
    expect(written).toBe(15);
    expect(readSansFontSize()).toBe(15);
  });

  test("derives rounded token values from the sans scale", () => {
    const variables = getSansFontSizeCssVariables(16);

    expect(variables["--sans-font-size"]).toBe("16px");
    expect(variables["--sans-font-scale"]).toBe(String(16 / DEFAULT_SANS_FONT_SIZE));
    expect(variables["--vscode-font-size"]).toBe("16px");
    expect(variables["--text-base"]).toBe("16px");
    expect(variables["--text-4xl"]).toBe("89px");
  });

  test("applies the computed variables to a root style object", () => {
    const written = new Map<string, string>();
    const root = {
      style: {
        setProperty(name: string, value: string) {
          written.set(name, value);
        },
      },
    } as unknown as Pick<HTMLElement, "style">;

    const applied = applySansFontSizeRootVariables(root, 15);

    expect(applied).toBe(15);
    expect(written.get("--sans-font-size")).toBe("15px");
    expect(written.get("--text-heading-lg")).toBe("28px");
    expect(written.get("--text-xs")).toBe("12px");
  });
});
