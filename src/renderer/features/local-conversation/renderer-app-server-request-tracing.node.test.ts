import { afterEach, expect, it, vi } from "vitest";

const spans: Array<{
  readonly name: string;
  readonly spanId: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  ended: number;
}> = [];

vi.mock("@sentry/react", () => ({
  continueTrace: (_options: unknown, callback: () => unknown) => callback(),
  withActiveSpan: (_span: unknown, callback: () => unknown) => callback(),
  startInactiveSpan: ({
    name,
    attributes,
  }: {
    readonly name: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }) => {
    const spanId = (spans.length + 1).toString(16).padStart(16, "0");
    const record = { name, spanId, attributes, ended: 0 };
    spans.push(record);
    return {
      isRecording: () => true,
      spanContext: () => ({
        traceId: "1".repeat(32),
        spanId,
        traceFlags: 1,
      }),
      setAttribute: () => undefined,
      setStatus: () => undefined,
      end: () => {
        record.ended += 1;
      },
    };
  },
}));

import { startCodexServerResponseInteractionTrace } from "./codex-request-interaction-trace";
import { RendererAppServerRequestClient } from "./renderer-app-server-request-client";

afterEach(() => {
  vi.useRealTimers();
  spans.length = 0;
});

it("sends the automatically created interaction trace at the dispatch boundary", async () => {
  using client = new RendererAppServerRequestClient(async () => {}, "local");
  let observedTrace: unknown;
  await client.sendNative(
    "thread/read",
    async (_caller, trace) => {
      observedTrace = trace;
      return { type: "result" as const, result: "ok" };
    },
    { requestId: "read" },
  );

  expect(observedTrace).toEqual({
    traceparent: `00-${"1".repeat(32)}-0000000000000002-01`,
  });
  expect(spans.map(({ name }) => name)).toEqual([
    "desktop.app_server_request",
    "app_server.client",
    "app_server.renderer_queue_wait",
  ]);
  expect(spans[0]?.ended).toBe(1);
  expect(spans[1]?.ended).toBe(1);
});

it("groups concurrent discovery requests for the same host under one interaction trace", async () => {
  using client = new RendererAppServerRequestClient(async () => {}, "local");
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const traces: unknown[] = [];
  const first = client.sendNative(
    "app/list",
    async (_caller, trace) => {
      traces.push(trace);
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      return { type: "result" as const, result: "first" };
    },
    { requestId: "first" },
  );
  const second = client.sendNative(
    "plugin/list",
    async (_caller, trace) => {
      traces.push(trace);
      await new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      return { type: "result" as const, result: "second" };
    },
    { requestId: "second" },
  );

  expect(traces).toHaveLength(2);
  expect(traces[0]).toEqual(traces[1]);
  expect(spans.filter(({ name }) => name === "desktop.workspace_discovery")).toHaveLength(1);
  expect(spans.filter(({ name }) => name === "app_server.discovery")).toHaveLength(1);

  finishFirst();
  await first;
  expect(spans.find(({ name }) => name === "app_server.discovery")?.ended).toBe(0);
  finishSecond();
  await second;
  expect(spans.find(({ name }) => name === "app_server.discovery")?.ended).toBe(1);
});

it("preserves an explicit request trace without creating another interaction", async () => {
  using client = new RendererAppServerRequestClient(async () => {}, "local");
  const explicit = {
    traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  };
  let observedTrace: unknown;
  await client.sendNative(
    "turn/start",
    async (_caller, trace) => {
      observedTrace = trace;
      return { type: "result" as const, result: "ok" };
    },
    { requestId: "turn", trace: explicit },
  );

  expect(observedTrace).toEqual(explicit);
  expect(spans.map(({ name }) => name)).toEqual(["app_server.renderer_queue_wait"]);
});

it("classifies server responses as tool or approval traces and skips current time", () => {
  const tool = startCodexServerResponseInteractionTrace("item/tool/requestOptionPicker");
  expect(tool?.trace).toEqual({
    traceparent: `00-${"1".repeat(32)}-0000000000000002-01`,
  });
  tool?.finish();

  const approval = startCodexServerResponseInteractionTrace(
    "item/commandExecution/requestApproval",
  );
  expect(approval?.trace).toEqual({
    traceparent: `00-${"1".repeat(32)}-0000000000000004-01`,
  });
  approval?.finish();

  expect(startCodexServerResponseInteractionTrace("currentTime/read")).toBeNull();
  expect(spans.map(({ name }) => name)).toEqual([
    "desktop.tool_response",
    "tool.response",
    "desktop.approval_response",
    "approval.response",
  ]);
  expect(spans.map(({ attributes }) => attributes)).toEqual([
    { "app_server.method": "item/tool/requestOptionPicker" },
    { "app_server.method": "item/tool/requestOptionPicker" },
    { "app_server.method": "item/commandExecution/requestApproval" },
    { "app_server.method": "item/commandExecution/requestApproval" },
  ]);
});
