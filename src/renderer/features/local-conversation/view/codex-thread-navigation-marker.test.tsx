import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codexThreadNavigation } from "../codex-thread-navigation";
import { ConversationRuntimeContext, type ConversationRuntime } from "../conversation-runtime";
import { CodexThreadNavigationMarker } from "./codex-thread-navigation-marker";

const observations = vi.hoisted(() => ({
  spans: [] as Array<{
    attributes: { threadState: string; view?: Readonly<Record<string, string>> };
    marks: string[];
    outcomes: string[];
    measures: string[];
  }>,
}));
vi.mock("../codex-thread-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../codex-thread-navigation")>();
  return {
    ...actual,
    codexThreadNavigation: new actual.CodexThreadNavigation((attributes, onTerminal) => {
      const observation = {
        attributes,
        marks: [] as string[],
        outcomes: [] as string[],
        measures: [] as string[],
      };
      observations.spans.push(observation);
      const traceparent = String(observations.spans.length);
      const finish = (outcome: string) => {
        observation.outcomes.push(outcome);
        onTerminal();
      };
      return {
        get trace() {
          return { traceparent };
        },
        isRecording: () => observation.outcomes.length === 0,
        mark: (name) => {
          observation.marks.push(name);
        },
        measure: (name) => {
          observation.measures.push(name);
          return { end: () => {} };
        },
        end: () => finish("success"),
        abort: (reason) => finish(`aborted:${reason}`),
        fail: (reason) => finish(`failed:${reason}`),
        recordAnalyticsSuccess: () => true,
      };
    }),
  };
});

const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
let visibility: DocumentVisibilityState = "visible";
let serial = 0;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  visibility = "visible";
  serial = 0;
  frames.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});
afterEach(() => {
  cleanup();
  codexThreadNavigation.dispose();
  observations.spans.length = 0;
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

async function frame() {
  const next = frames.entries().next().value;
  if (!next) throw new Error("Missing scheduled paint frame");
  frames.delete(next[0]);
  await act(async () => {
    next[1](0);
    await Promise.resolve();
  });
}

it("completes a ready empty Thread after paint without execution hydration", async () => {
  render(<CodexThreadNavigationMarker threadId="empty" isSideChat={false} contentReady />);
  expect(codexThreadNavigation.isPending("empty")).toBe(true);
  expect(codexThreadNavigation.getTrace("empty")).not.toBe(codexThreadNavigation.getTrace("empty"));
  expect(observations.spans[0]?.attributes).toMatchObject({
    threadState: "warm",
    view: { state: "ready" },
  });
  expect(observations.spans[0]?.measures).toEqual(["thread.navigation_wait", "thread.render_wait"]);
  await frame();
  expect(observations.spans[0]?.outcomes).toEqual([]);
  await frame();
  expect(observations.spans[0]?.marks).toEqual([
    "route_entered",
    "hydration_finished",
    "content_visible",
  ]);
  expect(observations.spans[0]?.outcomes).toEqual(["success"]);
});

it("preserves the cold navigation when history becomes visible before execution resumes", async () => {
  const view = render(
    <CodexThreadNavigationMarker threadId="cold" isSideChat={false} contentReady={false} />,
  );
  expect(frames.size).toBe(0);
  codexThreadNavigation.hydrationStarted("cold");
  codexThreadNavigation.historyReady("cold");
  view.rerender(<CodexThreadNavigationMarker threadId="cold" isSideChat={false} contentReady />);
  expect(observations.spans).toHaveLength(1);
  expect(observations.spans[0]?.attributes.threadState).toBe("cold");
  await frame();
  await frame();
  expect(observations.spans[0]?.outcomes).toEqual(["success"]);
  codexThreadNavigation.hydrationFinished("cold");
  expect(observations.spans[0]?.marks).toEqual([
    "route_entered",
    "hydration_started",
    "history_ready",
    "hydration_finished",
    "content_visible",
  ]);
});

it("waits through hidden paint and releases the old route before a new Thread paints", async () => {
  const view = render(<CodexThreadNavigationMarker threadId="a" isSideChat={false} contentReady />);
  await frame();
  visibility = "hidden";
  await frame();
  expect(observations.spans[0]?.outcomes).toEqual([]);
  view.rerender(<CodexThreadNavigationMarker threadId="b" isSideChat={false} contentReady />);
  expect(observations.spans[0]?.outcomes).toEqual(["aborted:navigation_away"]);
  codexThreadNavigation.complete("a");
  expect(codexThreadNavigation.isPending("b")).toBe(true);
  expect(frames.size).toBe(0);
  visibility = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  await frame();
  await frame();
  expect(observations.spans[1]?.outcomes).toEqual(["success"]);
  view.unmount();
  expect(frames.size).toBe(0);
});

it("does not claim navigation ownership for Side Chat or runtime override surfaces", () => {
  codexThreadNavigation.start("root", "warm");
  const sideChat = render(<CodexThreadNavigationMarker threadId="side" isSideChat contentReady />);
  expect(codexThreadNavigation.isPending("root")).toBe(true);
  sideChat.unmount();
  const override: ConversationRuntime = {
    kind: "codex",
    hostId: "local",
    subscribe: () => () => {},
    read: () => null,
    attachment: () => ({ status: "idle" }),
    connection: () => ({ status: "disconnected", retries: 0 }),
    role: () => null,
    primaryRequest: () => null,
    children: () => [],
    retain: () => () => {},
    loadHistory: async () => {},
    resume: async () => {},
    markRead: async () => {},
    setPresented: async () => {},
  };
  render(
    <ConversationRuntimeContext.Provider value={override}>
      <CodexThreadNavigationMarker threadId="override" isSideChat={false} contentReady />
    </ConversationRuntimeContext.Provider>,
  );
  expect(codexThreadNavigation.isPending("root")).toBe(true);
  expect(observations.spans).toHaveLength(1);
  expect(frames.size).toBe(0);
});
