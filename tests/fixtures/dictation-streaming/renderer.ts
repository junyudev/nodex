import { createBrowserDictationStreamingPort } from "../../../src/renderer/features/dictation/dictation-streaming-client";
import { globalDictationTransport } from "../../../src/renderer/features/dictation/global-dictation-transport";
import { transcribeDictationBlob } from "../../../src/renderer/features/dictation/dictation-buffered-client";

const button = document.querySelector("button")!;
button.addEventListener("click", () => void run(), { once: true });
async function run(): Promise<void> {
  try {
    const state = await globalDictationTransport.readCapabilities();
    if (state.capabilities.streaming !== "available") throw new Error("Streaming is unavailable");
    await streamSyntheticAudio();
  } catch (error) {
    document.querySelector("output")!.textContent = JSON.stringify({ admissionError: error instanceof Error ? error.message : "unknown" });
  }
}
async function streamSyntheticAudio(): Promise<void> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const oscillator = context.createOscillator();
  const destination = context.createMediaStreamDestination();
  const updates: unknown[] = [];
  const recoveryAudio: unknown[] = [];
  const attempt = await createBrowserDictationStreamingPort("global").prepare(crypto.randomUUID(), { onTranscript: (text, segment) => updates.push({ text, segment }) });
  const recorder = new MediaRecorder(destination.stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    chunks.push(event.data);
    button.dataset.bufferedBytes = String(chunks.reduce((total, chunk) => total + chunk.size, 0));
  });
  try {
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    recorder.start(50);
    try {
      await attempt.start(destination.stream);
    } catch (error) {
      if (button.dataset.rejected !== "true") throw error;
    }
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
    const buffered = await new Promise<Blob>((resolve) => {
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true });
      recorder.stop();
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
    const fallbackText = text === null && !attempt.hasBoundaries() ? await transcribeDictationBlob(buffered, {
      transcribe: (input) => globalDictationTransport.transcribe({ ...input, requestId: crypto.randomUUID() }),
    }) : null;
    document.querySelector("output")!.textContent = JSON.stringify({ text, fallbackText, bufferedBytes: buffered.size, recovered, recoveryAudio, updates, diagnostics: attempt.diagnostics?.() });
  } catch (error) {
    document.querySelector("output")!.textContent = JSON.stringify({ error: error instanceof Error ? error.message : "unknown", diagnostics: attempt.diagnostics?.() });
  } finally {
    attempt.abort();
    if (recorder.state !== "inactive") recorder.stop();
    oscillator.stop();
    destination.stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}
