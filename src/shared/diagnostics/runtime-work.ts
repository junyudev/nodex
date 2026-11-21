/**
 * Runtime conversation work, counted at each process boundary for one opaque piece of work: a
 * navigation, or a stream batch carried by its observation. Tallies hold counts, bytes and rows
 * only; nothing here retains content, titles, identities or text.
 */
export interface RuntimeWorkTally {
  readonly count: number;
  readonly bytes: number;
  readonly rows: number;
}

/** One work's tallies by boundary metric. */
export type RuntimeWorkReading = Readonly<Record<string, RuntimeWorkTally>>;

/**
 * Where the work happened. Suffixes are closed protocol names (methods, event and item types,
 * Core read kinds, renderer operations), never values a person typed.
 */
export type RuntimeWorkMetric =
  /** Main → Core reads, by read kind. */
  | `core.read:${string}`
  /** Main → Runtime requests, by method; bytes are the JSONL frame. */
  | `runtime.request:${string}`
  /** Runtime → Main replies, by method; bytes are the JSONL frame, rows the projected rows. */
  | `runtime.reply:${string}`
  /**
   * Runtime → Main observation frames, by event type (and item type) or `item-patch` for a
   * transcript's live item update; bytes are the JSONL frame.
   */
  | `runtime.event:${string}`
  /** Main → renderer deliveries for one subscription; bytes approximate the cloned payload. */
  | `renderer.delivery:${string}`
  /** Renderer → Main requests, by Session operation. */
  | `renderer.request:${string}`
  /** Snapshots installed into the transcript projection; rows are the installed items. */
  | "renderer.install"
  /** Observation events the renderer applied, by event type. */
  | `renderer.event:${string}`
  /** Subscribed transcript leaves (items) notified of a changed value. */
  | "renderer.leaf"
  /** Subscribed Turns notified of changed details or slots. */
  | "renderer.turn"
  /** Transcript structure notifications. */
  | "renderer.structure"
  /** React commits of a transcript. */
  | "renderer.commit";

export interface RuntimeWorkLedger {
  record(work: string, metric: RuntimeWorkMetric, bytes?: number, rows?: number): void;
  read(work: string): RuntimeWorkReading;
  works(): readonly string[];
  /** Reports and forgets every open work. */
  flush(): void;
}

export interface RuntimeWorkLedgerOptions {
  /** Open works beyond this are reported and forgotten oldest first. */
  readonly capacity?: number;
  /**
   * A work quiet for this long is reported once and forgotten, so each report is one navigation
   * or one stream batch. Without it, tallies accumulate until read or flushed.
   */
  readonly settleMs?: number;
  readonly onSettled?: (work: string, reading: RuntimeWorkReading) => void;
}

const DEFAULT_CAPACITY = 128;

interface OpenWork {
  readonly tallies: Map<string, { count: number; bytes: number; rows: number }>;
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRuntimeWorkLedger(options: RuntimeWorkLedgerOptions = {}): RuntimeWorkLedger {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const open = new Map<string, OpenWork>();
  const snapshot = (entry: OpenWork | undefined): RuntimeWorkReading =>
    entry
      ? Object.fromEntries(
          [...entry.tallies].map(([metric, tally]) => [metric, { ...tally }] as const),
        )
      : {};
  const settle = (work: string) => {
    const entry = open.get(work);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    open.delete(work);
    options.onSettled?.(work, snapshot(entry));
  };
  // One timer per open work; recording only moves its quiet point forward.
  const arm = (work: string, entry: OpenWork, settleMs: number, delay: number) => {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const remaining = entry.lastAt + settleMs - Date.now();
      if (remaining > 0) arm(work, entry, settleMs, remaining);
      else settle(work);
    }, delay);
  };
  return {
    record(work, metric, bytes = 0, rows = 0) {
      let entry = open.get(work);
      if (!entry) {
        if (open.size >= capacity) settle(open.keys().next().value!);
        entry = { tallies: new Map(), lastAt: 0, timer: null };
        open.set(work, entry);
      }
      const tally = entry.tallies.get(metric);
      if (tally) {
        tally.count += 1;
        tally.bytes += bytes;
        tally.rows += rows;
      } else entry.tallies.set(metric, { count: 1, bytes, rows });
      if (options.settleMs === undefined) return;
      entry.lastAt = Date.now();
      if (entry.timer === null) arm(work, entry, options.settleMs, options.settleMs);
    },
    read: (work) => snapshot(open.get(work)),
    works: () => [...open.keys()],
    flush() {
      for (const work of [...open.keys()]) settle(work);
    },
  };
}

/** The sum of every tally whose metric starts with `prefix`. */
export function runtimeWorkTotal(reading: RuntimeWorkReading, prefix: string): RuntimeWorkTally {
  let count = 0;
  let bytes = 0;
  let rows = 0;
  for (const [metric, tally] of Object.entries(reading)) {
    if (!metric.startsWith(prefix)) continue;
    count += tally.count;
    bytes += tally.bytes;
    rows += tally.rows;
  }
  return { count, bytes, rows };
}

/** Readings of several works, metric by metric, as one. */
export function mergeRuntimeWork(readings: readonly RuntimeWorkReading[]): RuntimeWorkReading {
  const merged: Record<string, RuntimeWorkTally> = {};
  for (const reading of readings)
    for (const [metric, tally] of Object.entries(reading)) {
      const current = merged[metric];
      merged[metric] = current
        ? {
            count: current.count + tally.count,
            bytes: current.bytes + tally.bytes,
            rows: current.rows + tally.rows,
          }
        : tally;
    }
  return merged;
}

/** What one Runtime → Main frame is, as far as work counting needs to know. */
export type RuntimeFrameWork =
  | {
      readonly kind: "reply";
      readonly id: string;
      readonly success: boolean;
      /** Rows a transcript read projected: snapshot rows or history page items. */
      readonly rows: number;
      /** Present on an admitted observation. */
      readonly subscriptionId?: string;
    }
  | {
      readonly kind: "event";
      readonly subscriptionId: string;
      readonly metric: RuntimeWorkMetric;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const projectedRows = (output: unknown): number => {
  if (!isRecord(output)) return 0;
  const projection = output.projection;
  if (isRecord(projection) && Array.isArray(projection.visibleTurnItems))
    return projection.visibleTurnItems.length;
  return Array.isArray(output.items) ? output.items.length : 0;
};

/** Reads only protocol discriminators; payload bodies are never inspected or kept. */
export function classifyRuntimeFrame(frame: unknown): RuntimeFrameWork | null {
  if (!isRecord(frame)) return null;
  if (typeof frame.id === "string" && typeof frame.success === "boolean") {
    const output = frame.success ? frame.output : undefined;
    const subscriptionId =
      isRecord(output) && output.subscribed === true && typeof output.subscriptionId === "string"
        ? output.subscriptionId
        : undefined;
    return {
      kind: "reply",
      id: frame.id,
      success: frame.success,
      rows: projectedRows(output),
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
    };
  }
  if (typeof frame.subscriptionId !== "string") return null;
  if (frame.type === "event.error")
    return { kind: "event", subscriptionId: frame.subscriptionId, metric: "runtime.event:error" };
  // A transcript's live item arrives as a patch against the version it already holds.
  if (frame.type === "event.item-patch")
    return {
      kind: "event",
      subscriptionId: frame.subscriptionId,
      metric: "runtime.event:item-patch",
    };
  if (frame.type !== "event" || !isRecord(frame.event) || !isRecord(frame.event.event)) return null;
  const event = frame.event.event;
  const type = typeof event.type === "string" ? event.type : "unknown";
  const itemType =
    type === "turn-item.updated" &&
    isRecord(event.payload) &&
    typeof event.payload.type === "string"
      ? `:${event.payload.type}`
      : "";
  return {
    kind: "event",
    subscriptionId: frame.subscriptionId,
    metric: `runtime.event:${type}${itemType}`,
  };
}

/** Opaque correlation a window attaches to its Runtime reads; it carries no content. */
export const RUNTIME_WORK_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
