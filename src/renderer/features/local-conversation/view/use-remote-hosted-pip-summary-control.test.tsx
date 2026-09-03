import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { act } from "@testing-library/react";
import { useEffect } from "react";
import type { RemoteHostedPipTaskStateSnapshot } from "../../../../shared/remote-hosted-pip";
import { render, settleAsyncRender } from "../../../test/dom";
import { useRemoteHostedPipSummaryControl } from "./use-remote-hosted-pip-summary-control";

type IpcListener = (payload: unknown) => void;
type RemoteHostedPipSummaryControlValue = ReturnType<typeof useRemoteHostedPipSummaryControl>;

function Probe({ onValue }: { onValue: (value: RemoteHostedPipSummaryControlValue) => void }) {
  const value = useRemoteHostedPipSummaryControl("thread-1");
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

describe("useRemoteHostedPipSummaryControl", () => {
  const originalApi = window.api;
  let revisionListener: IpcListener | undefined;
  let snapshot: RemoteHostedPipTaskStateSnapshot;
  let visibilityResultOverride: RemoteHostedPipTaskStateSnapshot | null;
  let visibilityInputs: unknown[];

  beforeEach(() => {
    snapshot = {
      activeTaskIds: ["thread-1"],
      alwaysHidden: false,
      retainedPresentationCount: 1,
      revision: 1,
      taskVisibilityActionAvailable: true,
      taskVisibilities: {},
    };
    visibilityInputs = [];
    visibilityResultOverride = null;
    revisionListener = undefined;
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: async (channel: string, input?: unknown) => {
          if (channel === "remote-hosted-pip:snapshot") return snapshot;
          if (channel === "remote-hosted-pip:task-visibility:set") {
            visibilityInputs.push(input);
            if (visibilityResultOverride) return visibilityResultOverride;
            const visibility = (input as { visibility: "hidden" | "shown" }).visibility;
            snapshot = {
              ...snapshot,
              revision: snapshot.revision + 1,
              taskVisibilities: { "thread-1": visibility },
            };
            return snapshot;
          }
          throw new Error(`Unexpected IPC channel: ${channel}`);
        },
        on: (channel: string, callback: IpcListener) => {
          if (channel === "remote-hosted-pip:revision") revisionListener = callback;
          return () => {
            if (revisionListener === callback) revisionListener = undefined;
          };
        },
      },
      writable: true,
    });
  });

  afterEach(() => {
    if (typeof originalApi === "undefined") Reflect.deleteProperty(window, "api");
    else Object.defineProperty(window, "api", { configurable: true, value: originalApi });
  });

  test("derives the row only from the monotonic Main snapshot", async () => {
    let latest: RemoteHostedPipSummaryControlValue | undefined;
    const view = render(<Probe onValue={(value) => void (latest = value)} />);
    await settleAsyncRender();
    expect(latest?.summaryComputerUsePip?.visible).toBe(true);

    snapshot = {
      ...snapshot,
      revision: 2,
      taskVisibilities: { "thread-1": "hidden" },
    };
    await act(async () => {
      revisionListener?.({ revision: 2 });
      await settleAsyncRender();
    });
    expect(latest?.summaryComputerUsePip?.visible).toBe(false);

    await act(async () => {
      await latest?.onToggleSummaryComputerUsePip(true);
      await settleAsyncRender();
    });
    expect(visibilityInputs).toEqual([{ taskId: "thread-1", visibility: "shown" }]);
    expect(latest?.summaryComputerUsePip?.visible).toBe(true);

    snapshot = {
      ...snapshot,
      revision: 5,
      taskVisibilities: { "thread-1": "hidden" },
    };
    await act(async () => {
      revisionListener?.({ revision: 5 });
      await settleAsyncRender();
    });
    visibilityResultOverride = {
      ...snapshot,
      revision: 3,
      taskVisibilities: { "thread-1": "shown" },
    };
    await act(async () => {
      void latest?.onToggleSummaryComputerUsePip(true);
      await settleAsyncRender();
    });
    expect(latest?.summaryComputerUsePip?.visible).toBe(false);

    visibilityResultOverride = null;
    snapshot = { ...snapshot, activeTaskIds: [], revision: 6 };
    await act(async () => {
      revisionListener?.({ revision: 6 });
      await settleAsyncRender();
    });
    expect(latest?.summaryComputerUsePip).toBe(null);

    snapshot = {
      ...snapshot,
      activeTaskIds: ["thread-1"],
      revision: 7,
      taskVisibilityActionAvailable: false,
    };
    await act(async () => {
      revisionListener?.({ revision: 7 });
      await settleAsyncRender();
    });
    expect(latest?.summaryComputerUsePip).toBe(null);

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(revisionListener).toBeUndefined();
  });
});
