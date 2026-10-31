import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAppToolArguments, toolSuccess } from "./app-tool-result";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";

describe("application tool argument parsing", () => {
  it("returns actionable nested paths and reasons in text and structured errors", () => {
    const parsed = parseAppToolArguments(sessionMessageSchema, {
      sessionId: "target",
      prompt: "Continue",
      attachments: [{ type: "library_file", fileId: 42 }],
      idempotencyKey: "x".repeat(129),
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.result.structuredContent).toMatchObject({
      error: {
        code: "invalid_arguments",
        details: {
          issues: [
            { path: ["attachments", 0, "fileId"], message: expect.any(String) },
            { path: ["idempotencyKey"], message: expect.any(String) },
          ],
        },
      },
    });
    const content = parsed.result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") return;
    expect(JSON.parse(content.text)).toMatchObject({
      issues: [{ path: ["attachments", 0, "fileId"] }, { path: ["idempotencyKey"] }],
    });
  });

  it("accepts opaque UUID and whitespace keys unchanged, preserves omission, and reports object errors", () => {
    const schema = z.strictObject({ idempotencyKey: z.string().min(1).max(128).optional() });
    for (const key of ["06d6709c-45e7-4b37-8c26-74e9d64c5aa1", " retry / 任意 🦉 ", " "])
      expect(parseAppToolArguments(schema, { idempotencyKey: key })).toEqual({
        success: true,
        data: { idempotencyKey: key },
      });
    expect(parseAppToolArguments(schema, {})).toEqual({ success: true, data: {} });
    const invalid = parseAppToolArguments(sessionMessageSchema, {
      sessionId: "target",
      providerInstanceId: "codex",
    });
    expect(invalid.success).toBe(false);
    if (invalid.success) return;
    expect(invalid.result.structuredContent).toMatchObject({
      error: {
        details: {
          issues: expect.arrayContaining([
            { path: ["model"], message: "Choose the model the other Agent runs" },
          ]),
        },
      },
    });
  });
});

it("returns a complete failure instead of truncating an oversized result", () => {
  const result = toolSuccess({ rows: ["正文".repeat(150_000)] });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ error: { code: "result_too_large" } });
});

it("enforces a narrower tool budget without changing the successful payload", () => {
  const value = { text: "x".repeat(1000) };
  expect(toolSuccess(value, 500).isError).toBe(true);
  expect(toolSuccess(value, 3000).structuredContent).toEqual(value);
});
