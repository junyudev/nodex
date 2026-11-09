import { describe, expect, it } from "vitest";
import { countWords } from "./word-count";

describe("countWords", () => {
  it("counts spaced words and ignores punctuation and whitespace", () => {
    expect(countWords("  Fix the login button — now, please!  ")).toBe(6);
    expect(countWords("")).toBe(0);
    expect(countWords("…, ! ?")).toBe(0);
  });

  it("segments Chinese into words rather than characters or one run", () => {
    const text = "把设置页的保存按钮改成保存";
    const count = countWords(text);
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThan(text.length);
  });

  it("counts mixed text and Markdown links in full", () => {
    expect(countWords("继续 NODEX-12 的工作")).toBeGreaterThanOrEqual(4);
    expect(countWords("[PR](https://github.com/acme/app/pull/7)")).toBeGreaterThan(1);
  });
});
