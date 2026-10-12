import { StringDecoder } from "node:string_decoder";
import type { CodexPeerMessage } from "../../../shared/codex-peer-protocol";
import type { CodexPeerReceiveMetrics } from "./CodexPeerMetrics";

export const CODEX_PEER_MAX_FRAME_BYTES = 256 * 1024 * 1024;

export function encodeCodexPeerFrame(message: CodexPeerMessage): Buffer {
  return encodeCodexPeerJson(JSON.stringify(message));
}

export function encodeCodexPeerJson(text: string): Buffer {
  const length = Buffer.byteLength(text, "utf8");
  const frame = Buffer.alloc(4 + length);
  frame.writeUInt32LE(length, 0);
  frame.write(text, 4, "utf8");
  return frame;
}

/** Incremental UTF-8 decoding avoids retaining all socket fragments alongside the parsed JSON. */
export function createCodexPeerFrameReader(
  onMessage: (message: CodexPeerMessage) => void,
  metrics?: CodexPeerReceiveMetrics,
) {
  const header = Buffer.alloc(4);
  const decoder = new StringDecoder("utf8");
  let headerBytes = 0;
  let length = 0;
  let received = 0;
  let text = "";
  let currentText = "";
  let fragments = 0;
  let disposed = false;
  const readHeader = (chunk: Buffer, offset: number): number => {
    const count = Math.min(4 - headerBytes, chunk.length - offset);
    chunk.copy(header, headerBytes, offset, offset + count);
    headerBytes += count;
    if (headerBytes < 4) return offset + count;
    length = header.readUInt32LE(0);
    headerBytes = 0;
    if (length === 0 || length > CODEX_PEER_MAX_FRAME_BYTES) {
      throw new Error(`Invalid frame length (${length} bytes)`);
    }
    metrics?.begin(length);
    return offset + count;
  };
  const appendFragment = (fragment: Buffer): void => {
    currentText += decoder.write(fragment);
    fragments += 1;
    if (fragments !== 1024) return;
    text += Buffer.from(currentText, "utf8").toString("utf8");
    currentText = "";
    fragments = 0;
  };
  const read = (chunk: Buffer): void => {
    let offset = 0;
    while (offset < chunk.length) {
      if (length === 0) {
        offset = readHeader(chunk, offset);
      }
      if (length === 0) return;
      const count = Math.min(length - received, chunk.length - offset);
      if (count === 0) return;
      const fragment = chunk.subarray(offset, offset + count);
      received += count;
      offset += count;
      metrics?.decode(count);
      if (received < length) {
        appendFragment(fragment);
        metrics?.endDecode();
        return;
      }
      const json =
        received === count ? fragment.toString("utf8") : text + currentText + decoder.end(fragment);
      length = 0;
      received = 0;
      text = "";
      currentText = "";
      fragments = 0;
      const message = JSON.parse(json) as CodexPeerMessage;
      metrics?.complete(message);
      onMessage(message);
    }
  };
  const receive = (chunk: Buffer): void => {
    if (disposed) return;
    try {
      read(chunk);
    } catch (error) {
      metrics?.fail();
      throw error;
    }
  };
  return Object.assign(receive, {
    [Symbol.dispose]: () => {
      if (disposed) return;
      disposed = true;
      metrics?.close();
      decoder.end();
      text = "";
      currentText = "";
    },
  });
}
