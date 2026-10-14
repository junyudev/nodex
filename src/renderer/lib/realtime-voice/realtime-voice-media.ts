/* oxlint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin -- This attempt owns its platform handlers and AudioWorklet MessagePort. */
import type { CodexRealtimeVoiceGrant } from "../../../shared/codex-realtime-voice";
import type { MicrophoneAccessResult } from "../../../shared/dictation";
import { acquireMicrophone } from "../../features/dictation/microphone-acquirer";
import workletUrl from "./realtime-voice-audio-worklet.ts?worker&url";

export interface RealtimeVoiceMedia {
  acceptAnswer(sdp: string): Promise<void>;
  setMicrophoneMuted(muted: boolean): void;
  setOutputMuted(muted: boolean): void;
  releaseInput(): void;
  refreshInput(deviceId: string | null): Promise<void>;
  readInputStream(): MediaStream | null;
  readOutputStream(): MediaStream | null;
  stop(): Promise<void>;
}

export interface RealtimeVoiceMediaInput {
  readonly grant: CodexRealtimeVoiceGrant;
  readonly signal: AbortSignal;
  readonly assertCanCapture: () => boolean;
  readonly requestMicrophoneAccess: () => Promise<MicrophoneAccessResult>;
  readonly onConnected: () => void;
  readonly onInitialized: (sessionId: string) => void;
  readonly onFailure: (error: unknown) => void;
  readonly onEvent?: (message: string) => void;
  readonly onMediaChanged?: () => void;
  readonly initiallyInputMuted?: boolean;
  readonly initiallyOutputMuted?: boolean;
}

/** Production and isolated loopback tests exercise the same resource lifecycle. */
export interface RealtimeVoiceMediaPlatform {
  readonly mediaDevices: Pick<
    MediaDevices,
    "getUserMedia" | "enumerateDevices" | "addEventListener" | "removeEventListener"
  >;
  createContext(): AudioContext;
  createWorklet(context: AudioContext, options: AudioWorkletNodeOptions): AudioWorkletNode;
  createPeer(): RTCPeerConnection;
  createAudio(): HTMLAudioElement;
}

const browserPlatform = (): RealtimeVoiceMediaPlatform => {
  if (
    typeof RTCPeerConnection === "undefined" ||
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined" ||
    navigator.mediaDevices?.getUserMedia === undefined
  )
    throw new DOMException("Voice media is unavailable", "NotSupportedError");
  return {
    mediaDevices: navigator.mediaDevices,
    createContext: () => new AudioContext(),
    createWorklet: (context, options) =>
      new AudioWorkletNode(context, "nodex-realtime-buffered-audio", options),
    createPeer: () => new RTCPeerConnection(),
    createAudio: () => document.createElement("audio"),
  };
};

/** A granted attempt owns capture, DSP, transport and playback; Main owns its microphone claim. */
export async function createRealtimeVoiceMedia(
  input: RealtimeVoiceMediaInput,
  suppliedPlatform?: RealtimeVoiceMediaPlatform,
): Promise<{ readonly offerSdp: string; readonly media: RealtimeVoiceMedia }> {
  let stopped = false;
  let connected = false;
  let initialized = false;
  let released = false;
  let failureReported = false;
  let microphoneMuted = input.initiallyInputMuted ?? false;
  let outputMuted = input.initiallyOutputMuted ?? false;
  let muteRequestId = 0;
  let preferredDeviceId = input.grant.microphoneInputDeviceId;
  let appliedDeviceId: string | null = null;
  let context: AudioContext | null = null;
  let processor: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let microphone: MediaStream | null = null;
  let output: MediaStream | null = null;
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let audio: HTMLAudioElement | null = null;
  let platform: RealtimeVoiceMediaPlatform | null = null;
  let pendingCapture: Promise<MediaStream> | null = null;
  let pendingRefresh = Promise.resolve();
  let stopping: Promise<void> | null = null;
  const remoteTracks = new Set<MediaStreamTrack>();
  const stoppedTracks = new WeakSet<MediaStreamTrack>();
  const stopTrack = (track: MediaStreamTrack) => {
    if (stoppedTracks.has(track)) return;
    stoppedTracks.add(track);
    track.stop();
  };
  const stopTracks = (stream: MediaStream | null) => stream?.getTracks().forEach(stopTrack);
  const closePendingCapture = () => pendingCapture?.then(stopTracks);
  const isCurrent = () => !stopped && !input.signal.aborted && input.assertCanCapture();
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException("Voice capture retired", "AbortError");
  };
  const notifyChanged = () => {
    if (isCurrent()) input.onMediaChanged?.();
  };
  const applyInputMute = () => {
    if (!processor || stopped) return;
    if (microphoneMuted)
      destination?.stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    // AudioWorklet MessagePort, not Window.postMessage.
    processor.port.postMessage({
      type: "mute",
      muted: microphoneMuted,
      requestId: ++muteRequestId,
    });
    microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !microphoneMuted;
    });
  };
  const releaseInput = () => {
    if (stopped || released || !processor) return;
    released = true;
    processor.port.postMessage({ type: "release" });
  };
  const closeResources = () => {
    if (channel) {
      channel.onmessage = null;
      channel.onerror = null;
      channel.onclose = null;
    }
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
    }
    if (processor) {
      processor.port.onmessage = null;
    }
    const teardown = [
      () => channel?.close(),
      () => peer?.close(),
      () => processor?.port.close(),
      () => processor?.disconnect(),
      () => source?.disconnect(),
      () => destination?.disconnect(),
      () => stopTracks(microphone),
      () => stopTracks(destination?.stream ?? null),
      () => stopTracks(output),
      () => remoteTracks.forEach(stopTrack),
      () => audio?.pause(),
      () => {
        if (audio) audio.srcObject = null;
      },
      () => context?.close(),
    ];
    const pending = teardown.map((dispose) => {
      try {
        return dispose();
      } catch {
        return undefined;
      }
    });
    output = null;
    return Promise.allSettled(pending);
  };
  const handleAbort = () => {
    void media.stop();
  };
  const handleDeviceChange = () => {
    if (!isCurrent()) return;
    void refreshInput(preferredDeviceId, true).catch((error) => {
      if (isCurrent()) console.warn("Unable to refresh the voice microphone", error);
    });
  };
  const capture = (deviceId: string | null): Promise<MediaStream> => {
    assertCurrent();
    if (!platform) throw new Error("Voice media platform was not prepared");
    const devices = platform.mediaDevices;
    const pending = acquireMicrophone({
      selectedDeviceId: deviceId,
      builtInMicrophoneLabelHint: input.grant.builtInMicrophoneLabelHint,
      mediaDevices: {
        enumerateDevices: async () => {
          assertCurrent();
          const available = await devices.enumerateDevices();
          assertCurrent();
          return available;
        },
        getUserMedia: async (constraints) => {
          assertCurrent();
          const stream = await devices.getUserMedia({
            audio: {
              ...(typeof constraints?.audio === "object" ? constraints.audio : {}),
              channelCount: 1,
              noiseSuppression: true,
            },
          });
          if (!isCurrent()) {
            stopTracks(stream);
            throw new DOMException("Voice capture retired", "AbortError");
          }
          return stream;
        },
      },
    });
    pendingCapture = pending;
    return pending;
  };
  const refreshInput = (deviceId: string | null, force = false): Promise<void> => {
    if (stopped) return stopping ?? Promise.resolve();
    if (!force && deviceId === preferredDeviceId && deviceId === appliedDeviceId)
      return pendingRefresh;
    preferredDeviceId = deviceId;
    const refresh = pendingRefresh.then(async () => {
      if (!isCurrent() || !context || !processor) return;
      const stream = await capture(deviceId);
      if (!isCurrent()) {
        stopTracks(stream);
        return;
      }
      let next: MediaStreamAudioSourceNode | null = null;
      try {
        next = context.createMediaStreamSource(stream);
        if (!isCurrent()) {
          next.disconnect();
          stopTracks(stream);
          return;
        }
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !microphoneMuted;
        });
        next.connect(processor);
      } catch (error) {
        next?.disconnect();
        stopTracks(stream);
        throw error;
      }
      const previousStream = microphone;
      const previousSource = source;
      microphone = stream;
      source = next;
      appliedDeviceId = deviceId;
      previousSource?.disconnect();
      stopTracks(previousStream);
      notifyChanged();
    });
    pendingRefresh = refresh.catch(() => {});
    return refresh;
  };
  const media: RealtimeVoiceMedia = {
    async acceptAnswer(sdp) {
      assertCurrent();
      if (!peer) throw new Error("Voice transport was not prepared");
      await peer.setRemoteDescription({ type: "answer", sdp });
      assertCurrent();
    },
    setMicrophoneMuted(muted) {
      if (!isCurrent()) return;
      microphoneMuted = muted;
      applyInputMute();
    },
    setOutputMuted(muted) {
      if (!isCurrent()) return;
      outputMuted = muted;
      if (!audio) return;
      audio.muted = muted;
      if (!muted && audio.srcObject) void audio.play().catch(() => {});
    },
    releaseInput,
    refreshInput,
    readInputStream: () => (stopped ? null : microphone),
    readOutputStream: () => (stopped ? null : output),
    stop() {
      if (stopping) return stopping;
      stopped = true;
      input.signal.removeEventListener("abort", handleAbort);
      platform?.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
      const closing = closeResources();
      stopping = Promise.allSettled([closing, pendingRefresh, closePendingCapture()]).then(
        () => {},
      );
      return stopping;
    },
  };
  const reportFailure = (error: unknown) => {
    if (!isCurrent() || failureReported) return;
    failureReported = true;
    input.onFailure(error);
  };
  input.signal.addEventListener("abort", handleAbort, { once: true });
  try {
    assertCurrent();
    platform = suppliedPlatform ?? browserPlatform();
    const permission = await input.requestMicrophoneAccess();
    assertCurrent();
    if (permission.kind !== "granted")
      throw new DOMException(
        "Microphone access was not granted",
        permission.kind === "blocked" ? "NotAllowedError" : "NotSupportedError",
      );
    context = platform.createContext();
    assertCurrent();
    const loading = context.audioWorklet.addModule(workletUrl);
    const capturing = capture(preferredDeviceId);
    const [stream] = await Promise.all([capturing, loading]);
    assertCurrent();
    microphone = stream;
    appliedDeviceId = preferredDeviceId;
    source = context.createMediaStreamSource(stream);
    assertCurrent();
    processor = platform.createWorklet(context, {
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
      processorOptions: { bufferInputWhileConnecting: input.grant.bufferInputWhileConnecting },
    });
    assertCurrent();
    destination = context.createMediaStreamDestination();
    assertCurrent();
    destination.channelCount = 1;
    source.connect(processor);
    processor.connect(destination);
    processor.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        !isCurrent() ||
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        data.type !== "mute-applied" ||
        !("requestId" in data) ||
        data.requestId !== muteRequestId ||
        !("muted" in data) ||
        typeof data.muted !== "boolean"
      )
        return;
      destination?.stream.getAudioTracks().forEach((track) => {
        track.enabled = !microphoneMuted && !data.muted;
      });
    };
    applyInputMute();
    await context.resume();
    assertCurrent();
    platform.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    peer = platform.createPeer();
    assertCurrent();
    audio = platform.createAudio();
    assertCurrent();
    audio.autoplay = true;
    audio.hidden = true;
    audio.muted = outputMuted;
    channel = peer.createDataChannel("oai-events");
    assertCurrent();
    channel.onmessage = (event) => {
      if (!isCurrent() || typeof event.data !== "string") return;
      input.onEvent?.(event.data);
      if (initialized || !isCurrent()) return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        (value.type !== "session.started" && value.type !== "session.updated") ||
        !("session" in value) ||
        !value.session ||
        typeof value.session !== "object" ||
        !("id" in value.session) ||
        typeof value.session.id !== "string"
      )
        return;
      initialized = true;
      input.onInitialized(value.session.id);
    };
    channel.onerror = () => reportFailure(new Error("Voice data channel failed"));
    channel.onclose = () => reportFailure(new Error("Voice data channel closed"));
    peer.ontrack = (event) => {
      if (!isCurrent()) {
        stopTrack(event.track);
        stopTracks(event.streams[0] ?? null);
        return;
      }
      remoteTracks.add(event.track);
      output = event.streams[0] ?? null;
      if (audio) {
        audio.srcObject = output;
        void audio.play().catch(() => {});
      }
      notifyChanged();
    };
    peer.onconnectionstatechange = () => {
      if (!isCurrent() || !peer) return;
      if (peer.connectionState === "failed") {
        reportFailure(new Error("Voice transport failed"));
        return;
      }
      if (peer.connectionState !== "connected" || connected) return;
      connected = true;
      releaseInput();
      if (isCurrent()) input.onConnected();
    };
    const sendingStream = destination.stream;
    for (const track of sendingStream.getAudioTracks()) peer.addTrack(track, sendingStream);
    const offer = await peer.createOffer();
    assertCurrent();
    if (offer.sdp === undefined) throw new Error("Voice offer did not include SDP");
    await peer.setLocalDescription(offer);
    assertCurrent();
    return { offerSdp: offer.sdp, media };
  } catch (error) {
    await media.stop();
    // A synchronous platform callback may retire before its resource is assigned.
    await Promise.allSettled([closeResources(), closePendingCapture()]);
    throw error;
  }
}
