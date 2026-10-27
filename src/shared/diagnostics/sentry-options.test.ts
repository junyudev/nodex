import type { BrowserOptions } from "@sentry/react";
import { expect, test } from "vite-plus/test";
import { createSentryPrivacyOptions } from "./sentry-options";

test("scrubs streamed spans independently of error events", () => {
  const options: BrowserOptions = createSentryPrivacyOptions();
  const span: Parameters<NonNullable<BrowserOptions["beforeSendSpan"]>>[0] = {
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "0123456789abcdef",
    name: "Read /Users/alice/project",
    start_timestamp: 1,
    end_timestamp: 2,
    status: "ok",
    is_segment: true,
    attributes: {
      "sentry.op": "file.read",
      "db.query.text": "SELECT private_content FROM pages",
      "gen_ai.input.messages": "private prompt",
      "mcp.tool.arguments": "private arguments",
      "url.full": "https://example.com/read?token=secret",
      prompt: "private prompt",
      authorization: "secret",
    },
  };
  const scrubbed = options.beforeSendSpan?.(span);
  expect(scrubbed).toMatchObject({
    trace_id: span.trace_id,
    span_id: span.span_id,
    name: "Read /Users/[user]/project",
    attributes: {
      "sentry.op": "file.read",
      "db.query.text": "[REDACTED]",
      "gen_ai.input.messages": "[REDACTED]",
      "mcp.tool.arguments": "[REDACTED]",
      "url.full": "https://example.com/read",
      prompt: "[REDACTED]",
      authorization: "[REDACTED]",
    },
  });
  expect(span.attributes.prompt).toBe("private prompt");
});
