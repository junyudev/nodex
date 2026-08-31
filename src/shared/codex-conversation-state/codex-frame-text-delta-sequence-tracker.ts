import {
  buildCodexFrameTextDeltaKey,
  CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_CODE_UNITS,
  type CodexFrameTextDeltaUpdate,
} from "./codex-frame-text-delta-queue";

export const CODEX_FRAME_TEXT_DELTA_MAX_TRACKED_SEQUENCES = 16_384;
export const CODEX_FRAME_TEXT_DELTA_MAX_TRACKED_SEQUENCES_PER_KEY = 4_096;

interface TrackedSequenceSegment {
  readonly sequence: number;
  remainingCodeUnits: number;
}

interface TrackedSequenceBuffer {
  readonly conversationId: string;
  readonly segments: TrackedSequenceSegment[];
  codeUnits: number;
}

export type CodexFrameTextDeltaSequenceTrackResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "segment-count" | "per-key-segment-count" | "code-units";
      readonly conversationId: string;
      readonly sequence: number;
      readonly trackedSegments: number;
      readonly trackedCodeUnits: number;
    };

export interface CodexFrameTextDeltaSequenceTrackerOptions {
  readonly maxSegments?: number;
  readonly maxSegmentsPerKey?: number;
  readonly maxCodeUnits?: number;
}

/**
 * Bounded ACK attribution for a coalescing frame queue. It never owns prose text; it only maps
 * flushed character ranges back to transport sequence identities.
 */
export class CodexFrameTextDeltaSequenceTracker {
  private readonly buffers = new Map<string, TrackedSequenceBuffer>();
  private readonly maxSegments: number;
  private readonly maxSegmentsPerKey: number;
  private readonly maxCodeUnits: number;
  private trackedSegments = 0;
  private trackedCodeUnits = 0;

  constructor(options: CodexFrameTextDeltaSequenceTrackerOptions = {}) {
    this.maxSegments = options.maxSegments ?? CODEX_FRAME_TEXT_DELTA_MAX_TRACKED_SEQUENCES;
    this.maxSegmentsPerKey =
      options.maxSegmentsPerKey ?? CODEX_FRAME_TEXT_DELTA_MAX_TRACKED_SEQUENCES_PER_KEY;
    this.maxCodeUnits = options.maxCodeUnits ?? CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_CODE_UNITS;
  }

  track(
    update: CodexFrameTextDeltaUpdate,
    sequence: number,
  ): CodexFrameTextDeltaSequenceTrackResult {
    const key = buildCodexFrameTextDeltaKey(update);
    const existing = this.buffers.get(key);
    const reject = (
      reason: Exclude<CodexFrameTextDeltaSequenceTrackResult, { accepted: true }>["reason"],
    ): CodexFrameTextDeltaSequenceTrackResult => ({
      accepted: false,
      reason,
      conversationId: update.conversationId,
      sequence,
      trackedSegments: this.trackedSegments,
      trackedCodeUnits: this.trackedCodeUnits,
    });
    if (this.trackedSegments >= this.maxSegments) return reject("segment-count");
    if ((existing?.segments.length ?? 0) >= this.maxSegmentsPerKey) {
      return reject("per-key-segment-count");
    }
    if (this.trackedCodeUnits + update.delta.length > this.maxCodeUnits) {
      return reject("code-units");
    }

    const segment = { sequence, remainingCodeUnits: update.delta.length };
    if (existing) {
      existing.segments.push(segment);
      existing.codeUnits += update.delta.length;
    } else {
      this.buffers.set(key, {
        conversationId: update.conversationId,
        segments: [segment],
        codeUnits: update.delta.length,
      });
    }
    this.trackedSegments += 1;
    this.trackedCodeUnits += update.delta.length;
    return { accepted: true };
  }

  consume(updates: readonly CodexFrameTextDeltaUpdate[]): ReadonlyMap<string, readonly number[]> {
    const completedByConversationId = new Map<string, number[]>();
    for (const update of updates) {
      const key = buildCodexFrameTextDeltaKey(update);
      const buffer = this.buffers.get(key);
      if (!buffer) continue;

      let remainingFlushedCodeUnits = update.delta.length;
      while (buffer.segments.length > 0) {
        const segment = buffer.segments[0];
        if (!segment) break;
        if (segment.remainingCodeUnits > remainingFlushedCodeUnits) {
          segment.remainingCodeUnits -= remainingFlushedCodeUnits;
          buffer.codeUnits -= remainingFlushedCodeUnits;
          this.trackedCodeUnits -= remainingFlushedCodeUnits;
          break;
        }

        remainingFlushedCodeUnits -= segment.remainingCodeUnits;
        buffer.codeUnits -= segment.remainingCodeUnits;
        this.trackedCodeUnits -= segment.remainingCodeUnits;
        buffer.segments.shift();
        this.trackedSegments -= 1;
        const completed = completedByConversationId.get(buffer.conversationId);
        if (completed) completed.push(segment.sequence);
        else completedByConversationId.set(buffer.conversationId, [segment.sequence]);

        if (remainingFlushedCodeUnits === 0 && buffer.segments[0]?.remainingCodeUnits !== 0) break;
      }

      if (buffer.segments.length === 0) this.buffers.delete(key);
    }
    return completedByConversationId;
  }

  discardConversation(conversationId: string): void {
    for (const [key, buffer] of this.buffers) {
      if (buffer.conversationId !== conversationId) continue;
      this.buffers.delete(key);
      this.trackedSegments -= buffer.segments.length;
      this.trackedCodeUnits -= buffer.codeUnits;
    }
  }

  clear(): void {
    this.buffers.clear();
    this.trackedSegments = 0;
    this.trackedCodeUnits = 0;
  }
}
