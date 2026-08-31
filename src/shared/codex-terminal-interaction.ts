export const CODEX_TERMINAL_INTERACTION_MAX_BUFFERED_ITEMS = 64;
export const CODEX_TERMINAL_INTERACTION_MAX_BUFFERED_BYTES_PER_ITEM = 64 * 1_024;
export const CODEX_TERMINAL_INTERACTION_MAX_BUFFERED_BYTES = 1 * 1_024 * 1_024;
export const CODEX_TERMINAL_INTERACTION_MAX_IDLE_MS = 60_000;
export const CODEX_TERMINAL_INTERACTION_MAX_COMMANDS_PER_INPUT = 64;
export const CODEX_TERMINAL_INTERACTION_MAX_COMMAND_BYTES_PER_INPUT = 256 * 1_024;

export interface CodexTerminalInteractionIdentity {
  readonly conversationId: string;
  readonly turnId: string;
  readonly itemId: string;
}

export type CodexTerminalInteractionOverflowReason =
  | "buffered-item-limit"
  | "buffered-item-bytes"
  | "buffered-total-bytes"
  | "command-count"
  | "command-bytes";

export type CodexTerminalInteractionAccumulatorResult =
  | {
      readonly disposition: "applied";
      readonly commands: readonly string[];
    }
  | {
      readonly disposition: "overflow";
      readonly commands: readonly [];
      readonly reason: CodexTerminalInteractionOverflowReason;
    };

export interface CodexTerminalInteractionAccumulatorOptions {
  readonly maxBufferedItems?: number;
  readonly maxBufferedBytesPerItem?: number;
  readonly maxBufferedBytes?: number;
  readonly maxIdleMs?: number;
  readonly maxCommandsPerInput?: number;
  readonly maxCommandBytesPerInput?: number;
}

interface TerminalInputBuffer {
  readonly identity: CodexTerminalInteractionIdentity;
  readonly input: string;
  readonly inputBytes: number;
  readonly retainedBytes: number;
  readonly updatedAtMs: number;
}

interface ParseTerminalInputResult {
  readonly input: string;
  readonly bytes: number;
  readonly commands: readonly string[];
  readonly overflowReason: CodexTerminalInteractionOverflowReason | null;
}

interface ParseTerminalInputOptions {
  readonly maxBufferedBytesPerItem: number;
  readonly maxCommandsPerInput: number;
  readonly maxCommandBytesPerInput: number;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** UTF-8 byte count without allocating a second encoded copy of an untrusted notification. */
export function codexUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (codeUnit <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (
      isHighSurrogate(codeUnit) &&
      index + 1 < value.length &&
      isLowSurrogate(value.charCodeAt(index + 1))
    ) {
      bytes += 4;
      index += 1;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}

function codexUtf8ByteLengthAfterAppend(
  current: string,
  currentBytes: number,
  suffix: string,
): number {
  if (suffix.length === 0) return currentBytes;
  const suffixBytes = codexUtf8ByteLength(suffix);
  if (current.length === 0) return suffixBytes;
  const previous = current.charCodeAt(current.length - 1);
  const next = suffix.charCodeAt(0);
  return isHighSurrogate(previous) && isLowSurrogate(next)
    ? currentBytes + suffixBytes - 2
    : currentBytes + suffixBytes;
}

function removeLastInputCodeUnit(
  input: string,
  inputBytes: number,
): { readonly input: string; readonly bytes: number } {
  if (input.length === 0) return { input, bytes: inputBytes };
  const lastIndex = input.length - 1;
  const last = input.charCodeAt(lastIndex);
  const previous = lastIndex > 0 ? input.charCodeAt(lastIndex - 1) : null;
  const removedBytes =
    previous !== null && isHighSurrogate(previous) && isLowSurrogate(last)
      ? 1
      : last <= 0x7f
        ? 1
        : last <= 0x7ff
          ? 2
          : 3;
  return {
    input: input.slice(0, -1),
    bytes: Math.max(0, inputBytes - removedBytes),
  };
}

function parseTerminalInput(
  existingInput: string,
  existingBytes: number,
  stdin: string,
  options: ParseTerminalInputOptions,
): ParseTerminalInputResult {
  let input = existingInput;
  let bytes = existingBytes;
  let overflowReason: CodexTerminalInteractionOverflowReason | null = null;
  let discardingOverflowedInput = false;
  const commands: string[] = [];
  let commandBytes = 0;
  let segmentStart = 0;

  const appendSegment = (end: number): void => {
    if (segmentStart === end || discardingOverflowedInput) return;
    const segment = stdin.slice(segmentStart, end);
    const nextBytes = codexUtf8ByteLengthAfterAppend(input, bytes, segment);
    if (nextBytes > options.maxBufferedBytesPerItem) {
      overflowReason ??= "buffered-item-bytes";
      input = "";
      bytes = 0;
      discardingOverflowedInput = true;
      return;
    }
    input = `${input}${segment}`;
    bytes = nextBytes;
  };

  const completeInputLine = (): void => {
    if (discardingOverflowedInput) {
      discardingOverflowedInput = false;
      input = "";
      bytes = 0;
      return;
    }
    const command = input.trim();
    input = "";
    bytes = 0;
    if (command.length === 0) return;

    const nextCommandBytes = commandBytes + codexUtf8ByteLength(command);
    if (commands.length >= options.maxCommandsPerInput) {
      overflowReason ??= "command-count";
      return;
    }
    if (nextCommandBytes > options.maxCommandBytesPerInput) {
      overflowReason ??= "command-bytes";
      return;
    }
    commands.push(command);
    commandBytes = nextCommandBytes;
  };

  for (let index = 0; index < stdin.length; index += 1) {
    const codeUnit = stdin.charCodeAt(index);
    const isLineEnd = codeUnit === 0x0a || codeUnit === 0x0d;
    const isInterrupt = codeUnit === 0x03;
    const isBackspace = codeUnit === 0x08 || codeUnit === 0x7f;
    if (!isLineEnd && !isInterrupt && !isBackspace) continue;

    appendSegment(index);
    if (isLineEnd) {
      completeInputLine();
    } else if (isInterrupt) {
      discardingOverflowedInput = false;
      input = "";
      bytes = 0;
    } else if (!discardingOverflowedInput) {
      ({ input, bytes } = removeLastInputCodeUnit(input, bytes));
    }
    segmentStart = index + 1;
  }
  appendSegment(stdin.length);

  return { input, bytes, commands, overflowReason };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Stable collision-free key shared by the bounded Map and its test fixtures. */
export function getTerminalInteractionBufferKey(
  identity: CodexTerminalInteractionIdentity,
): string {
  return JSON.stringify([identity.conversationId, identity.turnId, identity.itemId]);
}

/**
 * Owns partial terminal input only. Parsed commands leave this accumulator immediately; canonical
 * command-action retention is bounded independently at the reducer seam.
 */
export class CodexTerminalInteractionAccumulator {
  private readonly maxBufferedItems: number;
  private readonly maxBufferedBytesPerItem: number;
  private readonly maxBufferedBytes: number;
  private readonly maxIdleMs: number;
  private readonly maxCommandsPerInput: number;
  private readonly maxCommandBytesPerInput: number;
  private readonly buffers = new Map<string, TerminalInputBuffer>();
  private bufferedBytes = 0;

  constructor(options: CodexTerminalInteractionAccumulatorOptions = {}) {
    this.maxBufferedItems = positiveInteger(
      options.maxBufferedItems,
      CODEX_TERMINAL_INTERACTION_MAX_BUFFERED_ITEMS,
    );
    this.maxBufferedBytesPerItem = positiveInteger(
      options.maxBufferedBytesPerItem,
      CODEX_TERMINAL_INTERACTION_MAX_BUFFERED_BYTES_PER_ITEM,
    );
    this.maxBufferedBytes = positiveInteger(
      options.maxBufferedBytes,
      CODEX_TERMINAL_INTERACTION_MAX_BUFFERED_BYTES,
    );
    this.maxIdleMs = positiveInteger(options.maxIdleMs, CODEX_TERMINAL_INTERACTION_MAX_IDLE_MS);
    this.maxCommandsPerInput = positiveInteger(
      options.maxCommandsPerInput,
      CODEX_TERMINAL_INTERACTION_MAX_COMMANDS_PER_INPUT,
    );
    this.maxCommandBytesPerInput = positiveInteger(
      options.maxCommandBytesPerInput,
      CODEX_TERMINAL_INTERACTION_MAX_COMMAND_BYTES_PER_INPUT,
    );
  }

  accept(
    identity: CodexTerminalInteractionIdentity,
    stdin: string,
    observedAtMs = Date.now(),
  ): CodexTerminalInteractionAccumulatorResult {
    this.discardExpired(observedAtMs);
    const key = getTerminalInteractionBufferKey(identity);
    const current = this.buffers.get(key);
    const parsed = parseTerminalInput(current?.input ?? "", current?.inputBytes ?? 0, stdin, {
      maxBufferedBytesPerItem: this.maxBufferedBytesPerItem,
      maxCommandsPerInput: this.maxCommandsPerInput,
      maxCommandBytesPerInput: this.maxCommandBytesPerInput,
    });
    if (parsed.overflowReason !== null) {
      this.delete(key);
      return { disposition: "overflow", commands: [], reason: parsed.overflowReason };
    }

    if (parsed.input.length === 0) {
      this.delete(key);
      return { disposition: "applied", commands: parsed.commands };
    }
    const retainedBytes = codexUtf8ByteLength(key) + parsed.bytes;
    if (retainedBytes > this.maxBufferedBytesPerItem) {
      this.delete(key);
      return { disposition: "overflow", commands: [], reason: "buffered-item-bytes" };
    }
    if (!current && this.buffers.size >= this.maxBufferedItems) {
      return { disposition: "overflow", commands: [], reason: "buffered-item-limit" };
    }
    const nextBufferedBytes = this.bufferedBytes - (current?.retainedBytes ?? 0) + retainedBytes;
    if (nextBufferedBytes > this.maxBufferedBytes) {
      this.delete(key);
      return { disposition: "overflow", commands: [], reason: "buffered-total-bytes" };
    }

    this.buffers.set(key, {
      identity,
      input: parsed.input,
      inputBytes: parsed.bytes,
      retainedBytes,
      updatedAtMs: observedAtMs,
    });
    this.bufferedBytes = nextBufferedBytes;
    return { disposition: "applied", commands: parsed.commands };
  }

  clearItem(identity: CodexTerminalInteractionIdentity): void {
    this.delete(getTerminalInteractionBufferKey(identity));
  }

  clearTurn(conversationId: string, turnId: string): void {
    for (const [key, buffer] of this.buffers) {
      if (buffer.identity.conversationId !== conversationId || buffer.identity.turnId !== turnId) {
        continue;
      }
      this.delete(key);
    }
  }

  clearConversation(conversationId: string): void {
    for (const [key, buffer] of this.buffers) {
      if (buffer.identity.conversationId !== conversationId) continue;
      this.delete(key);
    }
  }

  clear(): void {
    this.buffers.clear();
    this.bufferedBytes = 0;
  }

  get bufferedItemCount(): number {
    return this.buffers.size;
  }

  get bufferedByteLength(): number {
    return this.bufferedBytes;
  }

  private discardExpired(observedAtMs: number): void {
    const cutoff = observedAtMs - this.maxIdleMs;
    for (const [key, buffer] of this.buffers) {
      if (buffer.updatedAtMs > cutoff) continue;
      this.delete(key);
    }
  }

  private delete(key: string): void {
    const current = this.buffers.get(key);
    if (!current) return;
    this.buffers.delete(key);
    this.bufferedBytes = Math.max(0, this.bufferedBytes - current.retainedBytes);
  }
}
