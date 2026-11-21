import { createHash } from "node:crypto";

/**
 * Fixed Runtime conversation corpora for work-invariant tests. Each corpus is generated from a
 * seed, so it rebuilds byte for byte in any fresh home; its manifest records the counts and a
 * content hash, and changing the content means a new revision with new recorded baselines.
 */

export const RUNTIME_CORPUS_MANIFEST_VERSION = 1 as const;

export type RuntimeCorpusId =
  | "runtime-short"
  | "runtime-500-turn"
  | "stream-steady"
  | "dual-window";

/** One settled Turn: a person's prompt and the Agent's final reply. */
export interface RuntimeCorpusTurn {
  readonly prompt: string;
  readonly reply: string;
}

/** One item a scripted provider streams, in the order the corpus lists them. */
export interface RuntimeCorpusStreamItem {
  readonly kind: "reasoning" | "assistant";
  readonly text: string;
}

/**
 * A provider stream at a steady rate: `chunkBytes` of the current item every `intervalMs`,
 * through the Runtime's paragraph streaming mode.
 */
export interface RuntimeCorpusStream {
  readonly prompt: string;
  readonly items: readonly RuntimeCorpusStreamItem[];
  readonly chunkBytes: number;
  readonly intervalMs: number;
  readonly streamingMode: "paragraph";
}

export interface RuntimeCorpus {
  readonly id: RuntimeCorpusId;
  readonly revision: number;
  readonly description: string;
  /** Settled history, oldest first. */
  readonly turns: readonly RuntimeCorpusTurn[];
  /** A Turn that streams after the history, when the corpus measures streaming. */
  readonly stream: RuntimeCorpusStream | null;
  /** Windows observing the conversation at once. */
  readonly observers: number;
}

export interface RuntimeCorpusManifest {
  readonly version: typeof RUNTIME_CORPUS_MANIFEST_VERSION;
  readonly id: RuntimeCorpusId;
  readonly revision: number;
  readonly turns: number;
  /** Settled user and assistant items. */
  readonly items: number;
  readonly promptBytes: number;
  readonly replyBytes: number;
  readonly streamItems: number;
  readonly streamAssistantBytes: number;
  readonly streamReasoningBytes: number;
  readonly streamChunks: number;
  readonly streamDurationMs: number;
  readonly observers: number;
  /** SHA-256 of the corpus content in canonical JSON. */
  readonly sha256: string;
}

const WORDS = [
  "runtime",
  "projection",
  "snapshot",
  "observer",
  "window",
  "boundary",
  "stream",
  "paragraph",
  "message",
  "history",
  "renderer",
  "process",
  "request",
  "sequence",
  "cursor",
  "replay",
  "budget",
  "frame",
  "delivery",
  "install",
  "leaf",
  "commit",
  "reader",
  "owner",
  "transcript",
  "session",
  "thread",
  "turn",
  "item",
  "reply",
  "prompt",
  "engine",
  "keyed",
  "bounded",
  "resident",
  "current",
  "steady",
  "measured",
  "counted",
  "settled",
  "visible",
  "quiet",
  "stable",
  "ordered",
  "compact",
  "durable",
  "local",
  "shared",
  "the",
  "a",
  "of",
  "and",
  "to",
  "in",
  "with",
  "after",
  "before",
  "each",
  "one",
  "every",
  "only",
  "then",
  "while",
  "until",
] as const;

/** A small deterministic generator; Math.random would make every corpus different. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sentence(next: () => number): string {
  const length = 6 + Math.floor(next() * 12);
  const words: string[] = Array.from({ length }, () => WORDS[Math.floor(next() * WORDS.length)]!);
  if (next() < 0.25) words[1] = `**${words[1]}**`;
  if (next() < 0.2) words[length - 2] = `\`${words[length - 2]}\``;
  const text = words.join(" ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/**
 * Markdown of exactly `bytes` ASCII bytes: paragraphs, emphasis, inline code and an occasional
 * list, separated by blank lines so paragraph streaming finds its boundaries.
 */
export function corpusMarkdown(seed: number, bytes: number): string {
  const next = generator(seed);
  const blocks: string[] = [];
  let length = 0;
  for (let index = 0; length < bytes; index += 1) {
    const block =
      index % 5 === 4
        ? Array.from({ length: 3 }, () => `- ${sentence(next)}`).join("\n")
        : Array.from({ length: 2 + Math.floor(next() * 3) }, () => sentence(next)).join(" ");
    blocks.push(block);
    length += block.length + 2;
  }
  return blocks.join("\n\n").slice(0, bytes);
}

const historyTurns = (count: number, seed: number, replyBytes: number): RuntimeCorpusTurn[] =>
  Array.from({ length: count }, (_, index) => ({
    prompt: `Turn ${index + 1}: ${corpusMarkdown(seed + index * 2, 96)}`,
    reply: corpusMarkdown(seed + index * 2 + 1, replyBytes),
  }));

const KIB = 1024;

const RUNTIME_SHORT: RuntimeCorpus = {
  id: "runtime-short",
  revision: 1,
  description: "Three settled Turns with 1 KiB replies.",
  turns: historyTurns(3, 101, KIB),
  stream: null,
  observers: 1,
};

const RUNTIME_500_TURN: RuntimeCorpus = {
  id: "runtime-500-turn",
  revision: 1,
  description: "Five hundred settled Turns with 640 B replies; snapshots stay bounded.",
  turns: historyTurns(500, 5_001, 640),
  stream: null,
  observers: 1,
};

/** A 128 KiB reasoning item, then a 32 KiB reply, each at about 1 KiB/s in paragraph mode. */
const STREAM_STEADY: RuntimeCorpus = {
  id: "stream-steady",
  revision: 1,
  description: "A 128 KiB reasoning item then a 32 KiB reply, streamed at about 1 KiB/s.",
  turns: [],
  stream: {
    prompt: "Stream the steady corpus.",
    items: [
      { kind: "reasoning", text: corpusMarkdown(7_001, 128 * KIB) },
      { kind: "assistant", text: corpusMarkdown(7_002, 32 * KIB) },
    ],
    chunkBytes: 32,
    // About 1 KiB/s; replayed provider frames are paced in whole milliseconds.
    intervalMs: 31,
    streamingMode: "paragraph",
  },
  observers: 1,
};

/** One 400 B paragraph, blank line included, so each chunk completes exactly one paragraph. */
const paragraph = (seed: number) =>
  `${corpusMarkdown(seed, 600).replace(/\n+/g, " ").slice(0, 398)}\n\n`;

/**
 * The short history observed by two windows while a reply streams one whole paragraph per
 * chunk, each chunk landing as exactly one update.
 */
const DUAL_WINDOW: RuntimeCorpus = {
  id: "dual-window",
  revision: 1,
  description: "Runtime-short's history and a three-paragraph reply, observed by two windows.",
  turns: RUNTIME_SHORT.turns,
  stream: {
    prompt: "Stream into both windows.",
    items: [{ kind: "assistant", text: [9_001, 9_002, 9_003].map(paragraph).join("") }],
    chunkBytes: 400,
    intervalMs: 500,
    streamingMode: "paragraph",
  },
  observers: 2,
};

export const RUNTIME_CORPORA: Readonly<Record<RuntimeCorpusId, RuntimeCorpus>> = {
  "runtime-short": RUNTIME_SHORT,
  "runtime-500-turn": RUNTIME_500_TURN,
  "stream-steady": STREAM_STEADY,
  "dual-window": DUAL_WINDOW,
};

/** The chunks a steady stream delivers for one item, in order. */
export function corpusStreamChunks(stream: RuntimeCorpusStream, item: RuntimeCorpusStreamItem) {
  const chunks: string[] = [];
  for (let offset = 0; offset < item.text.length; offset += stream.chunkBytes)
    chunks.push(item.text.slice(offset, offset + stream.chunkBytes));
  return chunks;
}

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

export function runtimeCorpusManifest(corpus: RuntimeCorpus): RuntimeCorpusManifest {
  const streamItems = corpus.stream?.items ?? [];
  const bytesOf = (kind: RuntimeCorpusStreamItem["kind"]) =>
    streamItems
      .filter((item) => item.kind === kind)
      .reduce((sum, item) => sum + utf8(item.text), 0);
  const streamChunks = corpus.stream
    ? streamItems.reduce((sum, item) => sum + corpusStreamChunks(corpus.stream!, item).length, 0)
    : 0;
  return {
    version: RUNTIME_CORPUS_MANIFEST_VERSION,
    id: corpus.id,
    revision: corpus.revision,
    turns: corpus.turns.length,
    items: corpus.turns.length * 2,
    promptBytes: corpus.turns.reduce((sum, turn) => sum + utf8(turn.prompt), 0),
    replyBytes: corpus.turns.reduce((sum, turn) => sum + utf8(turn.reply), 0),
    streamItems: streamItems.length,
    streamAssistantBytes: bytesOf("assistant"),
    streamReasoningBytes: bytesOf("reasoning"),
    streamChunks,
    streamDurationMs: corpus.stream ? streamChunks * corpus.stream.intervalMs : 0,
    observers: corpus.observers,
    sha256: createHash("sha256")
      .update(
        JSON.stringify({
          id: corpus.id,
          revision: corpus.revision,
          turns: corpus.turns,
          stream: corpus.stream,
          observers: corpus.observers,
        }),
      )
      .digest("hex"),
  };
}
