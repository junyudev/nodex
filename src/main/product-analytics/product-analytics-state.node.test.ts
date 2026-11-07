import { describe, expect, test } from "vite-plus/test";
import type { ProductEvent } from "../../shared/product-analytics/catalog";
import {
  admitLaunch,
  decodeState,
  deliveryOpen,
  dropExpired,
  dueBatch,
  encodeState,
  enqueue,
  initialState,
  MAX_BATCH_EVENTS,
  MAX_EVENT_AGE_MS,
  MAX_OUTBOX_EVENTS,
  NOTICE_GRACE_MS,
  removeDelivered,
  retryDelayMs,
  shouldRetryStatus,
  statsigRequest,
  type ProductAnalyticsState,
} from "./product-analytics-state";

const ID = "6f1f8f2e-1f0a-4c55-9d0e-2b7f0c8a1e11";
const active: ProductEvent = { name: "app_active", properties: {} };
const acknowledged = {
  ...initialState(ID),
  notice: { presentedAt: 0, acknowledgedAt: 0 },
};

describe("launch admission", () => {
  const launch = (state: ReturnType<typeof initialState>, appVersion: string) =>
    admitLaunch(state, { appVersion, profile: "new", time: 1 });
  const names = (state: ReturnType<typeof initialState>) =>
    state.outbox.map((entry) => entry.event.name);
  const launchKind = (state: ReturnType<typeof initialState>) => {
    const last = state.outbox.at(-1)?.event;
    return last?.name === "app_launched" ? last.properties.launch : null;
  };

  test("the first launch reports the installation exactly once", () => {
    const first = launch(initialState(ID), "1.0.0");
    expect(names(first)).toEqual(["installation_created", "app_launched"]);
    expect(launchKind(first)).toBe("first");
    const second = launch({ ...first, outbox: [] }, "1.0.0");
    expect(names(second)).toEqual(["app_launched"]);
    expect(launchKind(second)).toBe("returning");
  });

  test("a new version is an update, then returning", () => {
    const first = launch(initialState(ID), "1.0.0");
    const updated = launch(first, "1.1.0");
    expect(launchKind(updated)).toBe("updated");
    expect(launchKind(launch(updated, "1.1.0"))).toBe("returning");
  });
});

describe("delivery gate", () => {
  test("holds everything until the notice has been on screen long enough to act on", () => {
    const queued = enqueue(initialState(ID), active, 0);
    expect(deliveryOpen(queued, 10 ** 12)).toBe(false);
    expect(dueBatch(queued, { now: 10 ** 12, retryAt: null, force: true })).toEqual([]);
    const presented = { ...queued, notice: { presentedAt: 1_000, acknowledgedAt: null } };
    expect(deliveryOpen(presented, 1_000 + NOTICE_GRACE_MS - 1)).toBe(false);
    expect(deliveryOpen(presented, 1_000 + NOTICE_GRACE_MS)).toBe(true);
  });

  test("acknowledging opens delivery immediately", () => {
    expect(deliveryOpen(acknowledged, 0)).toBe(true);
  });
});

describe("batching", () => {
  const withEvents = (count: number, time = 0) => {
    let state: ProductAnalyticsState = acknowledged;
    for (let index = 0; index < count; index += 1) state = enqueue(state, active, time);
    return state;
  };

  test("waits for age or size, and sends a bounded batch", () => {
    expect(dueBatch(withEvents(1), { now: 1_000, retryAt: null })).toEqual([]);
    expect(dueBatch(withEvents(1), { now: 120_000, retryAt: null })).toHaveLength(1);
    expect(dueBatch(withEvents(25), { now: 1_000, retryAt: null })).toHaveLength(25);
    expect(dueBatch(withEvents(250), { now: 1_000, retryAt: null })).toHaveLength(MAX_BATCH_EVENTS);
  });

  test("does not retry before the backoff elapses, except a final forced attempt", () => {
    const state = withEvents(30);
    expect(dueBatch(state, { now: 1_000, retryAt: 2_000 })).toEqual([]);
    expect(dueBatch(state, { now: 2_000, retryAt: 2_000 })).toHaveLength(30);
    expect(dueBatch(state, { now: 1_000, retryAt: 2_000, force: true })).toHaveLength(30);
  });

  test("backoff doubles and is capped", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(50)).toBe(3_600_000);
  });

  test("only transient responses stay in the outbox", () => {
    for (const status of [408, 429, 500, 503]) expect(shouldRetryStatus(status)).toBe(true);
    for (const status of [202, 400, 401, 413]) expect(shouldRetryStatus(status)).toBe(false);
  });

  test("the outbox is bounded by count and age", () => {
    const full = withEvents(MAX_OUTBOX_EVENTS + 5);
    expect(full.outbox).toHaveLength(MAX_OUTBOX_EVENTS);
    expect(full.outbox[0]?.seq).toBeGreaterThan(1);
    const aged = enqueue(withEvents(2, 0), active, MAX_EVENT_AGE_MS);
    expect(dropExpired(aged, MAX_EVENT_AGE_MS + 1).outbox).toHaveLength(1);
  });

  test("removes exactly the delivered entries when more arrived during the request", () => {
    const before = withEvents(2);
    const delivered = before.outbox;
    const after = enqueue(before, active, 5);
    expect(removeDelivered(after, delivered).outbox.map((entry) => entry.time)).toEqual([5]);
  });
});

describe("persistence", () => {
  test("round-trips", () => {
    const state = admitLaunch(acknowledged, { appVersion: "1.0.0", profile: "existing", time: 9 });
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  test("a stored event that left the catalog is dropped, not sent", () => {
    const raw = JSON.parse(encodeState(enqueue(acknowledged, active, 1)));
    raw.outbox[0].event = { name: "retired_event", properties: { text: "hello" } };
    expect(decodeState(JSON.stringify(raw)).outbox).toEqual([]);
  });

  test("a malformed document is refused", () => {
    expect(() => decodeState("{nope")).toThrow();
    expect(() => decodeState(JSON.stringify({ schemaVersion: 2 }))).toThrow();
  });
});

describe("statsig request", () => {
  test("identifies the installation, not a person, and stringifies metadata", () => {
    const request = statsigRequest({
      installationId: ID,
      context: {
        appVersion: "1.2.3",
        channel: "nightly",
        tier: "production",
        os: "darwin",
        arch: "arm64",
        locale: "en-US",
      },
      entries: [
        {
          seq: 1,
          time: 42,
          event: {
            name: "thread_message_navigation",
            value: 7,
            properties: { ordinal: 3, item_count: 9 },
          },
        },
      ],
      now: 100,
    });
    expect(JSON.parse(request.body)).toEqual({
      user: {
        userID: ID,
        appVersion: "1.2.3",
        locale: "en-US",
        statsigEnvironment: { tier: "production" },
        custom: { channel: "nightly", os: "darwin", arch: "arm64" },
      },
      events: [
        {
          eventName: "thread_message_navigation",
          time: 42,
          value: 7,
          metadata: { ordinal: "3", item_count: "9" },
        },
      ],
      statsigMetadata: { sdkType: "nodex-desktop", sdkVersion: "1.2.3" },
    });
    expect(request.headers["statsig-client-time"]).toBe("100");
  });
});
