import { describe, expect, test } from "vite-plus/test";
import { createFormatCode, formatCode } from "./code-formatters";

describe("Code formatters", () => {
  test("formats supported languages without adding a trailing empty line", async () => {
    await expect(formatCode("css", "a{color:red}")).resolves.toEqual({
      status: "formatted",
      code: "a {\n  color: red;\n}",
    });
    await expect(formatCode("typescript", "const answer:number=42")).resolves.toEqual({
      status: "formatted",
      code: "const answer: number = 42;",
    });
    await expect(formatCode("xml", "<root><child /></root>")).resolves.toEqual({
      status: "formatted",
      code: "<root>\n  <child />\n</root>",
    });
  });

  test("distinguishes unchanged, unsupported, syntax, and loader failures", async () => {
    await expect(formatCode("javascript", "const answer = 42;")).resolves.toEqual({
      status: "unchanged",
    });
    await expect(formatCode("rust", "fn main() {}")).resolves.toEqual({
      status: "unsupported",
    });

    const invalid = await formatCode("json", "{");
    expect(invalid.status).toBe("failed");

    const loadFailure = createFormatCode(async () => {
      throw new Error("chunk unavailable");
    });
    const failed = await loadFailure("css", "a{}");
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.error.message).toBe("chunk unavailable");
    }
  });
});
