import { describe, expect, test } from "vite-plus/test";
import type { MainTraceSpanOptions } from "../observability/sentry-main";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import { makeCodexRequestTraceCoordinator } from "./CodexRequestTraceCoordinator";

const TRACE = {
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};

describe("CodexRequestTraceCoordinator", () => {
  test("moves a settled turn from parent delivery to linked delivery and deduplicates methods", () => {
    let now = 1_000;
    const coordinator = makeCodexRequestTraceCoordinator({ now: () => now });
    coordinator.trackRequest({
      method: "turn/start",
      requestId: "turn-1",
      threadId: "thread-1",
      trace: TRACE,
      webContentsId: 7,
    });

    const before = coordinator.takeNotificationDelivery("thread-1", "turn/started", 1_010);
    expect(before?.recipients.get(7)).toEqual({ link: false, trace: TRACE });
    expect(coordinator.takeNotificationDelivery("thread-1", "turn/started", 1_011)).toBeUndefined();

    coordinator.settleRequest("thread-1", 7, "turn-1", true);
    now = 1_020;
    const after = coordinator.takeNotificationDelivery("thread-1", "item/started", 1_020);
    expect(after?.recipients.get(7)).toEqual({ link: true, trace: TRACE });
  });

  test("binds the only pending thread start from thread/started", () => {
    const coordinator = makeCodexRequestTraceCoordinator({ now: () => 5_000 });
    coordinator.trackRequest({
      method: "thread/start",
      requestId: "start-1",
      trace: TRACE,
      webContentsId: 9,
    });

    const delivery = coordinator.takeNotificationDelivery("thread-new", "thread/started", 5_010);
    expect(delivery?.recipients.get(9)).toEqual({ link: false, trace: TRACE });
    coordinator.settleRequest("thread-new", 9, "start-1", true);
    expect(
      coordinator.takeNotificationDelivery("thread-new", "item/started", 5_020)?.recipients.get(9),
    ).toEqual({ link: true, trace: TRACE });
  });

  test("resets app discovery delivery after a successful response", () => {
    const coordinator = makeCodexRequestTraceCoordinator({ now: () => 10_000 });
    coordinator.trackRequest({
      method: "app/list",
      requestId: "apps-1",
      trace: TRACE,
      webContentsId: 3,
    });
    expect(
      coordinator.takeNotificationDelivery(null, "app/list/updated", 10_010)?.recipients.get(3),
    ).toEqual({ link: false, trace: TRACE });
    expect(coordinator.takeNotificationDelivery(null, "app/list/updated", 10_011)).toBeUndefined();
    coordinator.settleRequest(null, 3, "apps-1", true);
    expect(
      coordinator.takeNotificationDelivery(null, "app/list/updated", 10_012)?.recipients.get(3),
    ).toEqual({ link: true, trace: TRACE });
  });

  test("records a bounded streaming window and closes it on turn completion", () => {
    let now = 20_000;
    const spans: MainTraceSpanOptions[] = [];
    const runSpan = <A>(
      options: MainTraceSpanOptions,
      callback: (trace: CodexRequestTraceContext | null) => A,
    ): A => {
      spans.push(options);
      return callback(options.trace ?? null);
    };
    const coordinator = makeCodexRequestTraceCoordinator({ now: () => now, runSpan });
    coordinator.trackRequest({
      method: "turn/start",
      requestId: "turn-2",
      threadId: "thread-2",
      trace: TRACE,
      webContentsId: 4,
    });
    coordinator.takeNotificationDelivery("thread-2", "turn/started", 20_100);
    now = 40_000;
    coordinator.takeNotificationDelivery("thread-2", "item/started", 40_000);
    coordinator.takeNotificationDelivery("thread-2", "turn/completed", 40_100);

    expect(spans).toEqual([
      expect.objectContaining({
        name: "app_server.streaming_window",
        startTimeMs: 20_100,
        endTimeMs: 35_100,
        attributes: expect.objectContaining({
          "app_server.notification_count": 1,
          "app_server.streaming_window_end": "window",
        }),
      }),
      expect.objectContaining({
        startTimeMs: 40_000,
        endTimeMs: 40_100,
        attributes: expect.objectContaining({
          "app_server.notification_count": 2,
          "app_server.streaming_window_end": "completed",
        }),
      }),
    ]);
  });
});
