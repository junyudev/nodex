import { expect, test, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import type { CDPSession } from "vite-plus/test/browser-playwright";
import { createRealtimeVoiceMedia, type RealtimeVoiceMedia } from "./realtime-voice-media";

const silentContext = () =>
  new AudioContext({ sinkId: { type: "none" } } as AudioContextOptions & {
    sinkId: { type: "none" };
  });

test("carries synthetic buffered audio and string initialization over a local WebRTC peer without devices", async () => {
  const devtools: CDPSession = cdp();
  const { targetInfo } = await devtools.send("Target.getTargetInfo");
  const browserContextId = targetInfo.browserContextId;
  await devtools.send("Browser.grantPermissions", {
    permissions: ["audioCapture"],
    origin: location.origin,
    browserContextId,
  });
  const physicalCapture = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(() => {
      throw new Error("This isolated loopback must not access physical input");
    });
  const generator = silentContext();
  const context = silentContext();
  const sink = (value: AudioContext) =>
    (value as AudioContext & { sinkId: string | { type: string } }).sinkId;
  const oscillator = generator.createOscillator();
  oscillator.frequency.value = 220;
  const synthetic = generator.createMediaStreamDestination();
  oscillator.connect(synthetic);
  oscillator.connect(generator.destination);
  oscillator.start();
  const local = new RTCPeerConnection();
  const remote = new RTCPeerConnection();
  const returnStream = synthetic.stream.clone();
  const devices = new EventTarget();
  const remoteCandidates: RTCIceCandidate[] = [];
  const localCandidates: RTCIceCandidate[] = [];
  let remoteEvents: RTCDataChannel | null = null;
  const readRemoteEvents = () => remoteEvents;
  let incoming: MediaStream | null = null;
  let receivingSource: MediaStreamAudioSourceNode | null = null;
  const readReceivingSource = () => receivingSource;
  let media: RealtimeVoiceMedia | null = null;
  const onConnected = vi.fn();
  const onInitialized = vi.fn();
  const onFailure = vi.fn();
  const controller = new AbortController();
  const activate = document.createElement("button");
  activate.textContent = "Start isolated audio";
  document.body.append(activate);
  activate.addEventListener("click", () => {
    void Promise.all([generator.resume(), context.resume()]);
  });
  local.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    if (remote.remoteDescription) void remote.addIceCandidate(event.candidate);
    else remoteCandidates.push(event.candidate);
  });
  remote.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    if (local.remoteDescription) void local.addIceCandidate(event.candidate);
    else localCandidates.push(event.candidate);
  });
  remote.addEventListener("datachannel", (event) => {
    remoteEvents = event.channel;
  });
  remote.addEventListener("track", (event) => {
    incoming = event.streams[0] ?? null;
    if (incoming) {
      receivingSource = generator.createMediaStreamSource(incoming);
      receivingSource.connect(generator.destination);
    }
  });
  const audio = {
    muted: true,
    srcObject: null,
    autoplay: false,
    hidden: false,
    play: async () => {},
    pause: () => {},
  };
  try {
    const inputSink = sink(generator);
    const transportSink = sink(context);
    expect(typeof inputSink === "object" ? inputSink.type : inputSink).toBe("none");
    expect(typeof transportSink === "object" ? transportSink.type : transportSink).toBe("none");
    await userEvent.click(activate);
    await expect.poll(() => generator.state).toBe("running");
    await expect.poll(() => context.state).toBe("running");
    for (const track of returnStream.getAudioTracks()) remote.addTrack(track, returnStream);
    const result = await createRealtimeVoiceMedia(
      {
        grant: {
          hostId: "local",
          threadId: "synthetic",
          claimId: "isolated",
          realtimeSessionId: "native",
          microphoneInputDeviceId: null,
          builtInMicrophoneLabelHint: null,
          bufferInputWhileConnecting: true,
        },
        signal: controller.signal,
        assertCanCapture: () => true,
        requestMicrophoneAccess: async () => ({ kind: "granted", status: "granted" }),
        onConnected,
        onInitialized,
        onFailure,
        initiallyOutputMuted: true,
      },
      {
        mediaDevices: {
          getUserMedia: async () => synthetic.stream,
          enumerateDevices: async () => [],
          addEventListener: devices.addEventListener.bind(devices),
          removeEventListener: devices.removeEventListener.bind(devices),
        },
        createContext: () => context,
        createWorklet: (value, options) =>
          new AudioWorkletNode(value, "nodex-realtime-buffered-audio", options),
        createPeer: () => local,
        // The transport is real; playback is a silent test sink, never a speaker.
        createAudio: () => audio as unknown as HTMLAudioElement,
      },
    );
    media = result.media;
    expect(local.localDescription?.sdp).toBe(result.offerSdp);
    await remote.setRemoteDescription({ type: "offer", sdp: result.offerSdp });
    await Promise.all(
      remoteCandidates.splice(0).map((candidate) => remote.addIceCandidate(candidate)),
    );
    const answer = await remote.createAnswer();
    await remote.setLocalDescription(answer);
    if (!answer.sdp) throw new Error("The loopback answer did not include SDP");
    await media.acceptAnswer(answer.sdp);
    await Promise.all(
      localCandidates.splice(0).map((candidate) => local.addIceCandidate(candidate)),
    );
    await expect.poll(() => local.connectionState, { timeout: 10_000 }).toBe("connected");
    await expect.poll(() => remoteEvents?.readyState, { timeout: 10_000 }).toBe("open");
    const events = remoteEvents as RTCDataChannel | null;
    if (!events) throw new Error("The oai-events channel did not arrive");
    expect(events.label).toBe("oai-events");
    events.send(JSON.stringify({ type: "session.started", session: { id: "local-v3-session" } }));
    await expect.poll(() => onInitialized.mock.calls.length).toBe(1);
    expect(onInitialized).toHaveBeenCalledWith("local-v3-session");
    expect(onConnected).toHaveBeenCalledTimes(1);
    await expect
      .poll(
        async () => {
          const stats = await local.getStats();
          let energy = 0;
          stats.forEach((report) => {
            if (report.type === "media-source" && report.kind === "audio")
              energy += Number(report.totalAudioEnergy ?? 0);
          });
          return energy;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const stats = await remote.getStats();
        let packets = 0;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "audio")
            packets += Number(report.packetsReceived ?? 0);
        });
        return packets;
      })
      .toBeGreaterThan(0);
    expect(incoming).not.toBeNull();
    expect(media.readOutputStream()).not.toBeNull();
    expect(audio.muted).toBe(true);
    const sendingTrack = local.getSenders().find((sender) => sender.track?.kind === "audio")?.track;
    media.setMicrophoneMuted(true);
    expect(sendingTrack?.enabled).toBe(false);
    expect(synthetic.stream.getAudioTracks()[0]!.enabled).toBe(false);
    media.setMicrophoneMuted(false);
    await expect.poll(() => sendingTrack?.enabled).toBe(true);
    controller.abort();
    await media.stop();
    expect(local.connectionState).toBe("closed");
    expect(context.state).toBe("closed");
    expect(synthetic.stream.getAudioTracks()[0]!.readyState).toBe("ended");
    expect(media.readInputStream()).toBeNull();
    expect(audio.srcObject).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
    expect(physicalCapture).not.toHaveBeenCalled();
  } catch (error) {
    const mediaStats: unknown[] = [];
    (await remote.getStats()).forEach((report) => {
      if (report.type === "inbound-rtp") mediaStats.push(report);
    });
    console.error(
      "Isolated voice loopback state",
      JSON.stringify({
        local: {
          connection: local.connectionState,
          ice: local.iceConnectionState,
          gathering: local.iceGatheringState,
          signaling: local.signalingState,
          sdp: local.localDescription?.sdp,
        },
        remote: {
          connection: remote.connectionState,
          ice: remote.iceConnectionState,
          gathering: remote.iceGatheringState,
          signaling: remote.signalingState,
          sdp: remote.localDescription?.sdp,
        },
        callbacks: {
          connected: onConnected.mock.calls.length,
          failure: onFailure.mock.calls.length,
        },
        mediaStats,
      }),
    );
    throw error;
  } finally {
    controller.abort();
    await media?.stop();
    local.close();
    remote.close();
    readRemoteEvents()?.close();
    returnStream.getTracks().forEach((track) => track.stop());
    synthetic.stream.getTracks().forEach((track) => track.stop());
    oscillator.stop();
    oscillator.disconnect();
    readReceivingSource()?.disconnect();
    synthetic.disconnect();
    await Promise.allSettled([
      generator.close(),
      context.state === "closed" ? Promise.resolve() : context.close(),
    ]);
    physicalCapture.mockRestore();
    activate.remove();
    await devtools.send("Browser.resetPermissions", { browserContextId });
  }
}, 25_000);
