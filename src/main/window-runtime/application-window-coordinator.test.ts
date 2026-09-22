import type { BrowserWindow } from "electron";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vite-plus/test";
import type { WindowSessionRecord } from "../../shared/window-session";
import type { AcquiredWindowSession } from "../window-session-state";
import type { WindowRuntimeService } from "./WindowRuntime";
import { createApplicationWindowCoordinator } from "./application-window-coordinator";
import type { WindowCleanupReport } from "./WindowShutdown";

const cleanReport: WindowCleanupReport = {
  alreadyClosed: 0,
  destroyed: 0,
  failed: 0,
  failures: [],
  graceful: 0,
  total: 0,
};

const session = (id: string): WindowSessionRecord => ({ id }) as WindowSessionRecord;

const browserWindow = (id: number, sent: string[] = []): BrowserWindow =>
  ({
    focus: vi.fn(),
    isDestroyed: () => false,
    isMinimized: () => false,
    show: vi.fn(),
    webContents: {
      id,
      isDestroyed: () => false,
      send: (channel: string) => sent.push(channel),
    },
  }) as unknown as BrowserWindow;

describe("application window coordinator", () => {
  test("reopens a primary window and delivers recording navigation after renderer readiness", () => {
    const sent: string[] = [];
    const window = browserWindow(7, sent);
    const send = vi.spyOn(window.webContents, "send");
    let current: BrowserWindow | null = null;
    let initialized = false;
    const create = vi.fn(() => {
      current = window;
      return window;
    });
    const coordinator = createApplicationWindowCoordinator({
      closeAll: () => Effect.succeed(cleanReport),
      create,
      focusedWindow: () => null,
      reportFailure: vi.fn(),
      syncTitle: vi.fn(),
      windows: {
        acquireSessionForNewWindow: () => ({ kind: "new", session: session("recovery") }),
        getLastFocused: () => current,
        get: () => current,
        isRendererInitialized: () => initialized,
      } as unknown as WindowRuntimeService,
    });
    expect(coordinator.openDictationRecording("recording-a")).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    initialized = true;
    coordinator.flushDictationRecording(8);
    expect(send).not.toHaveBeenCalled();
    coordinator.flushDictationRecording(7);
    coordinator.flushDictationRecording(7);
    expect(send).toHaveBeenCalledExactlyOnceWith("dictation:open-recording", {
      recordingId: "recording-a",
    });
    expect(coordinator.openDictationRecording("recording-b")).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(send).toHaveBeenLastCalledWith("dictation:open-recording", {
      recordingId: "recording-b",
    });
    coordinator.stop();
    expect(coordinator.openDictationRecording("recording-c")).toBe(false);
  });

  test("delegates a new-window request to an initialized renderer and stops ingress", () => {
    const sent: string[] = [];
    const source = browserWindow(7, sent);
    const create = vi.fn();
    const coordinator = createApplicationWindowCoordinator({
      closeAll: () => Effect.succeed(cleanReport),
      create,
      focusedWindow: () => source,
      reportFailure: vi.fn(),
      syncTitle: vi.fn(),
      windows: {
        getLastFocused: () => source,
        hasClosedSessionAvailable: () => false,
        isRendererInitialized: () => true,
      } as unknown as WindowRuntimeService,
    });

    coordinator.requestNew();
    expect(sent).toEqual(["request-new-window"]);
    expect(create).not.toHaveBeenCalled();

    coordinator.stop();
    coordinator.requestNew();
    expect(sent).toEqual(["request-new-window"]);
  });

  test("rolls back a reopened durable session when native window creation fails", () => {
    const reopened = session("window-reopened");
    const previousRecord = session("window-reopened");
    const acquired = {
      kind: "reopened",
      session: reopened,
      previousRecord,
    } as AcquiredWindowSession;
    const rollback = vi.fn();
    const reportFailure = vi.fn();
    const coordinator = createApplicationWindowCoordinator({
      closeAll: () => Effect.succeed(cleanReport),
      create: () => {
        throw new Error("native creation failed");
      },
      focusedWindow: () => null,
      reportFailure,
      syncTitle: vi.fn(),
      windows: {
        acquireSessionForNewWindow: () => acquired,
        getLastFocused: () => null,
        hasClosedSessionAvailable: () => true,
        rollbackReopenSession: rollback,
      } as unknown as WindowRuntimeService,
    });

    coordinator.requestNew();

    expect(rollback).toHaveBeenCalledWith(previousRecord);
    expect(reportFailure).toHaveBeenCalledWith({
      cause: expect.any(Error),
      operation: "acquire",
      windowSessionId: "window-reopened",
    });
  });

  it.effect("clones explicit Project context and owns quit preparation", () =>
    Effect.gen(function* () {
      const cloned = session("window-cloned");
      const created = browserWindow(9);
      const create = vi.fn(() => created);
      const beginApplicationQuit = vi.fn();
      const closeAll = vi.fn(() => Effect.succeed(cleanReport));
      const all = [created];
      const cloneSessionForWindow = vi.fn(() => cloned);
      const coordinator = createApplicationWindowCoordinator({
        closeAll,
        create,
        focusedWindow: () => null,
        reportFailure: vi.fn(),
        syncTitle: vi.fn(),
        windows: {
          all: () => all,
          beginApplicationQuit,
          cloneSessionForWindow,
        } as unknown as WindowRuntimeService,
      });

      coordinator.openForRequest(3, { activeProjectSessionId: "session-1" });
      expect(cloneSessionForWindow).toHaveBeenCalledWith(3, {
        activeProjectSessionId: "session-1",
      });
      expect(create).toHaveBeenCalledWith(cloned);
      expect(created.show).toHaveBeenCalledOnce();
      expect(created.focus).toHaveBeenCalledOnce();

      yield* coordinator.prepareQuit;
      expect(beginApplicationQuit).toHaveBeenCalledOnce();
      expect(closeAll).toHaveBeenCalledWith(all);
      coordinator.openForRequest(3, { activeProjectSessionId: "session-1" });
      expect(create).toHaveBeenCalledOnce();
    }),
  );
});
