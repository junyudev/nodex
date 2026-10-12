import { describe, expect, it } from "vitest";
import type { CodexPerformanceSpan } from "../../lib/codex-performance-span";
import { CodexThreadNavigation } from "./codex-thread-navigation";

function harness() {
  const spans: Array<{
    marks: string[];
    measures: string[];
    ended: string[];
    outcomes: string[];
    attributes: unknown;
  }> = [];
  const owner = new CodexThreadNavigation((attributes, onTerminal) => {
    const state = {
      marks: [] as string[],
      measures: [] as string[],
      ended: [] as string[],
      outcomes: [] as string[],
      attributes,
    };
    spans.push(state);
    const finish = (outcome: string) => {
      state.outcomes.push(outcome);
      onTerminal();
    };
    const span: CodexPerformanceSpan = {
      trace: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" },
      isRecording: () => state.outcomes.length === 0,
      mark: (name) => {
        state.marks.push(name);
      },
      measure: (name) => {
        state.measures.push(name);
        let ended = false;
        return {
          end: () => {
            if (!ended) state.ended.push(name);
            ended = true;
          },
        };
      },
      abort: (reason) => finish(`aborted:${reason}`),
      fail: (reason) => finish(`failed:${reason}`),
      end: () => finish("success"),
      recordAnalyticsSuccess: () => true,
    };
    return span;
  });
  return { owner, spans };
}

describe("Thread navigation measurement owner", () => {
  it("supersedes A and ignores its late hydration and paint while B is pending", () => {
    const { owner, spans } = harness();
    owner.start("a", "cold");
    owner.hydrationStarted("a");
    owner.start("b", "warm");
    owner.hydrationFinished("a");
    owner.historyReady("a");
    owner.complete("a");
    expect(spans[0]?.outcomes).toEqual(["aborted:superseded"]);
    expect(owner.isPending("b")).toBe(true);
    owner.hydrationStarted("b");
    owner.hydrationFinished("b");
    owner.historyReady("b");
    owner.complete("b");
    owner.complete("b");
    expect(spans[1]?.marks).toEqual([
      "navigation_dispatched",
      "hydration_started",
      "hydration_finished",
      "history_ready",
      "content_visible",
    ]);
    expect(spans[1]?.ended).toEqual(["thread.navigation_wait", "thread.render_wait"]);
    expect(spans[1]?.outcomes).toEqual(["success"]);
    expect(owner.isPending("b")).toBe(false);
    expect(owner.getTrace("a")).toBeNull();
  });

  it("keeps selected view identity while an older view cleanup runs", () => {
    const { owner, spans } = harness();
    const old = owner.viewEntered("a", { kind: "detail" });
    const current = owner.viewEntered("b", { kind: "side_chat" });
    old();
    owner.start("b", "warm", "local", "route_entered");
    expect(spans[0]?.attributes).toMatchObject({ view: { kind: "side_chat" } });
    current();
    owner.viewEntered("b", { kind: "detail" });
    expect(spans[0]?.attributes).toMatchObject({ view: { kind: "detail" } });
    owner.dispose();
    expect(spans[0]?.outcomes).toEqual(["aborted:app_disposed"]);
  });

  it("settles failures, cancellation and navigation away once", () => {
    const { owner, spans } = harness();
    owner.start("a", "cold");
    owner.hydrationFailed("a", new Error("native unavailable"));
    owner.hydrationFailed("a", new Error("duplicate"));
    owner.start("b", "cold");
    owner.hydrationFailed("b", new DOMException("canceled", "AbortError"));
    owner.start("c", "warm");
    owner.routeChanged("c");
    expect(owner.isPending("c")).toBe(true);
    owner.routeChanged(null);
    owner.dispose();
    expect(spans.map((span) => span.outcomes)).toEqual([
      ["failed:hydration_failed"],
      ["aborted:hydration_canceled"],
      ["aborted:navigation_away"],
    ]);
  });
});
