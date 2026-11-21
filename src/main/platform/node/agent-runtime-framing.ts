const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Retain bytes only until one bounded frame is complete; UTF-8 may cross chunks. `observeFrame`
 * sees each decoded frame with its exact wire size, line feed included.
 */
export function createAgentRuntimeFrameDecoder(
  maximumBytes: number,
  observeFrame?: (frame: unknown, wireBytes: number) => void,
) {
  let segments: Uint8Array[] = [];
  let retainedBytes = 0;

  const append = (bytes: Uint8Array) => {
    if (retainedBytes + bytes.byteLength > maximumBytes)
      throw new Error("Agent Runtime frame exceeds the transport budget");
    if (bytes.byteLength === 0) return;
    segments.push(bytes);
    retainedBytes += bytes.byteLength;
  };

  return {
    push(chunk: Uint8Array): readonly unknown[] {
      const frames: unknown[] = [];
      let offset = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 10) continue;
        append(chunk.subarray(offset, index));
        const bytes = new Uint8Array(retainedBytes);
        let position = 0;
        for (const segment of segments) {
          bytes.set(segment, position);
          position += segment.byteLength;
        }
        segments = [];
        retainedBytes = 0;
        offset = index + 1;
        const line = decoder.decode(bytes).trim();
        if (!line) continue;
        const frame: unknown = JSON.parse(line);
        observeFrame?.(frame, bytes.byteLength + 1);
        frames.push(frame);
      }
      append(chunk.subarray(offset));
      return frames;
    },
    finish(): void {
      if (retainedBytes > 0) throw new Error("Agent Runtime ended with an incomplete frame");
    },
  };
}
