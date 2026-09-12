import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { CodexRequestLifecycleEvent } from "../../../shared/codex-request-lifecycle";

const MAX_ENTRIES = 100;
const PREVIEW_SUFFIX = "\n… truncated preview";
const PREVIEW_BUDGET = 12_000 - 20;

export interface CodexRecordedRequest {
  readonly id: RequestId;
  readonly conversationId: string | null;
  readonly durationMs: number | null;
  readonly endedAtMs: number | null;
  readonly errorPreview: string | null;
  readonly hostId: string;
  readonly matchingRequestSequenceNumber: number;
  readonly method: string;
  readonly paramsPreview: string;
  readonly priority: "background" | "interactive" | "critical";
  readonly queueWaitMs: number;
  readonly resultPreview: string | null;
  readonly source: string;
  readonly startedAtMs: number;
  readonly status: "pending" | "completed" | "failed" | "timed-out";
  readonly timeoutMs: number;
}

interface PreviewState {
  readonly ancestors: Set<object>;
  remainingChars: number;
  truncated: boolean;
}

function consumePreviewBudget(state: PreviewState, count: number): boolean {
  if (state.remainingChars < count) {
    state.remainingChars = 0;
    state.truncated = true;
    return false;
  }
  state.remainingChars -= count;
  return true;
}

function previewValue(
  value: unknown,
  state: PreviewState,
  key: string,
  allowToJson = true,
): unknown {
  if (allowToJson && value !== null && (typeof value === "object" || typeof value === "function")) {
    const toJson = Reflect.get(value, "toJSON");
    if (typeof toJson === "function") {
      return previewValue(Reflect.apply(toJson, value, [key]), state, key, false);
    }
  }
  if (typeof value === "string") {
    const available = Math.max(0, state.remainingChars - 2);
    if (value.length > available) {
      state.remainingChars = 0;
      state.truncated = true;
      return value.slice(0, available);
    }
    state.remainingChars -= value.length + 2;
    return value;
  }
  if (value instanceof Error) {
    return previewValue(
      { message: value.message, name: value.name, stack: value.stack },
      state,
      key,
    );
  }
  if (typeof value === "bigint") return previewValue(value.toString(), state, key);
  if (typeof value === "function") {
    return previewValue(`[Function ${value.name || "anonymous"}]`, state, key);
  }
  if (typeof value !== "object" || value === null) {
    state.remainingChars -= Math.min(state.remainingChars, String(value).length);
    return value;
  }
  if (state.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
  state.ancestors.add(value);
  const projected = Array.isArray(value)
    ? previewArray(value, state)
    : previewObject(value as Record<string, unknown>, state);
  state.ancestors.delete(value);
  return projected;
}

function previewArray(value: readonly unknown[], state: PreviewState): unknown[] {
  const result: unknown[] = [];
  consumePreviewBudget(state, 2);
  for (const [index, item] of value.entries()) {
    if (!consumePreviewBudget(state, 2)) break;
    result.push(previewValue(item, state, String(index)));
    if (state.truncated) break;
  }
  if (result.length < value.length) state.truncated = true;
  return result;
}

function previewObject(
  value: Record<string, unknown>,
  state: PreviewState,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  consumePreviewBudget(state, 2);
  for (const key in value) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
    if (!consumePreviewBudget(state, key.length + 5)) break;
    result[key] = previewValue(Reflect.get(value, key), state, key);
    if (state.truncated) break;
  }
  return result;
}

function finishPreview(value: string, truncated: boolean): string {
  if (!truncated && value.length <= PREVIEW_BUDGET) return value;
  return `${value.slice(0, PREVIEW_BUDGET)}${PREVIEW_SUFFIX}`;
}

export function codexRequestPreview(value: unknown): string {
  try {
    const state: PreviewState = {
      ancestors: new Set(),
      remainingChars: PREVIEW_BUDGET,
      truncated: false,
    };
    const serialized = JSON.stringify(previewValue(value, state, ""), null, 2) ?? String(value);
    return finishPreview(serialized, state.truncated);
  } catch (error) {
    return finishPreview(`[Unserializable payload: ${String(error)}]`, false);
  }
}

class CodexRequestRecorderRegistry {
  private readonly callbacks = new Set<() => void>();
  private readonly recorders = new Set<CodexRequestRecorder>();
  private entriesSnapshot: readonly CodexRecordedRequest[] = [];

  subscribe(callback: () => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  addRecorder(recorder: CodexRequestRecorder): void {
    this.recorders.add(recorder);
  }

  getSnapshot(): readonly CodexRecordedRequest[] {
    return this.entriesSnapshot;
  }

  isCaptureEnabled(): boolean {
    return this.callbacks.size > 0;
  }

  sync(): void {
    const next = [...this.recorders]
      .flatMap((recorder) => recorder.getEntries())
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
    if (
      next.length === this.entriesSnapshot.length &&
      next.every((entry, index) => entry === this.entriesSnapshot[index])
    )
      return;
    this.entriesSnapshot = next;
    for (const callback of this.callbacks) callback();
  }

  clear(hostId: string): void {
    for (const recorder of this.recorders) recorder.clear(hostId);
    this.sync();
  }
}

const requestRecorderRegistry = new CodexRequestRecorderRegistry();

export function subscribeCodexRequestRecords(callback: () => void): () => void {
  return requestRecorderRegistry.subscribe(callback);
}

export function getCodexRequestRecordsSnapshot(): readonly CodexRecordedRequest[] {
  return requestRecorderRegistry.getSnapshot();
}

export function clearCodexRequestRecords(hostId: string): void {
  requestRecorderRegistry.clear(hostId);
}

export class CodexRequestRecorder {
  private entries: CodexRecordedRequest[] = [];
  private readonly countsByKey = new Map<string, number>();

  constructor(private readonly hostId: string) {
    requestRecorderRegistry.addRecorder(this);
  }

  getEntries(): readonly CodexRecordedRequest[] {
    return [...this.entries];
  }

  handle(event: CodexRequestLifecycleEvent): void {
    if (event.type === "background-queue-full" || event.type === "late-response") return;
    if (!requestRecorderRegistry.isCaptureEnabled()) {
      if (event.type !== "started") {
        const entry = this.entries.find((candidate) => candidate.id === event.id);
        if (entry) {
          Object.assign(entry, {
            durationMs: event.endedAtMs - entry.startedAtMs,
            endedAtMs: event.endedAtMs,
            status: event.type,
          });
        }
      }
      return;
    }
    if (event.type === "started") {
      this.track(event);
      return;
    }
    this.finish(event);
  }

  private track(event: Extract<CodexRequestLifecycleEvent, { type: "started" }>): void {
    const paramsPreview = codexRequestPreview(event.params);
    const key = `${event.method}\n${paramsPreview}`;
    const sequence = (this.countsByKey.get(key) ?? 0) + 1;
    this.countsByKey.delete(key);
    this.countsByKey.set(key, sequence);
    if (this.countsByKey.size > MAX_ENTRIES) {
      const oldest = this.countsByKey.keys().next().value;
      if (oldest !== undefined) this.countsByKey.delete(oldest);
    }
    const entry: CodexRecordedRequest = {
      id: event.id,
      conversationId: event.conversationId,
      durationMs: null,
      endedAtMs: null,
      errorPreview: null,
      hostId: this.hostId,
      matchingRequestSequenceNumber: sequence,
      method: event.method,
      paramsPreview,
      priority: event.priority,
      queueWaitMs: event.queueWaitMs,
      resultPreview: null,
      source: event.source,
      startedAtMs: event.startedAtMs,
      status: "pending",
      timeoutMs: event.timeoutMs,
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    requestRecorderRegistry.sync();
  }

  private finish(
    event: Extract<CodexRequestLifecycleEvent, { type: "completed" | "failed" | "timed-out" }>,
  ): void {
    const entry = this.entries.find((candidate) => candidate.id === event.id);
    if (!entry) return;
    const errorPreview = event.type === "completed" ? undefined : codexRequestPreview(event.error);
    const resultPreview =
      event.type === "completed" ? codexRequestPreview(event.result) : undefined;
    this.entries = this.entries.map((candidate) =>
      candidate === entry
        ? {
            ...candidate,
            durationMs: event.endedAtMs - entry.startedAtMs,
            endedAtMs: event.endedAtMs,
            errorPreview: errorPreview ?? candidate.errorPreview,
            resultPreview: resultPreview ?? candidate.resultPreview,
            status: event.type,
          }
        : candidate,
    );
    requestRecorderRegistry.sync();
  }

  clear(hostId: string): void {
    if (hostId !== this.hostId) return;
    this.entries = [];
    this.countsByKey.clear();
  }
}
