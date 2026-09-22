import { createBrowserDictationStreamingPort } from "../../../src/renderer/features/dictation/dictation-streaming-client";
import { globalDictationTransport } from "../../../src/renderer/features/dictation/global-dictation-transport";

const button = document.querySelector("button")!;
button.addEventListener("click", () => void run(), { once: true });
async function run(): Promise<void> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const oscillator = context.createOscillator();
  const destination = context.createMediaStreamDestination();
  const updates: unknown[] = [];
  const recoveryAudio: unknown[] = [];
  const attempt = await createBrowserDictationStreamingPort(globalDictationTransport.readStreamingConnectInfo).prepare(crypto.randomUUID(), { onTranscript: (text, segment) => updates.push({ text, segment }) });
  try {
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    await attempt.start(destination.stream);
    if (button.dataset.segmented === "true") {
      await new Promise<void>((resolve) => {
        button.textContent = "Split synthetic audio";
        button.addEventListener("click", () => { attempt.split(); resolve(); }, { once: true });
      });
    }
    // The integration host finishes only after real PCM reaches its WebSocket.
    // A wall-clock delay can expire while the audio graph still emits startup silence.
    await new Promise<void>((resolve) => {
      button.textContent = "Finish synthetic audio";
      button.addEventListener("click", () => resolve(), { once: true });
    });
    await attempt.stopAndFlush();
    const text = await attempt.finish();
    const recovered = text === null && attempt.hasBoundaries() ? await attempt.recover(async (blob) => {
      const bytes = await blob.arrayBuffer();
      const header = new DataView(bytes);
      const pcmBytes = new Uint8Array(bytes, 44);
      let pcm = "";
      for (const byte of pcmBytes) pcm += String.fromCharCode(byte);
      recoveryAudio.push({ sampleRate: header.getUint32(24, true), channels: header.getUint16(22, true), bitsPerSample: header.getUint16(34, true), pcm: btoa(pcm) });
      return "Recovered segment.";
    }, new AbortController().signal) : null;
    document.querySelector("output")!.textContent = JSON.stringify({ text, recovered, recoveryAudio, updates, diagnostics: attempt.diagnostics?.() });
  } catch (error) {
    document.querySelector("output")!.textContent = JSON.stringify({ error: error instanceof Error ? error.message : "unknown", diagnostics: attempt.diagnostics?.() });
  } finally {
    attempt.abort();
    oscillator.stop();
    destination.stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}
