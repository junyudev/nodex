import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexRealtimeVoiceEvent,
  CodexRealtimeVoiceGrant,
  CodexRealtimeVoiceSnapshot,
  CodexRealtimeVoiceTarget,
} from "../../../shared/codex-realtime-voice";
import { NodexTooltipProvider } from "../../components/ui/tooltip";
import { NodexToastProvider, __resetNodexToastStoreForTests } from "../../components/ui/toast";
import type {
  RealtimeVoiceMedia,
  RealtimeVoiceMediaInput,
} from "../../lib/realtime-voice/realtime-voice-media";
import { installWindowApi } from "../../test/browser-globals";
import { render } from "../../test/dom";
import { createTestQueryClient, TestQueryProvider } from "../../test/query";
import {
  realtimeVoiceAvailabilityQueryOptions,
  type RealtimeVoiceClient,
} from "./realtime-voice-client";
import { RealtimeVoiceControls } from "./realtime-voice-controls";
import {
  createRealtimeVoiceWindowOwner,
  type RealtimeVoiceWindowOwner,
} from "./realtime-voice-window-owner";
import { RealtimeVoiceWindowProvider, useComposerRealtimeVoice } from "./realtime-voice-window";

const mediaFactory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../lib/realtime-voice/realtime-voice-media", () => ({
  createRealtimeVoiceMedia: mediaFactory.create,
}));

const target = { hostId: "local", threadId: "thread" };
const grant: CodexRealtimeVoiceGrant = {
  ...target,
  claimId: "019a1240-1000-7000-8000-000000000001",
  realtimeSessionId: "019a1240-1000-7000-8000-000000000002",
  microphoneInputDeviceId: null,
  builtInMicrophoneLabelHint: null,
  bufferInputWhileConnecting: true,
};
const snapshot = (phase: CodexRealtimeVoiceSnapshot["phase"]): CodexRealtimeVoiceSnapshot => ({
  ...target,
  claimId: grant.claimId,
  realtimeSessionId: grant.realtimeSessionId,
  phase,
  microphoneMuted: false,
  outputMuted: false,
  revision: 1,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
let originalApi: typeof window.api;
beforeEach(() => {
  originalApi = window.api;
});
afterEach(() => {
  installWindowApi(originalApi);
});

function Controls({ forTarget = target }: { forTarget?: CodexRealtimeVoiceTarget }) {
  return <RealtimeVoiceControls voice={useComposerRealtimeVoice(forTarget)} />;
}
function Window({
  owner,
  client,
  show = true,
  forTarget = target,
}: {
  owner: RealtimeVoiceWindowOwner;
  client: ReturnType<typeof createTestQueryClient>;
  show?: boolean;
  forTarget?: CodexRealtimeVoiceTarget;
}) {
  return (
    <TestQueryProvider client={client}>
      <RealtimeVoiceWindowProvider owner={owner}>
        <NodexTooltipProvider>
          {show ? <Controls forTarget={forTarget} /> : null}
        </NodexTooltipProvider>
      </RealtimeVoiceWindowProvider>
    </TestQueryProvider>
  );
}
const fixture = () => {
  let session: CodexRealtimeVoiceSnapshot | null = null;
  const listeners = new Set<(event: CodexRealtimeVoiceEvent) => void>();
  const emit = (event: CodexRealtimeVoiceEvent) => {
    for (const listener of listeners) listener(event);
  };
  const reads = vi.fn(async () => ({ available: true, session }));
  const queryTargets: unknown[] = [];
  const api = window.api;
  installWindowApi({
    ...api,
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "codex:realtime-voice:read") {
        expect(args).toHaveLength(1);
        queryTargets.push(args[0]);
        return reads();
      }
      if (!api) throw new Error(`Unexpected query ${channel}`);
      return api.invoke(channel, ...args);
    },
  });
  const media: RealtimeVoiceMedia = {
    acceptAnswer: vi.fn(async () => {}),
    setMicrophoneMuted: vi.fn(),
    setOutputMuted: vi.fn(),
    releaseInput: vi.fn(),
    refreshInput: vi.fn(async () => {}),
    readInputStream: () => null,
    readOutputStream: () => null,
    stop: vi.fn(async () => {}),
  };
  const client: RealtimeVoiceClient = {
    read: reads,
    prepare: vi.fn(async () => {
      session = snapshot("starting");
      return grant;
    }),
    start: vi.fn(async () => {}),
    reportMedia: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    release: vi.fn(async () => {
      session = null;
      emit({ type: "availabilityChanged" });
      return true;
    }),
    appendText: vi.fn(async () => {}),
    appendSpeech: vi.fn(async () => {}),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const inputs: RealtimeVoiceMediaInput[] = [];
  const error = vi.fn();
  const makeOwner = () =>
    createRealtimeVoiceWindowOwner({
      client,
      onError: error,
      createMedia: async (input) => {
        inputs.push(input);
        return { offerSdp: "offer", media };
      },
    });
  return {
    client,
    media,
    inputs,
    error,
    reads,
    queryTargets,
    emit,
    makeOwner,
    setSession: (next: CodexRealtimeVoiceSnapshot | null) => {
      session = next;
    },
    activate: () => {
      session = snapshot("active");
      emit({ type: "snapshot", snapshot: session });
    },
  };
};

describe("window Voice claim and query lifecycle", () => {
  test("the default window owner shows the usage warning and sends it through the named speech command", async () => {
    const f = fixture();
    const inputs: RealtimeVoiceMediaInput[] = [];
    const events = new Set<(event: unknown) => void>();
    const calls: { channel: string; input: unknown }[] = [];
    mediaFactory.create.mockImplementation(async (input: RealtimeVoiceMediaInput) => {
      inputs.push(input);
      return { offerSdp: "offer", media: f.media };
    });
    installWindowApi({
      invoke: async (channel: string, input: unknown) => {
        calls.push({ channel, input });
        if (channel === "codex:realtime-voice:read") return { available: true, session: null };
        if (channel === "codex:realtime-voice:prepare") return grant;
        if (channel === "codex:realtime-voice:release") return true;
        if (
          [
            "codex:realtime-voice:start",
            "codex:realtime-voice:stop",
            "codex:realtime-voice:append-speech",
          ].includes(channel)
        )
          return;
        throw new Error(`Unexpected Voice command ${channel}`);
      },
      on: (channel: string, listener: (event: unknown) => void) => {
        expect(channel).toBe("codex:realtime-voice:event");
        events.add(listener);
        return () => events.delete(listener);
      },
    });
    const client = createTestQueryClient();
    const view = render(
      <TestQueryProvider client={client}>
        <RealtimeVoiceWindowProvider>
          <NodexTooltipProvider>
            <NodexToastProvider>
              <Controls />
            </NodexToastProvider>
          </NodexTooltipProvider>
        </RealtimeVoiceWindowProvider>
      </TestQueryProvider>,
    );
    try {
      await view.findByRole("button", { name: "Start voice" });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Start voice" }));
      });
      await waitFor(() =>
        expect(
          calls.filter(({ channel }) => channel === "codex:realtime-voice:start"),
        ).toHaveLength(1),
      );
      await act(async () => {
        for (const notify of events) notify({ type: "snapshot", snapshot: snapshot("active") });
        const event = JSON.stringify({
          type: "session.usage.updated",
          usage_limit: { status: "approaching" },
        });
        inputs[0]!.onEvent?.(event);
        inputs[0]!.onEvent?.(event);
      });
      const warning = "You’re approaching your Codex usage limit, so this voice chat may end soon";
      await view.findByText(warning);
      expect(
        calls.filter(({ channel }) => channel === "codex:realtime-voice:append-speech"),
      ).toEqual([
        {
          channel: "codex:realtime-voice:append-speech",
          input: {
            claimId: grant.claimId,
            text: `Urgent system notice: Interrupt the user or yourself if either is speaking. Say only this warning immediately, exactly as written, before continuing anything else: “${warning}”`,
          },
        },
      ]);
      expect(f.media.stop).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "End voice" }));
      });
      await view.findByRole("button", { name: "Start voice" });
      expect(f.media.stop).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      client.clear();
      __resetNodexToastStoreForTests();
      mediaFactory.create.mockReset();
    }
  });
  test("released claims refresh two visible windows without focus or policy changes", async () => {
    const f = fixture();
    f.setSession(snapshot("active"));
    const first = createTestQueryClient();
    const second = createTestQueryClient();
    const otherTarget = { hostId: "ssh:other", threadId: "other-thread" };
    for (const [client, queryTarget] of [
      [first, target],
      [second, otherTarget],
    ] as const)
      client.setQueryData(realtimeVoiceAvailabilityQueryOptions(queryTarget).queryKey, {
        available: true,
        session: snapshot("active"),
      });
    const view = render(
      <>
        <div data-testid="first">
          <Window owner={f.makeOwner()} client={first} />
        </div>
        <div data-testid="second">
          <Window owner={f.makeOwner()} client={second} forTarget={otherTarget} />
        </div>
      </>,
    );
    const a = within(view.getByTestId("first"));
    const b = within(view.getByTestId("second"));
    expect((await a.findByRole("button", { name: "Start voice" })).hasAttribute("disabled")).toBe(
      true,
    );
    expect((await b.findByRole("button", { name: "Start voice" })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(f.reads).not.toHaveBeenCalled();
    await act(async () => {
      f.setSession(null);
      f.emit({ type: "availabilityChanged" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(a.getByRole("button", { name: "Start voice" }).hasAttribute("disabled")).toBe(false);
      expect(b.getByRole("button", { name: "Start voice" }).hasAttribute("disabled")).toBe(false);
    });
    expect(f.reads).toHaveBeenCalledTimes(2);
    expect(f.queryTargets).toEqual([target, otherTarget]);
    view.unmount();
    first.clear();
    second.clear();
  });
  test("a release while the Composer is detached invalidates its cached busy claim", async () => {
    const f = fixture();
    f.setSession(snapshot("active"));
    const client = createTestQueryClient();
    const owner = f.makeOwner();
    client.setQueryData(realtimeVoiceAvailabilityQueryOptions(target).queryKey, {
      available: true,
      session: snapshot("active"),
    });
    const view = render(<Window owner={owner} client={client} show={false} />);
    await act(async () => {
      f.setSession(null);
      f.emit({ type: "availabilityChanged" });
      await Promise.resolve();
    });
    view.rerender(<Window owner={owner} client={client} />);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Start voice" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(f.reads).toHaveBeenCalledTimes(1);
    view.unmount();
    client.clear();
  });
  test("the actual End control can retry a rejection using the same call and media", async () => {
    const f = fixture();
    const client = createTestQueryClient();
    const owner = f.makeOwner();
    const view = render(<Window owner={owner} client={client} />);
    await view.findByRole("button", { name: "Start voice" });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Start voice" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(f.client.start).toHaveBeenCalledTimes(1));
    await act(async () => {
      f.activate();
      await Promise.resolve();
    });
    vi.mocked(f.client.stop).mockRejectedValueOnce(new Error("stop rejected"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "End voice" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(f.error).toHaveBeenCalledTimes(1));
    await view.findByRole("button", { name: "End voice" });
    expect(f.inputs[0]!.signal.aborted).toBe(false);
    expect(f.media.stop).not.toHaveBeenCalled();
    expect(f.client.release).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "End voice" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Start voice" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(f.client.prepare).toHaveBeenCalledTimes(1);
    expect(f.client.stop).toHaveBeenCalledTimes(2);
    expect(f.media.stop).toHaveBeenCalledTimes(1);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    view.unmount();
    client.clear();
  });
  test("the actual startup Cancel control releases resources even when native stop rejects", async () => {
    const f = fixture();
    const client = createTestQueryClient();
    const owner = f.makeOwner();
    const started = deferred<void>();
    vi.mocked(f.client.start).mockReturnValueOnce(started.promise);
    vi.mocked(f.client.stop).mockRejectedValueOnce(new Error("stop rejected"));
    const view = render(<Window owner={owner} client={client} />);
    await view.findByRole("button", { name: "Start voice" });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Start voice" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(f.client.start).toHaveBeenCalledTimes(1));
    try {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Cancel voice" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Start voice" }).hasAttribute("disabled")).toBe(
          false,
        ),
      );
      expect(f.inputs[0]!.signal.aborted).toBe(true);
      expect(f.media.stop).toHaveBeenCalledTimes(1);
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    } finally {
      await act(async () => {
        started.resolve();
        await Promise.resolve();
      });
      view.unmount();
      client.clear();
    }
  });
});
