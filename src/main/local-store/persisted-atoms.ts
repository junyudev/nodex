import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function writePersistedAtomsFile(atomsPath: string, state: PersistedAtomState): void {
  const parent = dirname(atomsPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(parent, `.${basename(atomsPath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(handle, JSON.stringify(state, null, 2), "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  try {
    renameSync(temporaryPath, atomsPath);
    const directory = openSync(parent, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export class PersistedAtomStore {
  readonly #atomsPath: string;
  #stateCache: PersistedAtomState | null = null;
  #revision = 0;
  readonly #listeners = new Set<(event: PersistedAtomEvent) => void>();

  constructor(atomsPath: string) {
    const normalizedPath = atomsPath.trim();
    if (!normalizedPath) throw new Error("Persisted atom store path must not be empty");
    this.#atomsPath = normalizedPath;
  }

  readState(): PersistedAtomState {
    this.#stateCache ??= readPersistedAtomsFile(this.#atomsPath);
    return { ...this.#stateCache };
  }

  readSnapshot(): PersistedAtomSnapshot {
    return {
      revision: this.#revision,
      values: this.readState(),
    };
  }

  /** Successful durable mutations have one delivery source, including Main-owned writes. */
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
    writePersistedAtomsFile(this.#atomsPath, next);
    this.#stateCache = next;
    this.#revision += 1;
    const event: PersistedAtomEvent = {
      key,
      value: mutation.value,
      mutationId,
      revision: this.#revision,
      originRendererId,
    };
    this.#publish(event);
    return event;
  }

  /** Deletes related atoms in one durable write; each event retains the global revision order. */
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
    writePersistedAtomsFile(this.#atomsPath, next);
    this.#stateCache = next;
    const events = removed.map((key) => ({
      key,
      value: undefined,
      mutationId: normalizedId,
      revision: ++this.#revision,
      originRendererId,
    }));
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
}

export function makePersistedAtomStore(nodexHome: string): PersistedAtomStore {
  return new PersistedAtomStore(join(nodexHome, PERSISTED_ATOMS_FILE_NAME));
}
