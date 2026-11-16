import { describe, expect, test } from "vite-plus/test";
import { scrubSentryBreadcrumb, scrubSentryData, scrubSentryEvent } from "./sentry-scrub";

describe("Sentry diagnostics scrubber", () => {
  test("redacts secret-bearing fields and prompt-like content", () => {
    const scrubbed = scrubSentryData({
      authorization: "Bearer abcdefghijklmnop",
      nested: {
        apiKey: "sk_test_1234567890123456",
        promptPreview: "summarize /Users/alice/private.md",
        transcript: "hidden thread transcript",
      },
    }) as Record<string, unknown>;

    expect(scrubbed.authorization).toBe("[REDACTED]");
    const nested = scrubbed.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe("[REDACTED]");
    expect(nested.promptPreview).toBe("[REDACTED]");
    expect(nested.transcript).toBe("[REDACTED]");
  });

  test("scrubs local usernames and URL query strings while keeping useful messages", () => {
    const scrubbed = scrubSentryBreadcrumb({
      message: "Failed at /Users/alice/work/app.ts with https://example.com/path?token=abc#top",
      data: {
        cwd: "/home/bob/project",
      },
    });

    expect(scrubbed.message).toBe(
      "Failed at /Users/[user]/work/app.ts with https://example.com/path",
    );
    const data = scrubbed.data as Record<string, unknown>;
    expect(data.cwd).toBe("/home/[user]/project");
  });

  test("keeps every stack frame and the newest breadcrumbs while scrubbing their content", () => {
    const frames = Array.from({ length: 40 }, (_, index) => ({
      function: `step${index}`,
      filename: "C:\\Users\\alice\\AppData\\Local\\Nodex\\resources\\app.asar\\out\\main\\index.js",
      lineno: index + 1,
      in_app: true,
      context_line: "const prompt = readPrivateFile();",
      vars: { token: "secret" },
    }));
    const breadcrumbs = Array.from({ length: 100 }, (_, index) => ({
      message: `step ${index} in /Users/alice/project`,
      timestamp: index,
    }));
    const event = scrubSentryEvent({
      exception: {
        values: [
          { type: "Error", value: "write EAGAIN", stacktrace: { frames } },
          { type: "Error", value: "cause", stacktrace: { frames: frames.slice(0, 3) } },
        ],
      },
      threads: { values: [{ id: 1, stacktrace: { frames } }] },
      breadcrumbs,
      debug_meta: {
        images: Array.from({ length: 30 }, (_, index) => ({
          type: "sourcemap",
          code_file: `app:///out/renderer/chunk-${index}.js`,
          debug_id: `debug-${index}`,
        })),
      },
    });

    const [exception] = event.exception.values;
    expect(exception?.stacktrace.frames).toHaveLength(40);
    expect(exception?.stacktrace.frames.at(-1)).toEqual({
      function: "step39",
      filename:
        "C:\\Users\\[user]\\AppData\\Local\\Nodex\\resources\\app.asar\\out\\main\\index.js",
      lineno: 40,
      in_app: true,
    });
    expect(event.exception.values[1]?.stacktrace.frames).toHaveLength(3);
    expect(event.threads.values[0]?.stacktrace.frames).toHaveLength(40);
    expect(event.breadcrumbs).toHaveLength(100);
    expect(event.breadcrumbs.at(-1)?.message).toBe("step 99 in /Users/[user]/project");
    expect(event.debug_meta.images.at(-1)?.debug_id).toBe("debug-29");
  });

  test("removes sensitive request payload fields from events", () => {
    const event = scrubSentryEvent({
      message: "request failed",
      request: {
        url: "https://api.example.com/items?authorization=abc",
        headers: { cookie: "secret" },
        data: { description: "private card" },
        query_string: "authorization=abc",
      },
    });

    const request = event.request as Record<string, unknown>;
    expect(event.message).toBe("request failed");
    expect(request.url).toBe("https://api.example.com/items");
    expect("headers" in request).toBe(false);
    expect("data" in request).toBe(false);
    expect("query_string" in request).toBe(false);
  });
});
