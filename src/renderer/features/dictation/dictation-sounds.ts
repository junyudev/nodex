const soundUrls = {
  start: new URL("../../assets/dictation/start.wav", import.meta.url).href,
  error: new URL("../../assets/dictation/error.wav", import.meta.url).href,
  stop: new URL("../../assets/dictation/stop.wav", import.meta.url).href,
};

let cancelActiveSound: (() => void) | null = null;

/** One feedback sound at a time; output latency settles before releasing its audio device. */
export function playDictationSound(kind: keyof typeof soundUrls): void {
  cancelActiveSound?.();
  cancelActiveSound = null;
  const abort = new AbortController();
  let context: AudioContext | null = null;
  const cancel = (): void => {
    if (abort.signal.aborted) return;
    abort.abort();
    clearTimeout(deadline);
    void context?.close().catch(() => undefined);
    if (cancelActiveSound === cancel) cancelActiveSound = null;
  };
  let deadline = setTimeout(cancel, 5_000);
  cancelActiveSound = cancel;
  void (async () => {
    const audio = new AudioContext({ latencyHint: "interactive" });
    context = audio;
    const [buffer] = await Promise.all([
      fetch(soundUrls[kind], { signal: abort.signal })
        .then((response) => response.arrayBuffer())
        .then((bytes) => audio.decodeAudioData(bytes)),
      audio.resume(),
    ]);
    if (kind === "stop") {
      const startedAt = audio.currentTime;
      while ((audio.getOutputTimestamp().contextTime ?? 0) <= startedAt) {
        abort.signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    abort.signal.throwIfAborted();
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.addEventListener(
      "ended",
      () => {
        if (abort.signal.aborted) return;
        clearTimeout(deadline);
        deadline = setTimeout(cancel, audio.outputLatency * 1_000);
      },
      { once: true },
    );
    clearTimeout(deadline);
    deadline = setTimeout(cancel, (buffer.duration + audio.outputLatency + 1) * 1_000);
    source.start();
  })().catch(cancel);
}
