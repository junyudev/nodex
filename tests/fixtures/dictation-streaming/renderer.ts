import { createBrowserDictationStreamingPort } from "../../../src/renderer/features/dictation/dictation-streaming-client";
import { globalDictationTransport } from "../../../src/renderer/features/dictation/global-dictation-transport";

const button = document.querySelector("button")!;
button.addEventListener("click", () => void run());
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
    await new Promise((resolve) => setTimeout(resolve, 350));
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
