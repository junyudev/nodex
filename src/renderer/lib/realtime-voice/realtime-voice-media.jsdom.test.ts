import { afterEach, expect, it, vi } from "vitest";
import {
  createRealtimeVoiceMedia,
  type RealtimeVoiceMediaInput,
  type RealtimeVoiceMediaPlatform,
} from "./realtime-voice-media";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
const stream = () => {
  const track = { enabled: true, stop: vi.fn() };
  const value = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { value, track };
};
const fixture = (overrides: Partial<RealtimeVoiceMediaInput> = {}) => {
  const abort = new AbortController();
  let current = true;
  const initial = stream();
  const outgoing = stream();
  const sourceNodes: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage: vi.fn<(message: unknown) => void>(),
      close: vi.fn(),
    },
  };
  const destination = { channelCount: 2, stream: outgoing.value, disconnect: vi.fn() };
  const context = {
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn((_stream: MediaStream) => {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      sourceNodes.push(node);
      return node;
    }),
    createMediaStreamDestination: vi.fn(() => destination),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const channel = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: vi.fn(),
  };
  const peer = {
    connectionState: "new" as RTCPeerConnectionState,
    onconnectionstatechange: null as (() => void) | null,
    ontrack: null as ((event: RTCTrackEvent) => void) | null,
    addTrack: vi.fn(),
    createDataChannel: vi.fn((_name: string) => channel),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "local-offer" })),
    setLocalDescription: vi.fn(async (_offer: RTCSessionDescriptionInit) => {}),
    setRemoteDescription: vi.fn(async (_answer: RTCSessionDescriptionInit) => {}),
    close: vi.fn(),
  };
  const audio = {
    autoplay: false,
    hidden: false,
    muted: false,
    srcObject: null as MediaProvider | null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  };
  const devices = new EventTarget();
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => initial.value);
  const enumerateDevices = vi.fn(async (): Promise<MediaDeviceInfo[]> => []);
  const platform: RealtimeVoiceMediaPlatform = {
    mediaDevices: {
      getUserMedia,
      enumerateDevices,
      addEventListener: devices.addEventListener.bind(devices),
      removeEventListener: devices.removeEventListener.bind(devices),
    },
    createContext: vi.fn(() => context as unknown as AudioContext),
    createWorklet: vi.fn((_context, _options) => processor as unknown as AudioWorkletNode),
    createPeer: vi.fn(() => peer as unknown as RTCPeerConnection),
    createAudio: vi.fn(() => audio as unknown as HTMLAudioElement),
  };
  const input: RealtimeVoiceMediaInput = {
    grant: {
      hostId: "local",
      threadId: "thread",
      claimId: "claim",
      realtimeSessionId: "native-session",
      microphoneInputDeviceId: null,
      builtInMicrophoneLabelHint: null,
      bufferInputWhileConnecting: true,
    },
    signal: abort.signal,
    assertCanCapture: () => current,
    requestMicrophoneAccess: vi.fn(async () => ({
      kind: "granted" as const,
      status: "granted" as const,
    })),
    onConnected: vi.fn(),
    onInitialized: vi.fn(),
    onFailure: vi.fn(),
    onEvent: vi.fn(),
    onMediaChanged: vi.fn(),
    ...overrides,
  };
  return {
    abort,
    initial,
    outgoing,
    processor,
    context,
    sourceNodes,
    destination,
    peer,
    channel,
    audio,
    devices,
    getUserMedia,
    platform,
    input,
    retire: () => {
      current = false;
    },
    start: () => createRealtimeVoiceMedia(input, platform),
    receive: (data: unknown) => channel.onmessage?.(new MessageEvent("message", { data })),
    connect: () => {
      peer.connectionState = "connected";
      peer.onconnectionstatechange?.();
    },
    acknowledgeMute: (requestId: number, muted: boolean) =>
      processor.port.onmessage?.(
        new MessageEvent("message", { data: { type: "mute-applied", requestId, muted } }),
      ),
  };
};
const active: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((media) => media.stop()));
  vi.restoreAllMocks();
});
const start = async (f: ReturnType<typeof fixture>) => {
  const result = await f.start();
  active.push(result.media);
  return result;
};

it("uses mono buffered capture and an offer only after local SDP installation", async () => {
  const f = fixture();
  const { media, offerSdp } = await start(f);
  expect(offerSdp).toBe("local-offer");
  expect(f.getUserMedia).toHaveBeenCalledWith({
    audio: { channelCount: 1, noiseSuppression: true },
  });
  expect(f.platform.createWorklet).toHaveBeenCalledWith(f.context, {
    channelCount: 1,
    channelCountMode: "explicit",
    outputChannelCount: [1],
    processorOptions: { bufferInputWhileConnecting: true },
  });
  expect(f.destination.channelCount).toBe(1);
  expect(f.sourceNodes[0]!.connect).toHaveBeenCalledWith(f.processor);
  expect(f.processor.connect).toHaveBeenCalledWith(f.destination);
  expect(f.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
  expect(f.peer.addTrack).toHaveBeenCalledWith(f.outgoing.track, f.outgoing.value);
  expect(f.peer.setLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "local-offer" });
  await media.acceptAnswer("remote-answer");
  expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({
    type: "answer",
    sdp: "remote-answer",
  });
  f.connect();
  f.connect();
  media.releaseInput();
  expect(
    f.processor.port.postMessage.mock.calls.filter(
      ([message]) => (message as { type: string }).type === "release",
    ),
  ).toHaveLength(1);
  expect(f.input.onConnected).toHaveBeenCalledTimes(1);
});

it.each(["session.started", "session.updated"])(
  "accepts %s string session evidence exactly once",
  async (type) => {
    const f = fixture();
    await start(f);
    f.receive(new Uint8Array([1]));
    f.receive("broken");
    f.receive(JSON.stringify({ type, session: { id: 42 } }));
    f.receive(JSON.stringify({ type: "other", session: { id: "wrong" } }));
    expect(f.input.onInitialized).not.toHaveBeenCalled();
    f.receive(JSON.stringify({ type, session: { id: "v3-arbitrary-session-id" } }));
    f.receive(JSON.stringify({ type: "session.updated", session: { id: "another" } }));
    expect(f.input.onInitialized).toHaveBeenCalledExactlyOnceWith("v3-arbitrary-session-id");
    expect(f.input.onEvent).toHaveBeenCalledTimes(5);
  },
);

it("never lets an obsolete mute acknowledgement reopen the sending track", async () => {
  const f = fixture();
  const { media } = await start(f);
  media.setMicrophoneMuted(true);
  expect(f.initial.track.enabled).toBe(false);
  expect(f.outgoing.track.enabled).toBe(false);
  media.setMicrophoneMuted(false);
  expect(f.initial.track.enabled).toBe(true);
  expect(f.outgoing.track.enabled).toBe(false);
  f.acknowledgeMute(1, false);
  f.acknowledgeMute(2, true);
  expect(f.outgoing.track.enabled).toBe(false);
  f.acknowledgeMute(3, false);
  expect(f.outgoing.track.enabled).toBe(true);
  media.setMicrophoneMuted(true);
  f.acknowledgeMute(3, false);
  expect(f.outgoing.track.enabled).toBe(false);
});

it("plays the actual remote stream and preserves output mute across its arrival", async () => {
  const f = fixture();
  const { media } = await start(f);
  const remote = stream();
  media.setOutputMuted(true);
  f.peer.ontrack?.({ track: remote.track, streams: [remote.value] } as unknown as RTCTrackEvent);
  expect(media.readOutputStream()).toBe(remote.value);
  expect(f.audio.srcObject).toBe(remote.value);
  expect(f.audio.autoplay).toBe(true);
  expect(f.audio.muted).toBe(true);
  media.setOutputMuted(false);
  expect(f.audio.muted).toBe(false);
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  await media.stop();
  expect(f.audio.srcObject).toBeNull();
  expect(remote.track.stop).toHaveBeenCalledTimes(1);
});

it("blocks capture at permission and lifetime boundaries without opening media resources", async () => {
  const denied = fixture({
    requestMicrophoneAccess: vi.fn(
      async () => ({ kind: "blocked", status: "denied", restartRequired: false }) as const,
    ),
  });
  await expect(denied.start()).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(denied.getUserMedia).not.toHaveBeenCalled();
  expect(denied.platform.createContext).not.toHaveBeenCalled();
  const permission = deferred<{ kind: "granted"; status: "granted" }>();
  const retired = fixture({ requestMicrophoneAccess: () => permission.promise });
  const starting = retired.start();
  retired.retire();
  permission.resolve({ kind: "granted", status: "granted" });
  await expect(starting).rejects.toMatchObject({ name: "AbortError" });
  expect(retired.getUserMedia).not.toHaveBeenCalled();
  expect(retired.platform.createContext).not.toHaveBeenCalled();
});

it("waits for a retired acquisition, stops its late track and closes setup resources", async () => {
  const f = fixture();
  const capture = deferred<MediaStream>();
  f.getUserMedia.mockImplementationOnce(() => capture.promise);
  const starting = f.start();
  const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
  await flush();
  f.abort.abort();
  const late = stream();
  capture.resolve(late.value);
  await rejected;
  expect(late.track.stop).toHaveBeenCalledTimes(1);
  expect(f.context.close).toHaveBeenCalled();
  expect(f.platform.createPeer).not.toHaveBeenCalled();
});

it("replaces capture serially, preserves the old input on failure and stops an unusable new source", async () => {
  const f = fixture();
  const { media } = await start(f);
  const first = deferred<MediaStream>();
  const replacement = stream();
  const last = stream();
  f.getUserMedia.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(last.value);
  const firstRefresh = media.refreshInput("one");
  const secondRefresh = media.refreshInput("two");
  await flush();
  expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  expect(media.readInputStream()).toBe(f.initial.value);
  first.resolve(replacement.value);
  await Promise.all([firstRefresh, secondRefresh]);
  expect(media.readInputStream()).toBe(last.value);
  expect(f.initial.track.stop).toHaveBeenCalledTimes(1);
  expect(replacement.track.stop).toHaveBeenCalledTimes(1);
  f.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  await expect(media.refreshInput("denied")).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(media.readInputStream()).toBe(last.value);
  expect(last.track.stop).not.toHaveBeenCalled();
  const unusable = stream();
  f.getUserMedia.mockResolvedValueOnce(unusable.value);
  f.context.createMediaStreamSource.mockImplementationOnce(() => {
    throw new Error("invalid graph");
  });
  await expect(media.refreshInput("unusable")).rejects.toThrow("invalid graph");
  expect(unusable.track.stop).toHaveBeenCalledTimes(1);
  expect(media.readInputStream()).toBe(last.value);
});

it("fences all saved callbacks immediately and waits for a refresh and context close during stop", async () => {
  const f = fixture();
  const { media } = await start(f);
  const savedMessage = f.channel.onmessage!;
  const savedTrack = f.peer.ontrack!;
  const savedConnection = f.peer.onconnectionstatechange!;
  const savedError = f.channel.onerror!;
  const capture = deferred<MediaStream>();
  const closed = deferred<void>();
  f.getUserMedia.mockImplementationOnce(() => capture.promise);
  f.context.close.mockImplementation(() => closed.promise);
  const refreshing = media.refreshInput("pending");
  const refreshRejected = expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
  await flush();
  const stopping = media.stop();
  let completed = false;
  void stopping.then(() => {
    completed = true;
  });
  expect(media.stop()).toBe(stopping);
  f.peer.connectionState = "connected";
  savedConnection();
  savedError();
  savedMessage(
    new MessageEvent("message", {
      data: JSON.stringify({ type: "session.started", session: { id: "late" } }),
    }),
  );
  const lateRemote = stream();
  savedTrack({ track: lateRemote.track, streams: [lateRemote.value] } as unknown as RTCTrackEvent);
  expect(f.input.onConnected).not.toHaveBeenCalled();
  expect(f.input.onInitialized).not.toHaveBeenCalled();
  expect(f.input.onFailure).not.toHaveBeenCalled();
  expect(lateRemote.track.stop).toHaveBeenCalledTimes(1);
  await flush();
  expect(completed).toBe(false);
  const lateInput = stream();
  capture.resolve(lateInput.value);
  await refreshRejected;
  await flush();
  expect(completed).toBe(false);
  closed.resolve();
  await stopping;
  expect(lateInput.track.stop).toHaveBeenCalledTimes(1);
  expect(f.initial.track.stop).toHaveBeenCalledTimes(1);
  expect(f.outgoing.track.stop).toHaveBeenCalledTimes(1);
  expect(f.processor.port.close).toHaveBeenCalledTimes(1);
  expect(f.sourceNodes[0]!.disconnect).toHaveBeenCalledTimes(1);
  expect(f.destination.disconnect).toHaveBeenCalledTimes(1);
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(media.readInputStream()).toBeNull();
  expect(media.readOutputStream()).toBeNull();
});

it("reports transport failure once and still releases every resource if one close throws", async () => {
  const f = fixture();
  const { media } = await start(f);
  f.peer.connectionState = "disconnected";
  f.peer.onconnectionstatechange?.();
  expect(f.input.onFailure).not.toHaveBeenCalled();
  f.peer.connectionState = "failed";
  f.peer.onconnectionstatechange?.();
  f.channel.onerror?.();
  f.channel.onclose?.();
  expect(f.input.onFailure).toHaveBeenCalledTimes(1);
  f.channel.close.mockImplementation(() => {
    throw new Error("closed");
  });
  await media.stop();
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(f.initial.track.stop).toHaveBeenCalledTimes(1);
  expect(f.processor.port.close).toHaveBeenCalledTimes(1);
  expect(f.context.close).toHaveBeenCalledTimes(1);
});
