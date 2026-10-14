import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  DictationMicrophoneLease,
  type DictationMicrophoneLeaseOwner,
  type MicrophoneLeaseOwner,
  type RealtimeVoiceMicrophoneLeaseOwner,
} from "./dictation-microphone-lease";

export interface SharedMicrophoneAuthority {
  readonly readOwner: () => MicrophoneLeaseOwner | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly acquireDictation: (
    owner: DictationMicrophoneLeaseOwner,
    relinquish: Effect.Effect<void>,
  ) => boolean;
  readonly acquireVoice: (owner: RealtimeVoiceMicrophoneLeaseOwner) => Effect.Effect<boolean>;
  readonly release: (webContentsId: number, sessionId: string) => boolean;
  readonly releaseOwner: (webContentsId: number) => boolean;
}

/** A Voice grant waits for the actual previous capture to release its Main lease. */
export const makeSharedMicrophoneAuthority: Effect.Effect<
  SharedMicrophoneAuthority,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const microphone = new DictationMicrophoneLease();
  const handoffs = yield* Semaphore.make(1);
  let accepting = true;
  let pendingVoice: RealtimeVoiceMicrophoneLeaseOwner | null = null;
  let dictation: {
    readonly owner: DictationMicrophoneLeaseOwner;
    readonly relinquish: Effect.Effect<void>;
    readonly released: Deferred.Deferred<void>;
  } | null = null;

  const settlePrevious = (webContentsId: number, sessionId: string): void => {
    if (dictation?.owner.webContentsId !== webContentsId || dictation.owner.sessionId !== sessionId)
      return;
    Deferred.doneUnsafe(dictation.released, Effect.void);
    dictation = null;
  };

  const release = (webContentsId: number, sessionId: string): boolean => {
    const pendingOwned =
      pendingVoice?.webContentsId === webContentsId && pendingVoice.sessionId === sessionId;
    if (pendingOwned) pendingVoice = null;
    if (!microphone.release(webContentsId, sessionId)) return pendingOwned;
    settlePrevious(webContentsId, sessionId);
    return true;
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      accepting = false;
      const owner = microphone.getOwner();
      if (owner) release(owner.webContentsId, owner.sessionId);
    }),
  );

  const acquireVoice = Effect.fn("SharedMicrophoneAuthority.acquireVoice")(function* (
    owner: RealtimeVoiceMicrophoneLeaseOwner,
  ) {
    if (!accepting) return false;
    const current = microphone.getOwner();
    if (current?.kind === "realtime-voice") return microphone.acquire(owner);
    const previous = dictation;
    pendingVoice = owner;
    return yield* Effect.gen(function* () {
      if (previous) {
        yield* previous.relinquish;
        yield* Deferred.await(previous.released);
      }
      if (!accepting || pendingVoice !== owner) return false;
      return microphone.acquire(owner);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (pendingVoice === owner) pendingVoice = null;
        }),
      ),
    );
  });

  return {
    readOwner: microphone.getOwner,
    subscribe: microphone.subscribe,
    acquireDictation: (owner, relinquish) => {
      if (!accepting || pendingVoice !== null) return false;
      if (!microphone.acquire(owner)) return false;
      if (dictation !== null) return true;
      dictation = { owner, relinquish, released: Deferred.makeUnsafe<void>() };
      return true;
    },
    acquireVoice: (owner) => handoffs.withPermit(acquireVoice(owner)),
    release,
    releaseOwner: (webContentsId) => {
      const pendingOwned = pendingVoice?.webContentsId === webContentsId;
      if (pendingOwned) pendingVoice = null;
      const owner = microphone.getOwner();
      if (!owner || owner.webContentsId !== webContentsId) return pendingOwned;
      return release(owner.webContentsId, owner.sessionId);
    },
  };
});
