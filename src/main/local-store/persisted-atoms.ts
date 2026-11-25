import { migrateAcpComposerChoices } from "../../shared/agent-runtime-composer-choice-migration";
import { syncDirectory } from "../platform/node/filesystem-durability";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
  PersistedAtomState,
  PersistedAtomUpdate,
} from "../../shared/ipc-api";

const PERSISTED_ATOMS_FILE_NAME = "persisted-atoms-v1.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersistedAtomsFile(atomsPath: string): PersistedAtomState {
  if (!existsSync(atomsPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(atomsPath, "utf8")) as unknown;
    return isRecord(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

async function writePersistedAtomsFile(atomsPath: string, contents: string): Promise<void> {
  const parent = dirname(atomsPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(parent, `.${basename(atomsPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, atomsPath);
    await syncDirectory(parent);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

interface DurabilityWaiter {
  readonly revision: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/**
 * Profile-local window state. A change takes effect and reaches every window as soon as it is
 * committed; the file is written behind it on the I/O thread pool. Changes that arrive while a
 * write is under way are saved together by the next one, so typing costs one write per disk
 * round trip instead of one per keystroke, and Main never waits for the disk.
 */
export class PersistedAtomStore {
  readonly #atomsPath: string;
  #stateCache: PersistedAtomState | null = null;
  #revision = 0;
  #durableRevision = 0;
  #writing: Promise<void> | null = null;
  #waiters: DurabilityWaiter[] = [];
  readonly #listeners = new Set<(event: PersistedAtomEvent) => void>();

  constructor(atomsPath: string) {
    const normalizedPath = atomsPath.trim();
    if (!normalizedPath) throw new Error("Persisted atom store path must not be empty");
    this.#atomsPath = normalizedPath;
  }

  readState(): PersistedAtomState {
    if (!this.#stateCache) {
      const stored = readPersistedAtomsFile(this.#atomsPath);
      this.#stateCache = migrateAcpComposerChoices(stored);
      if (this.#stateCache !== stored) {
        this.#revision += 1;
        this.#scheduleWrite();
      }
    }
    return { ...this.#stateCache };
  }

  readSnapshot(): PersistedAtomSnapshot {
    const values = this.readState();
    return { revision: this.#revision, values };
  }

  /** Committed mutations have one delivery source, including Main-owned writes. */
  subscribe(listener: (event: PersistedAtomEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(event: PersistedAtomEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Delivery failure cannot turn an already committed mutation into a storage failure.
      }
    }
  }

  commitMutation(
    mutation: PersistedAtomMutation,
    originRendererId: string | null,
  ): PersistedAtomEvent {
    const key = mutation.key.trim();
    const mutationId = mutation.mutationId.trim();
    if (!key) throw new Error("Persisted atom mutation key must not be empty");
    if (!mutationId) throw new Error("Persisted atom mutation id must not be empty");

    const next = this.readState();
    if (mutation.value === undefined) delete next[key];
    else next[key] = mutation.value;
    this.#stateCache = next;
    this.#revision += 1;
    const event: PersistedAtomEvent = {
      key,
      value: mutation.value,
      mutationId,
      revision: this.#revision,
      originRendererId,
    };
    this.#scheduleWrite();
    this.#publish(event);
    return event;
  }

  /** Deletes related atoms in one commit; each event retains the global revision order. */
  removeAtoms(
    keys: readonly string[],
    mutationId: string,
    originRendererId: string | null,
  ): readonly PersistedAtomEvent[] {
    const normalizedId = mutationId.trim();
    if (!normalizedId) throw new Error("Persisted atom mutation id must not be empty");
    const normalizedKeys = [...new Set(keys.map((key) => key.trim()))];
    if (normalizedKeys.some((key) => !key)) throw new Error("Persisted atom key must not be empty");
    const next = this.readState();
    const removed = normalizedKeys.filter((key) => Object.hasOwn(next, key));
    if (removed.length === 0) return [];
    for (const key of removed) delete next[key];
    this.#stateCache = next;
    const events = removed.map((key) => ({
      key,
      value: undefined,
      mutationId: normalizedId,
      revision: ++this.#revision,
      originRendererId,
    }));
    this.#scheduleWrite();
    for (const event of events) this.#publish(event);
    return events;
  }

  update(update: PersistedAtomUpdate): PersistedAtomState {
    const key = update.key.trim();
    if (!key) return this.readState();
    this.commitMutation(
      {
        key,
        value: update.value,
        mutationId: `main:${randomUUID()}`,
      },
      null,
    );
    return this.readState();
  }

  /**
   * Settles once the file holds every change up to `revision`. A failed write rejects the changes
   * it carried; they stay committed and the next change writes them again.
   */
  whenDurable(revision: number = this.#revision): Promise<void> {
    if (revision <= this.#durableRevision) return Promise.resolve();
    const durable = new Promise<void>((resolve, reject) => {
      this.#waiters.push({ revision, resolve, reject });
    });
    this.#scheduleWrite();
    return durable;
  }

  #scheduleWrite(): void {
    if (this.#writing) return;
    this.#writing = this.#writeBehind().then((decided) => {
      this.#writing = null;
      // A change committed after the last write was decided still needs a write of its own.
      if (this.#revision > decided) this.#scheduleWrite();
    });
  }

  /** Writes until the file is current or a write fails, and returns the last revision decided. */
  async #writeBehind(): Promise<number> {
    // Let the rest of this turn's messages commit first, so a burst shares one write.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      const revision = this.#revision;
      if (revision <= this.#durableRevision) return revision;
      try {
        await writePersistedAtomsFile(this.#atomsPath, JSON.stringify(this.#stateCache ?? {}));
        this.#durableRevision = revision;
        this.#settle(revision, null);
      } catch (cause) {
        this.#settle(revision, cause instanceof Error ? cause : new Error(String(cause)));
        // Only newer changes try again right away, so a failing disk is not retried in a loop.
        if (this.#revision === revision) return revision;
      }
    }
  }

  #settle(revision: number, error: Error | null): void {
    const settled = this.#waiters.filter((waiter) => waiter.revision <= revision);
    if (settled.length === 0) return;
    this.#waiters = this.#waiters.filter((waiter) => waiter.revision > revision);
    for (const waiter of settled) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}

export function makePersistedAtomStore(nodexHome: string): PersistedAtomStore {
  return new PersistedAtomStore(join(nodexHome, PERSISTED_ATOMS_FILE_NAME));
}
