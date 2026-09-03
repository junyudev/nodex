import { createHash } from "node:crypto";

export type RemoteHostedPipDiagnosticSource =
  | "browser-use"
  | "chrome-control"
  | "computer-use"
  | "host-layout"
  | "native-host";

export type RemoteHostedPipDurationBucket = "lt-1ms" | "lt-10ms" | "lt-100ms" | "lt-1s" | "gte-1s";

export interface RemoteHostedPipDiagnosticInput {
  readonly backend?: "cdp" | "chrome" | "iab";
  readonly browserFamily?: string;
  readonly durationMs?: number;
  readonly operation: string;
  readonly result: string;
  readonly revision: number;
  readonly source: RemoteHostedPipDiagnosticSource;
  readonly taskId?: string;
}

export interface RemoteHostedPipDiagnosticEntry {
  readonly backend?: "cdp" | "chrome" | "iab";
  readonly browserFamily?: string;
  readonly duration: RemoteHostedPipDurationBucket;
  readonly operation: string;
  readonly result: string;
  readonly revision: number;
  readonly sequence: number;
  readonly source: RemoteHostedPipDiagnosticSource;
  readonly taskHash?: string;
  readonly timestampMs: number;
}

const MAX_DIAGNOSTIC_TEXT_LENGTH = 96;

function boundedText(value: string): string {
  return value.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

export function bucketRemoteHostedPipDuration(durationMs = 0): RemoteHostedPipDurationBucket {
  if (durationMs < 1) return "lt-1ms";
  if (durationMs < 10) return "lt-10ms";
  if (durationMs < 100) return "lt-100ms";
  if (durationMs < 1_000) return "lt-1s";
  return "gte-1s";
}

export function hashRemoteHostedPipTaskId(taskId: string, salt: string): string {
  return createHash("sha256").update(salt).update("\0").update(taskId).digest("hex").slice(0, 16);
}

/** Bounded, content-free diagnostic evidence owned by the Main process. */
export class RemoteHostedPipDiagnostics {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #salt: string;
  readonly #entries: RemoteHostedPipDiagnosticEntry[] = [];
  #sequence = 0;

  constructor(options: {
    readonly salt: string;
    readonly capacity?: number;
    readonly now?: () => number;
  }) {
    this.#capacity = Math.max(1, Math.min(5_000, Math.floor(options.capacity ?? 500)));
    this.#now = options.now ?? Date.now;
    this.#salt = options.salt;
  }

  record(input: RemoteHostedPipDiagnosticInput): void {
    this.#sequence += 1;
    this.#entries.push({
      ...(input.backend ? { backend: input.backend } : {}),
      ...(input.browserFamily ? { browserFamily: boundedText(input.browserFamily) } : {}),
      duration: bucketRemoteHostedPipDuration(input.durationMs),
      operation: boundedText(input.operation),
      result: boundedText(input.result),
      revision: Math.max(0, Math.floor(input.revision)),
      sequence: this.#sequence,
      source: input.source,
      ...(input.taskId ? { taskHash: hashRemoteHostedPipTaskId(input.taskId, this.#salt) } : {}),
      timestampMs: Math.max(0, Math.floor(this.#now())),
    });
    if (this.#entries.length <= this.#capacity) return;
    this.#entries.splice(0, this.#entries.length - this.#capacity);
  }

  snapshot(): readonly RemoteHostedPipDiagnosticEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}
