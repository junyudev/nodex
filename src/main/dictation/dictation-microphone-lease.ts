import type { DictationSurface } from "../../shared/dictation";

interface MicrophoneLeaseIdentity {
  readonly webContentsId: number;
  readonly sessionId: string;
}

export interface DictationMicrophoneLeaseOwner extends MicrophoneLeaseIdentity {
  readonly kind: "dictation";
  readonly surface: DictationSurface;
}

export interface RealtimeVoiceMicrophoneLeaseOwner extends MicrophoneLeaseIdentity {
  readonly kind: "realtime-voice";
}

export type MicrophoneLeaseOwner =
  | DictationMicrophoneLeaseOwner
  | RealtimeVoiceMicrophoneLeaseOwner;

/** Main-owned, compare-and-release microphone authority shared by every renderer surface. */
export class DictationMicrophoneLease {
  readonly #listeners = new Set<() => void>();
  #owner: MicrophoneLeaseOwner | null = null;

  readonly getOwner = (): MicrophoneLeaseOwner | null => this.#owner;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  acquire(owner: MicrophoneLeaseOwner): boolean {
    const current = this.#owner;
    if (current) {
      return (
        current.kind === owner.kind &&
        current.webContentsId === owner.webContentsId &&
        current.sessionId === owner.sessionId
      );
    }
    this.#owner = owner;
    this.#publish();
    return true;
  }

  release(webContentsId: number, sessionId: string): boolean {
    const current = this.#owner;
    if (!current || current.webContentsId !== webContentsId || current.sessionId !== sessionId) {
      return false;
    }
    this.#owner = null;
    this.#publish();
    return true;
  }

  releaseOwner(webContentsId: number): boolean {
    if (this.#owner?.webContentsId !== webContentsId) return false;
    this.#owner = null;
    this.#publish();
    return true;
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
