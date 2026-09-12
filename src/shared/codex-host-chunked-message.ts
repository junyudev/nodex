import {
  codexTransportArrayValues,
  getCodexSourceLineBytes as getCodexHostSourceLineBytes,
  setCodexSourceLineBytes as setCodexHostSourceLineBytes,
} from "@nodex/effect-codex-app-server/transport-values";
export { getCodexHostSourceLineBytes, setCodexHostSourceLineBytes };

export const CODEX_HOST_CHUNKED_MESSAGE_MARKER = "codex-host-chunked-message-v1" as const;
export const CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const CODEX_HOST_CHUNK_TARGET_BYTES = 2 * 1024 * 1024;
export const CODEX_HOST_CHUNK_ACK_CHANNEL = "codex_desktop:chunked-message-ack";

/** Mirrors the host's bounded structured-size walk used when source line bytes are unavailable. */
export function codexHostMessageExceedsBytes(value: unknown, limit: number): boolean {
  type Work =
    | { type: "value"; value: unknown }
    | { type: "values"; iterator: Iterator<unknown> }
    | { type: "object"; entries: [string, unknown][]; index: number }
    | { type: "leave"; value: object };

  const active = new WeakSet<object>();
  const work: Work[] = [{ type: "value", value }];
  let bytes = 0;
  while (work.length > 0 && bytes <= limit) {
    const next = work.pop();
    if (!next) break;
    if (next.type === "values") {
      const item = next.iterator.next();
      if (!item.done) work.push(next, { type: "value", value: item.value });
      continue;
    }
    if (next.type === "leave") {
      active.delete(next.value);
      continue;
    }
    if (next.type === "object") {
      const entry = next.entries[next.index];
      if (entry) {
        next.index += 1;
        bytes += entry[0].length * 2 + 16;
        work.push(next, { type: "value", value: entry[1] });
      }
      continue;
    }

    const item = next.value;
    if (typeof item === "string") {
      bytes += item.length * 2 + 16;
      continue;
    }
    if (typeof item !== "object" || item === null) {
      bytes += 16;
      continue;
    }
    if (active.has(item)) continue;
    active.add(item);
    bytes += 32;
    const array = Array.isArray(item) ? item : codexTransportArrayValues(item);
    work.push(
      { type: "leave", value: item },
      array
        ? { type: "values", iterator: array[Symbol.iterator]() }
        : { type: "object", entries: Object.entries(item), index: 0 },
    );
  }
  return bytes > limit;
}

const objectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function shouldChunkCodexHostMessage(
  payload: unknown,
  inlineThresholdBytes = CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES,
): boolean {
  if (
    objectRecord(payload) &&
    payload.type === "nativeNotification" &&
    objectRecord(payload.notification)
  ) {
    const params = payload.notification.params;
    const bytes = objectRecord(params) ? getCodexHostSourceLineBytes(params) : undefined;
    if (bytes !== undefined) return bytes > inlineThresholdBytes;
  }
  if (objectRecord(payload) && objectRecord(payload.message)) {
    const bytes =
      getCodexHostSourceLineBytes(payload.message) ??
      (objectRecord(payload.message.result)
        ? getCodexHostSourceLineBytes(payload.message.result)
        : undefined);
    if (bytes !== undefined) return bytes > inlineThresholdBytes;
  }
  if (objectRecord(payload) && objectRecord(payload.params)) {
    const bytes = getCodexHostSourceLineBytes(payload.params);
    if (bytes !== undefined) return bytes > inlineThresholdBytes;
  }
  return codexHostMessageExceedsBytes(payload, inlineThresholdBytes);
}

type Scalar = string | number | boolean | null | undefined;
export type CodexHostMessageToken =
  | { type: "array-start" | "object-start" | "container-end" | "string-end" }
  | { type: "key" | "string-chunk"; value: string }
  | { type: "value"; value?: Scalar }
  | { type: "string-start"; target: "key" | "value" };
export type CodexHostMessagePart = {
  marker: typeof CODEX_HOST_CHUNKED_MESSAGE_MARKER;
  transferId: string;
  sequence: number;
} & ({ kind: "start" | "end" } | { kind: "chunk"; tokens: readonly CodexHostMessageToken[] });
export interface CodexHostMessageAcknowledgement {
  readonly transferId: string;
  readonly sequence: number;
}

function* stringTokens(
  value: string,
  target: "key" | "value",
  size: number,
): Generator<CodexHostMessageToken> {
  if (value.length <= size) {
    yield target === "key" ? { type: "key", value } : { type: "value", value };
    return;
  }
  yield { type: "string-start", target };
  for (let offset = 0; offset < value.length; offset += size)
    yield { type: "string-chunk", value: value.slice(offset, offset + size) };
  yield { type: "string-end" };
}

function* tokens(
  value: unknown,
  size: number,
  arrayValues?: (value: object) => Iterable<unknown> | null,
): Generator<CodexHostMessageToken> {
  type Work =
    | { type: "value"; value: unknown }
    | { type: "string"; value: string }
    | { type: "token"; token: CodexHostMessageToken }
    | { type: "leave"; value: object }
    | { type: "values"; iterator: Iterator<unknown> }
    | { type: "entries"; iterator: Iterator<[string, unknown]> };
  const active = new WeakSet<object>();
  const work: Work[] = [{ type: "value", value }];
  while (work.length) {
    const next = work.pop()!;
    if (next.type === "token") {
      yield next.token;
      continue;
    }
    if (next.type === "leave") {
      active.delete(next.value);
      continue;
    }
    if (next.type === "string") {
      yield* stringTokens(next.value, "key", size);
      continue;
    }
    if (next.type === "values") {
      const item = next.iterator.next();
      if (!item.done) work.push(next, { type: "value", value: item.value });
      continue;
    }
    if (next.type === "entries") {
      const item = next.iterator.next();
      if (!item.done)
        work.push(
          next,
          { type: "value", value: item.value[1] },
          { type: "string", value: item.value[0] },
        );
      continue;
    }
    const item = next.value;
    if (typeof item === "string") {
      yield* stringTokens(item, "value", size);
      continue;
    }
    if (item == null || typeof item === "number" || typeof item === "boolean") {
      yield { type: "value", value: item };
      continue;
    }
    if (typeof item !== "object")
      throw new Error(`Unsupported chunked message value: ${typeof item}`);
    if (active.has(item)) throw new Error("Chunked messages cannot contain cyclic values");
    active.add(item);
    const array = Array.isArray(item) ? item : arrayValues?.(item);
    yield { type: array ? "array-start" : "object-start" };
    work.push(
      { type: "leave", value: item },
      { type: "token", token: { type: "container-end" } },
      array
        ? { type: "values", iterator: array[Symbol.iterator]() }
        : { type: "entries", iterator: Object.entries(item).values() },
    );
  }
}

/** Split structured messages without constructing one giant JSON string or array. */
export function* codexHostMessageParts(
  value: unknown,
  options: {
    transferId: string;
    batchTargetBytes?: number;
    arrayValues?: (value: object) => Iterable<unknown> | null;
  },
): Generator<CodexHostMessagePart> {
  const budget = options.batchTargetBytes ?? CODEX_HOST_CHUNK_TARGET_BYTES;
  let sequence = 0;
  yield {
    marker: CODEX_HOST_CHUNKED_MESSAGE_MARKER,
    kind: "start",
    transferId: options.transferId,
    sequence,
  };
  const input = tokens(
    value,
    Math.max(1, Math.floor(budget / 4)),
    options.arrayValues ?? codexTransportArrayValues,
  );
  let pending: CodexHostMessageToken | null = null;
  for (;;) {
    const batch: CodexHostMessageToken[] = [];
    let bytes = 0;
    for (;;) {
      const next: IteratorResult<CodexHostMessageToken> =
        pending === null ? input.next() : { done: false, value: pending };
      pending = null;
      if (next.done) break;
      const token: CodexHostMessageToken = next.value!;
      const scalar = "value" in token ? token.value : null;
      const size = 64 + (typeof scalar === "string" ? scalar.length * 2 : 16);
      if (batch.length && bytes + size > budget) {
        pending = token;
        break;
      }
      batch.push(token);
      bytes += size;
    }
    if (!batch.length) break;
    yield {
      marker: CODEX_HOST_CHUNKED_MESSAGE_MARKER,
      kind: "chunk",
      transferId: options.transferId,
      sequence: ++sequence,
      tokens: batch,
    };
  }
  yield {
    marker: CODEX_HOST_CHUNKED_MESSAGE_MARKER,
    kind: "end",
    transferId: options.transferId,
    sequence: ++sequence,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function validToken(value: unknown): value is CodexHostMessageToken {
  if (!record(value)) return false;
  if (
    typeof value.type === "string" &&
    ["array-start", "object-start", "container-end", "string-end"].includes(value.type)
  )
    return true;
  if (value.type === "string-start") return value.target === "key" || value.target === "value";
  if (value.type === "key" || value.type === "string-chunk") return typeof value.value === "string";
  return (
    value.type === "value" &&
    (value.value == null || ["boolean", "number", "string"].includes(typeof value.value))
  );
}
function isPart(value: unknown): value is CodexHostMessagePart {
  return (
    record(value) &&
    value.marker === CODEX_HOST_CHUNKED_MESSAGE_MARKER &&
    typeof value.transferId === "string" &&
    Number.isSafeInteger(value.sequence) &&
    (value.kind === "start" ||
      value.kind === "end" ||
      (value.kind === "chunk" && Array.isArray(value.tokens) && value.tokens.every(validToken)))
  );
}
const unset = Symbol("unset");
class Assembler {
  private readonly stack: (
    | { type: "array"; value: unknown[] }
    | { type: "object"; value: Record<string, unknown>; key: string | null }
  )[] = [];
  private root: unknown = unset;
  private chunks: string[] | null = null;
  private target: "key" | "value" | null = null;
  consume(tokens: readonly CodexHostMessageToken[]): void {
    for (const token of tokens) {
      switch (token.type) {
        case "array-start": {
          const value: unknown[] = [];
          this.save(value);
          this.stack.push({ type: "array", value });
          break;
        }
        case "object-start": {
          const value = {};
          this.save(value);
          this.stack.push({ type: "object", value, key: null });
          break;
        }
        case "container-end":
          if (!this.stack.pop())
            throw new Error("Chunked message contained an unmatched container end");
          break;
        case "key":
          this.key(token.value);
          break;
        case "value":
          this.save(token.value);
          break;
        case "string-start":
          if (this.chunks) throw new Error("Chunked message contained nested string chunks");
          this.chunks = [];
          this.target = token.target;
          break;
        case "string-chunk":
          if (!this.chunks) throw new Error("Chunked message string chunk had no start token");
          this.chunks.push(token.value);
          break;
        case "string-end": {
          if (!this.chunks || !this.target)
            throw new Error("Chunked message string end had no start token");
          const value = this.chunks.join("");
          const target = this.target;
          this.chunks = null;
          this.target = null;
          if (target === "key") this.key(value);
          else this.save(value);
          break;
        }
      }
    }
  }
  finish(): unknown {
    if (this.root === unset || this.stack.length || this.chunks)
      throw new Error("Chunked message ended before its value was complete");
    return this.root;
  }
  private key(key: string): void {
    const parent = this.stack.at(-1);
    if (parent?.type !== "object" || parent.key !== null)
      throw new Error("Chunked message key was outside an object");
    parent.key = key;
  }
  private save(value: unknown): void {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.root !== unset) throw new Error("Chunked message contained multiple root values");
      this.root = value;
      return;
    }
    if (parent.type === "array") {
      parent.value.push(value);
      return;
    }
    if (parent.key === null) throw new Error("Chunked message object value had no key");
    Object.defineProperty(parent.value, parent.key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    parent.key = null;
  }
}

export class CodexHostMessageReceiver {
  private readonly transfers = new Map<string, { assembler: Assembler; next: number }>();
  receive(
    message: unknown,
  ):
    | { type: "passthrough"; message: unknown }
    | { type: "pending"; acknowledgement: CodexHostMessageAcknowledgement | null }
    | { type: "complete"; message: unknown; acknowledgement: CodexHostMessageAcknowledgement } {
    if (!isPart(message)) return { type: "passthrough", message };
    const acknowledgement = { transferId: message.transferId, sequence: message.sequence };
    if (message.kind === "start") {
      this.transfers.clear();
      this.transfers.set(message.transferId, {
        assembler: new Assembler(),
        next: message.sequence + 1,
      });
      return { type: "pending", acknowledgement };
    }
    const transfer = this.transfers.get(message.transferId);
    if (!transfer || transfer.next !== message.sequence) {
      this.transfers.delete(message.transferId);
      return { type: "pending", acknowledgement: null };
    }
    transfer.next += 1;
    if (message.kind === "chunk") {
      transfer.assembler.consume(message.tokens);
      return { type: "pending", acknowledgement };
    }
    this.transfers.delete(message.transferId);
    return { type: "complete", message: transfer.assembler.finish(), acknowledgement };
  }
}
