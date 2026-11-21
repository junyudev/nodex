import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { CodexPerformanceSpan } from "../../lib/codex-performance-span";
import {
  RuntimeConversationNavigation,
  type RuntimeNavigationRecord,
} from "./runtime-conversation-navigation";

const chat = { sessionId: "session", threadId: "thread" };
const other = { sessionId: "other", threadId: "other-thread" };

function setup(options: { readonly local?: boolean; readonly tracing?: boolean } = {}) {
  let now = 1_000;
  const records: RuntimeNavigationRecord[] = [];
  const spans: { readonly marks: string[]; terminal: string | null }[] = [];
  const navigation = new RuntimeConversationNavigation({
    now: () => now,
    recordsLocally: () => options.local ?? true,
    report: (record) => records.push(record),
    startSpan: (): CodexPerformanceSpan => {
      const span = { marks: [] as string[], terminal: null as string | null };
      spans.push(span);
      return {
        trace: null,
        abort: (reason) => {
          span.terminal = `aborted:${reason}`;
        },
        end: () => {
          span.terminal = "success";
        },
        fail: (reason) => {
          span.terminal = `failure:${reason}`;
        },
        isRecording: () => options.tracing ?? false,
        mark: (name) => span.marks.push(name),
        measure: () => ({ end: () => {} }),
        recordAnalyticsSuccess: () => false,
      };
    },
  });
  return {
    navigation,
    records,
    spans,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Runtime conversation navigation", () => {
  test("records dispatch through first painted content without trace sampling", () => {
    const { navigation, records, advance } = setup();
    navigation.dispatch(chat, { resident: false });
    expect(navigation.workId(chat)).toBe("nav-1");
    const leave = navigation.enter(chat, { resident: false, provider: "claude" });
    for (const stage of [
      "snapshot_requested",
      "snapshot_received",
      "projection_installed",
    ] as const) {
      advance(10);
      navigation.mark(chat, stage);
    }
    advance(5);
    navigation.committed(chat, false);
    advance(20);
    navigation.visible(chat);
    leave();

    expect(records).toEqual([
      {
        attempt: 1,
        workId: "nav-1",
        cohort: "cold",
        provider: "claude",
        stages: {
          navigation_dispatched: 0,
          route_entered: 0,
          snapshot_requested: 10,
          snapshot_received: 20,
          projection_installed: 30,
          content_committed: 35,
        },
        outcome: "success",
        reason: "content_visible",
        durationMs: 55,
        work: null,
      },
    ]);
    expect(navigation.workId(chat)).toBeNull();
  });

  test("names its cohort from what the window already holds", () => {
    const { navigation, records } = setup();
    for (const resident of [false, false, true]) {
      navigation.dispatch(chat, { resident });
      navigation.committed(chat, false);
      navigation.visible(chat);
    }
    expect(records.map((record) => record.cohort)).toEqual(["cold", "warm", "cache"]);
  });

  test("ends a conversation without items as visibly empty, and nothing before a commit", () => {
    const { navigation, records } = setup();
    navigation.dispatch(chat, { resident: false });
    navigation.visible(chat);
    expect(records).toEqual([]);
    navigation.committed(chat, true);
    navigation.visible(chat);
    expect(records.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
      { outcome: "success", reason: "empty_visible" },
    ]);
  });

  test("gives cancelled, superseded, re-entered and failed navigations their own outcome", () => {
    const { navigation, records } = setup();
    navigation.dispatch(chat, { resident: false });
    navigation.routeChanged(null);
    navigation.dispatch(chat, { resident: false });
    navigation.dispatch(other, { resident: false });
    navigation.dispatch(other, { resident: false });
    navigation.mark(other, "snapshot_requested");
    navigation.failed(other);
    navigation.dispatch(chat, { resident: false });
    navigation.dispose();
    expect(records.map(({ attempt, outcome, reason }) => ({ attempt, outcome, reason }))).toEqual([
      { attempt: 1, outcome: "aborted", reason: "navigation_away" },
      { attempt: 2, outcome: "aborted", reason: "superseded" },
      { attempt: 3, outcome: "aborted", reason: "reentered" },
      { attempt: 4, outcome: "failure", reason: "snapshot_failed" },
      { attempt: 5, outcome: "aborted", reason: "app_disposed" },
    ]);
  });

  test("survives a surface remount and ends once every surface has left", () => {
    vi.useFakeTimers();
    const { navigation, records } = setup();
    const first = navigation.enter(chat, { resident: false, provider: "codex" });
    first();
    const remounted = navigation.enter(chat, { resident: false, provider: "codex" });
    vi.runAllTimers();
    expect(navigation.isPending(chat)).toBe(true);
    remounted();
    vi.runAllTimers();
    expect(records.map(({ outcome, reason, stages }) => ({ outcome, reason, stages }))).toEqual([
      {
        outcome: "aborted",
        reason: "navigation_away",
        stages: { navigation_dispatched: 0, route_entered: 0 },
      },
    ]);
  });

  test("exports to tracing alone when local metrics are off, and costs nothing with neither", () => {
    const traced = setup({ local: false, tracing: true });
    traced.navigation.dispatch(chat, { resident: false });
    traced.navigation.mark(chat, "snapshot_requested");
    traced.navigation.committed(chat, false);
    traced.navigation.visible(chat);
    expect(traced.records).toEqual([]);
    expect(traced.spans[0]).toEqual({
      marks: ["navigation_dispatched", "snapshot_requested", "content_committed"],
      terminal: "success",
    });

    const silent = setup({ local: false, tracing: false });
    silent.navigation.dispatch(chat, { resident: false });
    expect(silent.navigation.isPending(chat)).toBe(false);
    expect(silent.navigation.workId(chat)).toBeNull();
  });
});
