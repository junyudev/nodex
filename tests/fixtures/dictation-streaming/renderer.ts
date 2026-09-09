import { createBrowserDictationStreamingPort } from "../../../src/renderer/features/dictation/dictation-streaming-client";
import { globalDictationTransport } from "../../../src/renderer/features/dictation/global-dictation-transport";

const button = document.querySelector("button")!;
button.addEventListener("click", () => void run(), { once: true });
async function run(): Promise<void> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const oscillator = context.createOscillator();
  const destination = context.createMediaStreamDestination();
  const attempt = await createBrowserDictationStreamingPort(globalDictationTransport.readStreamingConnectInfo).prepare(crypto.randomUUID());
  try {
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    await attempt.start(destination.stream);
    // The integration host finishes only after real PCM reaches its WebSocket.
    // A wall-clock delay can expire while the audio graph still emits startup silence.
    await new Promise<void>((resolve) => {
      button.textContent = "Finish synthetic audio";
      button.addEventListener("click", () => resolve(), { once: true });
    });
    await attempt.stopAndFlush();
    const text = await attempt.finish();
    document.querySelector("output")!.textContent = JSON.stringify({ text, diagnostics: attempt.diagnostics?.() });
  } catch (error) {
    document.querySelector("output")!.textContent = JSON.stringify({ error: error instanceof Error ? error.message : "unknown", diagnostics: attempt.diagnostics?.() });
  } finally {
    attempt.abort();
    oscillator.stop();
    destination.stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}
