import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeWorkLedger } from "../../../../shared/diagnostics/runtime-work";
import { replaceRendererRuntimeWork } from "../../../lib/runtime-work";
import { ConversationRuntimeContext, type ConversationRuntime } from "../conversation-runtime";
import type { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { runtimeConversationNavigation } from "../runtime-conversation-navigation";
import type { RuntimeNavigationRecord } from "../runtime-conversation-navigation";
import {
  RuntimeConversationNavigationMarker,
  RuntimeTranscriptWork,
} from "./runtime-conversation-work";

const observed = vi.hoisted(() => ({ records: [] as RuntimeNavigationRecord[] }));
vi.mock("../runtime-conversation-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-conversation-navigation")>();
  return {
    ...actual,
    runtimeConversationNavigation: new actual.RuntimeConversationNavigation({
      recordsLocally: () => true,
      report: (record) => observed.records.push(record),
    }),
  };
});
vi.mock("../agent-runtime-conversation-owner", () => ({
  isAgentRuntimeConversationResident: () => false,
  agentRuntimeConversationWork: () => "nav-1",
}));

const frames = new Map<number, FrameRequestCallback>();
let serial = 0;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

beforeEach(() => {
  frames.clear();
  serial = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
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
  runtimeConversationNavigation.dispose();
  observed.records.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

async function paint() {
  for (let index = 0; index < 2; index += 1) {
    const next = frames.entries().next().value;
    if (!next) throw new Error("Missing scheduled paint frame");
    frames.delete(next[0]);
    await act(async () => {
      next[1](0);
      await Promise.resolve();
    });
  }
}

/** A Runtime conversation whose current projection the test installs. */
function conversation() {
  let projection: "pending" | "empty" | "content" = "pending";
  const listeners = new Set<() => void>();
  const readOwner = {
    readStructure: () =>
      projection === "pending"
        ? null
        : { turns: projection === "content" ? [{ itemIds: ["item"] }] : [{ itemIds: [] }] },
  } as unknown as CodexTranscriptReadOwner;
  const runtime = {
    kind: "claude",
    hostId: "local",
    sessionId: "session",
    subscribe: (_threadId: string | null, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    contentSource: () =>
      projection === "pending" ? null : { identity: "current", isCurrent: () => true },
    transcriptReadOwner: () => readOwner,
  } as unknown as ConversationRuntime;
  return {
    runtime,
    install: async (next: "empty" | "content") => {
      await act(async () => {
        projection = next;
        for (const listener of listeners) listener();
        await Promise.resolve();
      });
    },
  };
}

const renderMarker = (runtime: ConversationRuntime) =>
  render(
    <ConversationRuntimeContext.Provider value={runtime}>
      <RuntimeConversationNavigationMarker threadId="thread" isSideChat={false} />
    </ConversationRuntimeContext.Provider>,
  );

it("ends a navigation once the installed projection with content has painted", async () => {
  const { runtime, install } = conversation();
  runtimeConversationNavigation.dispatch(
    { sessionId: "session", threadId: "thread" },
    { resident: false },
  );
  renderMarker(runtime);
  expect(frames.size).toBe(0);
  await install("content");
  expect(observed.records).toEqual([]);
  await paint();
  expect(observed.records).toMatchObject([
    {
      cohort: "cold",
      provider: "claude",
      outcome: "success",
      reason: "content_visible",
      stages: {
        navigation_dispatched: expect.any(Number),
        route_entered: expect.any(Number),
        content_committed: expect.any(Number),
      },
    },
  ]);
});

it("ends a conversation without items as visibly empty", async () => {
  const { runtime, install } = conversation();
  renderMarker(runtime);
  await install("empty");
  await paint();
  expect(observed.records.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
    { outcome: "success", reason: "empty_visible" },
  ]);
});

it("cancels a navigation whose surface left before anything painted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { runtime } = conversation();
  const view = renderMarker(runtime);
  view.unmount();
  await act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
  });
  expect(observed.records.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
    { outcome: "aborted", reason: "navigation_away" },
  ]);
});

it("counts each transcript commit under the conversation's current work", async () => {
  const ledger = createRuntimeWorkLedger();
  const restore = replaceRendererRuntimeWork(ledger);
  try {
    const { runtime } = conversation();
    const transcript = (value: number) => (
      <ConversationRuntimeContext.Provider value={runtime}>
        <RuntimeTranscriptWork threadId="thread">
          <span>{value}</span>
        </RuntimeTranscriptWork>
      </ConversationRuntimeContext.Provider>
    );
    const view = render(transcript(0));
    await act(async () => {
      view.rerender(transcript(1));
      await Promise.resolve();
    });
    expect(ledger.read("nav-1")["renderer.commit"]?.count).toBe(2);
  } finally {
    restore();
  }
});
