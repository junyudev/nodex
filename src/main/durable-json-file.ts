import { syncDirectory } from "./platform/node/filesystem-durability";
export { syncDirectory };
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function serializeDurableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeDurableJson(
  filePath: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  await writeDurableText(filePath, serializeDurableJson(value), maxBytes);
}

/** Replaces the file with the complete payload, or leaves its previous contents in place. */
export async function writeDurableText(
  filePath: string,
  payload: string,
  maxBytes: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if (Buffer.byteLength(payload, "utf8") > maxBytes) {
    throw new Error("Durable JSON payload exceeds its size limit");
  }
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    await syncDirectory(dirname(filePath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Keeps one file durable at the latest payload its owner offered, without blocking the owner.
 * Offers within `delayMs` of each other share one write, writes never overlap, so an older payload
 * cannot replace a newer one, and a failed write is retried with backoff until a later one lands.
 */
export class LatestDurableTextWriter {
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #delayMs: number;
  readonly #onError: (error: unknown) => void;
  #latest: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> | null = null;
  #retryDelayMs: number;

  constructor(options: {
    readonly filePath: string;
    readonly maxBytes: number;
    readonly delayMs: number;
    readonly onError: (error: unknown) => void;
  }) {
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes;
    this.#delayMs = options.delayMs;
    this.#onError = options.onError;
    this.#retryDelayMs = options.delayMs;
  }

  offer(payload: string): void {
    this.#latest = payload;
    this.#schedule(this.#delayMs);
  }

  /** Resolves once the latest offered payload is durable; rejects if writing it fails. */
  async flush(): Promise<void> {
    this.#cancelTimer();
    while (this.#writing !== null || this.#latest !== null) {
      try {
        await (this.#writing ?? this.#write());
      } finally {
        this.#cancelTimer();
      }
    }
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== null || this.#writing !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // The failure is reported, and its payload retried, by the write itself.
      this.#write().catch(() => {});
    }, delayMs);
    this.#timer.unref?.();
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #write(): Promise<void> {
    const payload = this.#latest;
    if (payload === null) return Promise.resolve();
    this.#latest = null;
    const writing = writeDurableText(this.#filePath, payload, this.#maxBytes).then(
      () => {
        this.#retryDelayMs = this.#delayMs;
      },
      (error: unknown) => {
        this.#latest ??= payload;
        this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        this.#onError(error);
        throw error;
      },
    );
    this.#writing = writing.finally(() => {
      this.#writing = null;
      if (this.#latest !== null) this.#schedule(this.#retryDelayMs);
    });
    return this.#writing;
  }
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
