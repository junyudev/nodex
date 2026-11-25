import { describe, expect, test, afterEach, it, vi } from "vite-plus/test";
import { isDiagnosticsSettings } from "./diagnostics-settings";
import {
  classifyRuntimeFrame,
  createRuntimeWorkLedger,
  mergeRuntimeWork,
  runtimeWorkTotal,
} from "./runtime-work";
import type { BrowserOptions } from "@sentry/react";
import { createSentryPrivacyOptions } from "./sentry-options";
import { scrubSentryBreadcrumb, scrubSentryData, scrubSentryEvent } from "./sentry-scrub";
import { isTelemetrySettings } from "./telemetry-settings";

describe("diagnostics settings", () => {
  const VALID_SETTINGS = {
    enabled: true,
    active: true,
    blockedBy: null,
    dsn: "https://example.com/1",
    environment: "test",
    release: null,
    tracesSampleRate: 0,
    replayEnabled: true,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
    envOverrides: {
      enabled: false,
      dsn: false,
      environment: false,
      release: false,
      tracesSampleRate: false,
      replayEnabled: false,
      replaysSessionSampleRate: false,
      replaysOnErrorSampleRate: false,
    },
  };

  describe("diagnostics settings guard", () => {
    test("accepts a complete diagnostics settings payload", () => {
      expect(isDiagnosticsSettings(VALID_SETTINGS)).toBe(true);
    });

    test("rejects incomplete environment override state", () => {
      expect(
        isDiagnosticsSettings({
          ...VALID_SETTINGS,
          envOverrides: {
            enabled: false,
          },
        }),
      ).toBe(false);
    });

    test("rejects invalid trace sample rates", () => {
      expect(
        isDiagnosticsSettings({
          ...VALID_SETTINGS,
          tracesSampleRate: Number.POSITIVE_INFINITY,
        }),
      ).toBe(false);

      expect(
        isDiagnosticsSettings({
          ...VALID_SETTINGS,
          tracesSampleRate: 1.1,
        }),
      ).toBe(false);
    });

    test("rejects invalid replay sample rates", () => {
      expect(
        isDiagnosticsSettings({
          ...VALID_SETTINGS,
          replaysSessionSampleRate: Number.POSITIVE_INFINITY,
        }),
      ).toBe(false);

      expect(
        isDiagnosticsSettings({
          ...VALID_SETTINGS,
          replaysOnErrorSampleRate: -0.1,
        }),
      ).toBe(false);
    });
  });
});

describe("runtime work", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Runtime work ledger", () => {
    it("tallies each boundary of one work separately from other works", () => {
      const ledger = createRuntimeWorkLedger();
      ledger.record("w1-nav-1", "runtime.reply:thread.snapshot", 900, 12);
      ledger.record("w1-nav-1", "runtime.reply:thread.snapshot", 100, 3);
      ledger.record("w1-nav-1", "runtime.event:turn-item.updated:assistant_message", 40);
      ledger.record("w2-nav-1", "runtime.event:turn-item.updated:assistant_message", 40);
      expect(ledger.read("w1-nav-1")).toEqual({
        "runtime.reply:thread.snapshot": { count: 2, bytes: 1000, rows: 15 },
        "runtime.event:turn-item.updated:assistant_message": { count: 1, bytes: 40, rows: 0 },
      });
      expect(runtimeWorkTotal(ledger.read("w1-nav-1"), "runtime.")).toEqual({
        count: 3,
        bytes: 1040,
        rows: 15,
      });
      expect(
        mergeRuntimeWork([ledger.read("w1-nav-1"), ledger.read("w2-nav-1")])[
          "runtime.event:turn-item.updated:assistant_message"
        ],
      ).toEqual({ count: 2, bytes: 80, rows: 0 });
    });

    it("reports a work once after it has been quiet, so each report is one batch", () => {
      vi.useFakeTimers();
      const settled: unknown[] = [];
      const ledger = createRuntimeWorkLedger({
        settleMs: 1_000,
        onSettled: (work, reading) => settled.push({ work, reading }),
      });
      ledger.record("w1-read-1", "renderer.delivery:event", 10);
      vi.advanceTimersByTime(800);
      ledger.record("w1-read-1", "renderer.delivery:event", 10);
      vi.advanceTimersByTime(800);
      expect(settled).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(settled).toEqual([
        {
          work: "w1-read-1",
          reading: { "renderer.delivery:event": { count: 2, bytes: 20, rows: 0 } },
        },
      ]);
      // The next delivery starts a new batch.
      expect(ledger.read("w1-read-1")).toEqual({});
    });

    it("reports and forgets the oldest work beyond its capacity", () => {
      const settled: string[] = [];
      const ledger = createRuntimeWorkLedger({
        capacity: 2,
        onSettled: (work) => settled.push(work),
      });
      ledger.record("a", "renderer.install");
      ledger.record("b", "renderer.install");
      ledger.record("c", "renderer.install");
      expect(settled).toEqual(["a"]);
      expect(ledger.works()).toEqual(["b", "c"]);
      ledger.flush();
      expect(settled).toEqual(["a", "b", "c"]);
    });
  });

  describe("Runtime frame classification", () => {
    it("reads replies, observations and events by protocol discriminators only", () => {
      expect(
        classifyRuntimeFrame({
          id: "request",
          success: true,
          output: { projection: { visibleTurnItems: [{}, {}, {}] } },
        }),
      ).toEqual({ kind: "reply", id: "request", success: true, rows: 3 });
      expect(
        classifyRuntimeFrame({
          id: "observe",
          success: true,
          output: { subscribed: true, subscriptionId: "observe", afterSequence: 4 },
        }),
      ).toEqual({
        kind: "reply",
        id: "observe",
        success: true,
        rows: 0,
        subscriptionId: "observe",
      });
      expect(
        classifyRuntimeFrame({
          type: "event",
          subscriptionId: "observe",
          event: {
            sequence: 5,
            event: { type: "turn-item.updated", payload: { type: "reasoning" } },
          },
        }),
      ).toEqual({
        kind: "event",
        subscriptionId: "observe",
        metric: "runtime.event:turn-item.updated:reasoning",
      });
      expect(
        classifyRuntimeFrame({ type: "event.error", subscriptionId: "observe", message: "gap" }),
      ).toEqual({ kind: "event", subscriptionId: "observe", metric: "runtime.event:error" });
      expect(
        classifyRuntimeFrame({
          type: "event.item-patch",
          subscriptionId: "observe",
          sequence: 6,
          patch: { itemId: "item", append: { field: "text", offset: 4, text: "more" } },
        }),
      ).toEqual({ kind: "event", subscriptionId: "observe", metric: "runtime.event:item-patch" });
      expect(
        classifyRuntimeFrame({ type: "activity", rootThreadId: "root", sequence: 1 }),
      ).toBeNull();
    });
  });
});

describe("sentry options", () => {
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
});

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

describe("telemetry settings", () => {
  const VALID_SETTINGS = {
    enabled: true,
    active: false,
    blockedBy: "development-build",
    managed: false,
  };

  describe("telemetry settings guard", () => {
    test("accepts a complete payload, with or without a block", () => {
      expect(isTelemetrySettings(VALID_SETTINGS)).toBe(true);
      expect(isTelemetrySettings({ ...VALID_SETTINGS, active: true, blockedBy: null })).toBe(true);
    });

    test("rejects invalid or missing fields", () => {
      expect(isTelemetrySettings({ enabled: true })).toBe(false);
      expect(isTelemetrySettings({ ...VALID_SETTINGS, active: "yes" })).toBe(false);
      expect(isTelemetrySettings({ ...VALID_SETTINGS, blockedBy: "unknown-reason" })).toBe(false);
      expect(isTelemetrySettings(null)).toBe(false);
    });
  });
});
