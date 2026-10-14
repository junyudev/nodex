import { describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexRealtimeVoiceEvent,
  CodexRealtimeVoiceGrant,
} from "../../../shared/codex-realtime-voice";
import type {
  RealtimeVoiceMedia,
  RealtimeVoiceMediaInput,
} from "../../lib/realtime-voice/realtime-voice-media";
import { parseRealtimeVoiceEvent, type RealtimeVoiceClient } from "./realtime-voice-client";
import { createRealtimeVoiceWindowOwner } from "./realtime-voice-window-owner";

const target = { hostId: "local", threadId: "thread" };
const grant: CodexRealtimeVoiceGrant = {
  ...target,
  claimId: "019a1240-1000-7000-8000-000000000001",
  realtimeSessionId: "019a1240-1000-7000-8000-000000000002",
  microphoneInputDeviceId: null,
  builtInMicrophoneLabelHint: null,
  bufferInputWhileConnecting: true,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
const fixture = () => {
  let listener: ((event: CodexRealtimeVoiceEvent) => void) | null = null;
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
    read: vi.fn(async () => ({ available: false, session: null })),
    prepare: vi.fn(async () => grant),
    start: vi.fn(async () => {}),
    reportMedia: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    release: vi.fn(async () => true),
    appendText: vi.fn(async () => {}),
    subscribe: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  const inputs: RealtimeVoiceMediaInput[] = [];
  const createMedia = vi.fn(async (input: RealtimeVoiceMediaInput) => {
    inputs.push(input);
    return { offerSdp: "native-offer", media };
  });
  const error = vi.fn();
  const owner = createRealtimeVoiceWindowOwner({ client, createMedia, onError: error });
  const release = owner.acquireWindow();
  const emit = (event: CodexRealtimeVoiceEvent) => listener?.(event);
  const activate = (revision = 1) =>
    emit({
      type: "snapshot",
      snapshot: {
        ...target,
        claimId: grant.claimId,
        realtimeSessionId: grant.realtimeSessionId,
        phase: "active",
        microphoneMuted: false,
        outputMuted: false,
        revision,
      },
    });
  return { owner, client, media, createMedia, inputs, error, release, emit, activate };
};

describe("window-owned realtime Voice", () => {
  test("shares one startup and waits for actual Main startup evidence before showing active", async () => {
    const f = fixture();
    const preparing = deferred<CodexRealtimeVoiceGrant>();
    vi.mocked(f.client.prepare).mockReturnValue(preparing.promise);
    const first = f.owner.start(target);
    expect(f.owner.start({ ...target })).toBe(first);
    expect(f.owner.read().phase).toBe("preparing");
    preparing.resolve(grant);
    await first;
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith(grant.claimId, "native-offer");
    expect(f.createMedia).toHaveBeenCalledTimes(1);
    f.inputs[0]!.onConnected();
    f.inputs[0]!.onInitialized("not-the-native-UUID");
    await flush();
    expect(f.client.reportMedia).toHaveBeenCalledWith(grant.claimId, "connected");
    expect(f.client.reportMedia).toHaveBeenCalledWith(grant.claimId, "initialized");
    expect(f.owner.read().phase).toBe("starting");
    f.activate();
    expect(f.owner.read().phase).toBe("active");
    await expect(f.owner.start({ hostId: "remote", threadId: "thread" })).rejects.toThrow(
      "already active",
    );
    await f.owner.stop();
    f.release();
  });
  test("retirement waits for late media construction and actual media release before releasing Main's claim", async () => {
    const f = fixture();
    const constructing = deferred<{ offerSdp: string; media: RealtimeVoiceMedia }>();
    const stopped = deferred<void>();
    vi.mocked(f.media.stop).mockReturnValue(stopped.promise);
    f.createMedia.mockImplementation(async (input) => {
      f.inputs.push(input);
      return constructing.promise;
    });
    const starting = f.owner.start(target);
    await flush();
    expect(f.inputs.length).toBe(1);
    f.release();
    expect(f.inputs[0]!.signal.aborted).toBe(true);
    constructing.resolve({ offerSdp: "late", media: f.media });
    await flush();
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.media.stop).toHaveBeenCalledTimes(1);
    expect(f.client.release).not.toHaveBeenCalled();
    stopped.resolve();
    await starting;
    await flush();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    expect(f.owner.read().phase).toBe("inactive");
    expect(f.inputs[0]!.assertCanCapture()).toBe(false);
  });
  test("late prepare, old callbacks and foreign native events cannot revive an old attempt", async () => {
    const f = fixture();
    const prepared = deferred<CodexRealtimeVoiceGrant>();
    vi.mocked(f.client.prepare).mockReturnValueOnce(prepared.promise);
    const starting = f.owner.start(target);
    await flush();
    f.release();
    prepared.resolve(grant);
    await starting;
    await flush();
    expect(f.createMedia).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    const releaseNext = f.owner.acquireWindow();
    const replacement = { ...grant, claimId: "019a1240-1000-7000-8000-000000000003" };
    vi.mocked(f.client.prepare).mockResolvedValueOnce(replacement);
    await f.owner.start(target);
    f.emit({ type: "terminate", claimId: grant.claimId });
    f.emit({
      type: "native",
      claimId: replacement.claimId,
      notification: {
        method: "thread/realtime/sdp",
        params: { threadId: "foreign", sdp: "foreign" },
      },
    });
    expect(f.media.acceptAnswer).not.toHaveBeenCalled();
    expect(f.owner.read().phase).toBe("starting");
    await f.owner.stop();
    releaseNext();
  });
  test("applies SDP and live device changes only to the current resource and ignores transport_closed", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.emit({
      type: "native",
      claimId: grant.claimId,
      notification: {
        method: "thread/realtime/sdp",
        params: { threadId: target.threadId, sdp: "answer" },
      },
    });
    f.emit({ type: "microphoneChanged", claimId: grant.claimId, deviceId: "new-input" });
    f.emit({
      type: "native",
      claimId: grant.claimId,
      notification: {
        method: "thread/realtime/closed",
        params: { threadId: target.threadId, reason: "transport_closed" },
      },
    });
    await flush();
    expect(f.media.acceptAnswer).toHaveBeenCalledExactlyOnceWith("answer");
    expect(f.media.refreshInput).toHaveBeenCalledExactlyOnceWith("new-input");
    expect(f.media.stop).not.toHaveBeenCalled();
    f.emit({ type: "terminate", claimId: grant.claimId });
    await flush();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    f.release();
  });
  test("keeps immediate local mute intent while serializing full-mask Main confirmations", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.activate();
    const confirmed = deferred<void>();
    vi.mocked(f.client.setMuted).mockReturnValueOnce(confirmed.promise);
    const input = f.owner.setMicrophoneMuted(true);
    await flush();
    const output = f.owner.setOutputMuted(true);
    expect(f.owner.read()).toMatchObject({ microphoneMuted: true, outputMuted: true });
    f.activate(2);
    expect(f.owner.read()).toMatchObject({ microphoneMuted: true, outputMuted: true });
    confirmed.resolve();
    await input;
    await output;
    expect(f.client.setMuted).toHaveBeenLastCalledWith({
      claimId: grant.claimId,
      microphoneMuted: true,
      outputMuted: true,
    });
    expect(f.media.setMicrophoneMuted).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.media.setOutputMuted).toHaveBeenCalledExactlyOnceWith(true);
    await f.owner.stop();
    f.release();
  });
  test.each(["starting", "active"] as const)(
    "keeps the same %s call available for retry after an ordinary stop rejection",
    async (phase) => {
      const f = fixture();
      await f.owner.start(target);
      if (phase === "active") f.activate();
      vi.mocked(f.client.read).mockResolvedValue({
        available: true,
        session: { ...grant, phase, microphoneMuted: false, outputMuted: false, revision: 2 },
      });
      vi.mocked(f.client.stop).mockRejectedValueOnce(new Error("native refused"));
      await expect(f.owner.stop()).rejects.toThrow("native refused");
      expect(f.owner.read().phase).toBe(phase);
      expect(f.inputs[0]!.signal.aborted).toBe(false);
      expect(f.media.stop).not.toHaveBeenCalled();
      expect(f.client.release).not.toHaveBeenCalled();
      await f.owner.setMicrophoneMuted(true);
      expect(f.media.setMicrophoneMuted).toHaveBeenCalledExactlyOnceWith(true);
      await f.owner.stop();
      expect(f.client.stop).toHaveBeenCalledTimes(2);
      expect(f.media.stop).toHaveBeenCalledTimes(1);
      expect(f.client.release).toHaveBeenCalledTimes(1);
      expect(f.owner.read().phase).toBe("inactive");
      f.release();
    },
  );
  test("only tears down media after the ordinary stop was accepted", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.activate();
    const accepted = deferred<void>();
    vi.mocked(f.client.stop).mockReturnValueOnce(accepted.promise);
    const stopping = f.owner.stop();
    try {
      await flush();
      expect(f.owner.read().phase).toBe("stopping");
      expect(f.inputs[0]!.signal.aborted).toBe(false);
      expect(f.media.stop).not.toHaveBeenCalled();
      expect(f.client.release).not.toHaveBeenCalled();
      accepted.resolve();
      await stopping;
      expect(f.media.stop).toHaveBeenCalledTimes(1);
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
      expect(f.client.stop).toHaveBeenCalledTimes(1);
    } finally {
      accepted.resolve();
      await stopping.catch(() => undefined);
      f.release();
    }
  });
  test("window disposal still tears down media when an in-flight ordinary stop is rejected", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.activate();
    const accepted = deferred<void>();
    vi.mocked(f.client.stop).mockReturnValueOnce(accepted.promise);
    const stopping = f.owner.stop();
    const settled = stopping.catch(() => undefined);
    await flush();
    f.release();
    await flush();
    expect(f.inputs[0]!.signal.aborted).toBe(true);
    expect(f.media.stop).toHaveBeenCalledTimes(1);
    accepted.reject(new Error("native refused"));
    await settled;
    await flush();
    expect(f.client.stop).toHaveBeenCalledTimes(1);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    expect(f.owner.read().phase).toBe("inactive");
    expect(f.error).not.toHaveBeenCalled();
  });
  test("a legal native close without a reason retires the actual attempt through the production decoder", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.activate();
    const event = parseRealtimeVoiceEvent({
      type: "native",
      claimId: grant.claimId,
      notification: {
        method: "thread/realtime/closed",
        params: { threadId: target.threadId, reason: null },
      },
    });
    if (event) f.emit(event);
    await flush();
    expect(f.owner.read().phase).toBe("inactive");
    expect(f.media.stop).toHaveBeenCalledTimes(1);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    f.release();
  });
  test("stop rejection retires a missing claim but a failed state read preserves the current call", async () => {
    const missing = fixture();
    await missing.owner.start(target);
    missing.activate();
    vi.mocked(missing.client.stop).mockRejectedValueOnce(new Error("native refused"));
    await missing.owner.stop();
    expect(missing.owner.read().phase).toBe("inactive");
    expect(missing.media.stop).toHaveBeenCalledTimes(1);
    expect(missing.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    missing.release();
    const current = fixture();
    await current.owner.start(target);
    current.activate();
    vi.mocked(current.client.stop).mockRejectedValueOnce(new Error("native refused"));
    vi.mocked(current.client.read).mockRejectedValueOnce(new Error("state read interrupted"));
    await expect(current.owner.stop()).rejects.toThrow("native refused");
    expect(current.owner.read().phase).toBe("active");
    expect(current.media.stop).not.toHaveBeenCalled();
    expect(current.client.release).not.toHaveBeenCalled();
    await current.owner.stop();
    current.release();
  });
  test("a native close during requested End cleans up once without reporting an unexpected-close error", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.activate();
    const accepted = deferred<void>();
    vi.mocked(f.client.stop).mockReturnValueOnce(accepted.promise);
    const stopping = f.owner.stop();
    try {
      await flush();
      const event = parseRealtimeVoiceEvent({
        type: "native",
        claimId: grant.claimId,
        notification: {
          method: "thread/realtime/closed",
          params: { threadId: target.threadId, reason: null },
        },
      });
      if (event) f.emit(event);
      await flush();
      expect(f.media.stop).toHaveBeenCalledTimes(1);
      expect(f.client.release).not.toHaveBeenCalled();
      accepted.resolve();
      await stopping;
      await flush();
      expect(f.client.stop).toHaveBeenCalledTimes(1);
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
      expect(f.error).not.toHaveBeenCalled();
    } finally {
      accepted.resolve();
      await stopping.catch(() => undefined);
      f.release();
    }
  });
  test("cannot capture media for a matching Main claim retired before preparation returns", async () => {
    const f = fixture();
    const prepared = deferred<CodexRealtimeVoiceGrant>();
    vi.mocked(f.client.prepare).mockReturnValue(prepared.promise);
    const starting = f.owner.start(target);
    await flush();
    f.emit({ type: "terminate", claimId: grant.claimId });
    prepared.resolve(grant);
    await starting;
    await flush();
    expect(f.createMedia).not.toHaveBeenCalled();
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    expect(f.owner.read().phase).toBe("inactive");
    expect(f.error).not.toHaveBeenCalled();
    f.release();
  });
  test("an old claim's early retirement cannot cancel a new prepared claim", async () => {
    const f = fixture();
    const prepared = deferred<CodexRealtimeVoiceGrant>();
    vi.mocked(f.client.prepare).mockReturnValue(prepared.promise);
    const starting = f.owner.start(target);
    await flush();
    f.emit({ type: "terminate", claimId: "019a1240-1000-7000-8000-000000000003" });
    prepared.resolve(grant);
    await starting;
    expect(f.createMedia).toHaveBeenCalledTimes(1);
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith(grant.claimId, "native-offer");
    await f.owner.stop();
    f.release();
  });
  test("applies the latest preparation-time device preference before issuing native startup", async () => {
    const f = fixture();
    const prepared = deferred<CodexRealtimeVoiceGrant>();
    vi.mocked(f.client.prepare).mockReturnValue(prepared.promise);
    const starting = f.owner.start(target);
    await flush();
    f.emit({ type: "microphoneChanged", claimId: grant.claimId, deviceId: "first-input" });
    f.emit({ type: "microphoneChanged", claimId: grant.claimId, deviceId: "latest-input" });
    prepared.resolve(grant);
    await starting;
    expect(f.media.refreshInput).toHaveBeenCalledExactlyOnceWith("latest-input");
    expect(vi.mocked(f.media.refreshInput).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.client.start).mock.invocationCallOrder[0]!,
    );
    await f.owner.stop();
    f.release();
  });
  test("a failed active microphone refresh preserves the current call and input resources", async () => {
    const f = fixture();
    await f.owner.start(target);
    f.activate();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.mocked(f.media.refreshInput).mockRejectedValueOnce(new Error("device unavailable"));
      f.emit({ type: "microphoneChanged", claimId: grant.claimId, deviceId: "unavailable-input" });
      await flush();
      expect(f.owner.read().phase).toBe("active");
      expect(f.media.stop).not.toHaveBeenCalled();
      expect(f.client.stop).not.toHaveBeenCalled();
      expect(f.client.release).not.toHaveBeenCalled();
      expect(f.error).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
      await f.owner.setMicrophoneMuted(true);
      expect(f.media.setMicrophoneMuted).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      await f.owner.stop();
      f.release();
      warning.mockRestore();
    }
  });
  test("a failed startup-time device refresh keeps the existing media and still issues native startup", async () => {
    const f = fixture();
    const constructing = deferred<{ offerSdp: string; media: RealtimeVoiceMedia }>();
    f.createMedia.mockImplementation(async (input) => {
      f.inputs.push(input);
      return constructing.promise;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const starting = f.owner.start(target);
      await flush();
      f.emit({ type: "microphoneChanged", claimId: grant.claimId, deviceId: "first-input" });
      f.emit({ type: "microphoneChanged", claimId: grant.claimId, deviceId: "unavailable-input" });
      vi.mocked(f.media.refreshInput).mockRejectedValueOnce(new Error("device unavailable"));
      constructing.resolve({ offerSdp: "startup-offer", media: f.media });
      await starting;
      expect(f.media.refreshInput).toHaveBeenCalledExactlyOnceWith("unavailable-input");
      expect(f.client.start).toHaveBeenCalledExactlyOnceWith(grant.claimId, "startup-offer");
      expect(f.media.stop).not.toHaveBeenCalled();
      expect(f.error).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
      f.activate();
      expect(f.owner.read().phase).toBe("active");
    } finally {
      await f.owner.stop();
      f.release();
      warning.mockRestore();
    }
  });
});
