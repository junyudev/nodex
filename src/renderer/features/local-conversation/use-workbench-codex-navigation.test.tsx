import type { PropsWithChildren } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../shared/workbench-layout";
import type { ProjectSession } from "../../../shared/types";
import { materializeInitialWorkbenchScene } from "../../../shared/workbench-scene";
import { createMaitaiStore, MaitaiProvider } from "../../lib/maitai";
import { useWorkbenchWindowOwner } from "../../lib/use-workbench-window-state";
import { makeAttachedSession } from "../../components/workbench/workbench-testkit/workbench-shell-fixtures";
import { codexThreadNavigation } from "./codex-thread-navigation";
import {
  dispatchWorkbenchCodexNavigation,
  useWorkbenchCodexNavigation,
} from "./use-workbench-codex-navigation";

const observations = vi.hoisted(() => ({
  spans: [] as Array<{ marks: string[]; outcomes: string[]; threadState: string }>,
  conversations: new Map<
    string,
    { canonicalState?: object; source?: { sideConversation: boolean } }
  >(),
  close: null as ((...args: unknown[]) => void) | null,
  closeAcknowledgements: [] as number[],
}));
vi.mock("./local-conversation-store", () => ({
  readLocalConversation: (threadId: string) => observations.conversations.get(threadId) ?? null,
}));
vi.mock("../../lib/app-close-flush-deps", () => ({
  readAppCloseBridge: () => ({
    on: (_name: string, callback: (...args: unknown[]) => void) => {
      observations.close = callback;
      return () => {};
    },
  }),
  notifyAppCloseFlushComplete: async (id: number) => {
    observations.closeAcknowledgements.push(id);
  },
}));
vi.mock("./codex-thread-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-thread-navigation")>();
  return {
    ...actual,
    codexThreadNavigation: new actual.CodexThreadNavigation((attributes, onTerminal) => {
      const state = {
        marks: [] as string[],
        outcomes: [] as string[],
        threadState: attributes.threadState,
      };
      observations.spans.push(state);
      const finish = (outcome: string) => {
        state.outcomes.push(outcome);
        onTerminal();
      };
      return {
        trace: { traceparent: String(observations.spans.length) },
        isRecording: () => state.outcomes.length === 0,
        mark: (name) => {
          state.marks.push(name);
        },
        measure: () => ({ end: () => {} }),
        end: () => finish("success"),
        abort: (reason) => finish(`aborted:${reason}`),
        fail: (reason) => finish(`failed:${reason}`),
        recordAnalyticsSuccess: () => true,
      };
    }),
  };
});

function harness(sessions: readonly ProjectSession[]) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const store = createMaitaiStore();
  function Wrapper({ children }: PropsWithChildren) {
    return <MaitaiProvider store={store}>{children}</MaitaiProvider>;
  }
  return renderHook(
    () => {
      const owner = useWorkbenchWindowOwner({
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: { kind: "pages" },
      });
      useWorkbenchCodexNavigation(owner, (id) => byId.get(id) ?? null);
      return owner;
    },
    { wrapper: Wrapper },
  );
}
afterEach(() => {
  cleanup();
  codexThreadNavigation.dispose();
  observations.spans.length = 0;
  observations.conversations.clear();
  observations.closeAcknowledgements.length = 0;
});

it("starts synchronously before a Thread mounts and retains that dispatch span through route entry and history navigation", async () => {
  const a = makeAttachedSession({ id: "a", threadId: "thread-a" });
  const b = makeAttachedSession({ id: "b", threadId: "thread-b" });
  observations.conversations.set("thread-b", { canonicalState: {} });
  const view = harness([a, b]);
  await act(async () => {
    view.result.current.selectSession(a);
    expect(observations.spans[0]?.marks).toEqual(["navigation_dispatched"]);
    const trace = codexThreadNavigation.getTrace("thread-a");
    codexThreadNavigation.start("thread-a", "warm", "local", "route_entered");
    expect(codexThreadNavigation.getTrace("thread-a")).toBe(trace);
    expect(observations.spans).toHaveLength(1);
    view.result.current.selectSession(b);
    expect(observations.spans[0]?.outcomes).toEqual(["aborted:superseded"]);
    expect(observations.spans[1]?.threadState).toBe("warm");
    view.result.current.navigateBack();
    expect(codexThreadNavigation.isPending("thread-a")).toBe(true);
    view.result.current.navigateForward();
    expect(codexThreadNavigation.isPending("thread-b")).toBe(true);
    await Promise.resolve();
  });
  expect(observations.spans).toHaveLength(4);
  expect(observations.spans.every((span) => span.marks[0] === "navigation_dispatched")).toBe(true);
});

it("keeps Pages, unknown or non-Codex Sessions and Side Chat panel changes out of native Thread navigation", async () => {
  const a = makeAttachedSession({ id: "a", threadId: "thread-a" });
  const native = makeAttachedSession({ id: "native", threadId: "claude-a" });
  native.thread!.backendBinding = { kind: "claude", instanceConfigId: "claude" };
  const blank = { ...a, id: "draft", thread: null };
  const side = makeAttachedSession({ id: "side", threadId: "side-a" });
  observations.conversations.set("side-a", { source: { sideConversation: true } });
  const view = harness([a, native, blank, side]);
  await act(async () => {
    view.result.current.selectSession(a);
    view.result.current.setScene(
      { kind: "session", sessionId: "a" },
      materializeInitialWorkbenchScene({ kind: "session", sessionId: "a" }),
    );
    expect(observations.spans).toHaveLength(1);
    view.result.current.selectPages();
    expect(observations.spans[0]?.outcomes).toEqual(["aborted:navigation_away"]);
    view.result.current.selectSession({ id: "unknown", projectId: null });
    view.result.current.selectSession(native);
    view.result.current.selectSession(blank);
    view.result.current.selectSession(side);
    dispatchWorkbenchCodexNavigation(null);
    dispatchWorkbenchCodexNavigation(native.thread);
    await Promise.resolve();
  });
  expect(observations.spans).toHaveLength(1);
});

it("disposes pending navigation through the actual app-close coordinator and removes that lifetime on unmount", async () => {
  const session = makeAttachedSession({ id: "a", threadId: "thread-a" });
  const view = harness([session]);
  await act(async () => {
    view.result.current.selectSession(session);
    observations.close?.(42);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(observations.spans[0]?.outcomes).toEqual(["aborted:app_disposed"]);
  expect(observations.closeAcknowledgements).toEqual([42]);
  view.unmount();
  codexThreadNavigation.start("independent", "cold");
  await act(async () => {
    observations.close?.(43);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(codexThreadNavigation.isPending("independent")).toBe(true);
});
