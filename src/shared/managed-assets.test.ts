import { describe, expect, test } from "vite-plus/test";
import {
  MAX_MANAGED_PREVIEW_BYTES,
  MAX_MANAGED_PREVIEW_LINES,
  createManagedTextPreview,
} from "./managed-assets";

describe("managed assets", () => {
  test("bounds text previews by line count", () => {
    const value = Array.from(
      { length: MAX_MANAGED_PREVIEW_LINES + 1 },
      (_, index) => `line-${index}`,
    ).join("\n");
    const preview = createManagedTextPreview(value);

    expect(preview.truncated).toBe(true);
    expect(preview.content.split("\n")).toHaveLength(MAX_MANAGED_PREVIEW_LINES);
  });

  test("bounds text previews by UTF-8 byte length without splitting a surrogate pair", () => {
    const preview = createManagedTextPreview(`${"a".repeat(MAX_MANAGED_PREVIEW_BYTES - 1)}😀`);

    expect(preview.truncated).toBe(true);
    expect(new TextEncoder().encode(preview.content).byteLength).toBeLessThanOrEqual(
      MAX_MANAGED_PREVIEW_BYTES,
    );
    expect(preview.content.endsWith("\uFFFD")).toBe(false);
  });
});
