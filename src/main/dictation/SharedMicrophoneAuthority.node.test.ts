import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { makeSharedMicrophoneAuthority } from "./SharedMicrophoneAuthority";

const dictation = (sessionId = "dictation", webContentsId = 1) => ({
  kind: "dictation" as const,
  surface: "composer" as const,
  sessionId,
  webContentsId,
});
const voice = (sessionId = "voice", webContentsId = 2) => ({
  kind: "realtime-voice" as const,
  sessionId,
  webContentsId,
});

it.effect("waits for the actual Dictation release before granting Voice", () =>
  Effect.gen(function* () {
    const authority = yield* makeSharedMicrophoneAuthority;
    const requested = yield* Deferred.make<void>();
    assert.isTrue(
      authority.acquireDictation(
        dictation(),
        Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
      ),
    );
    const acquiring = yield* authority.acquireVoice(voice()).pipe(Effect.forkChild);
    yield* Deferred.await(requested);
    assert.deepEqual(authority.readOwner(), dictation());
    assert.isFalse(authority.acquireDictation(dictation("other"), Effect.void));
    assert.isFalse(authority.release(1, "foreign"));
    assert.isTrue(authority.release(1, "dictation"));
    assert.isTrue(yield* Fiber.join(acquiring));
    assert.deepEqual(authority.readOwner(), voice());
  }).pipe(Effect.scoped),
);

it.effect("keeps Voice exclusive and rejects a foreign or cross-kind idempotent grant", () =>
  Effect.gen(function* () {
    const authority = yield* makeSharedMicrophoneAuthority;
    assert.isTrue(yield* authority.acquireVoice(voice()));
    assert.isTrue(yield* authority.acquireVoice(voice()));
    assert.isFalse(yield* authority.acquireVoice(voice("another")));
    assert.isFalse(authority.acquireDictation(dictation("voice", 2), Effect.void));
    assert.isFalse(authority.release(1, "voice"));
    assert.deepEqual(authority.readOwner(), voice());
  }).pipe(Effect.scoped),
);

it.effect("cancels a pending handoff without granting or revoking the predecessor", () =>
  Effect.gen(function* () {
    const authority = yield* makeSharedMicrophoneAuthority;
    const requested = yield* Deferred.make<void>();
    authority.acquireDictation(
      dictation(),
      Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    );
    const acquiring = yield* authority.acquireVoice(voice()).pipe(Effect.forkChild);
    yield* Deferred.await(requested);
    yield* Fiber.interrupt(acquiring);
    assert.deepEqual(authority.readOwner(), dictation());
    assert.isTrue(authority.acquireDictation(dictation(), Effect.void));
    assert.isTrue(authority.release(1, "dictation"));
    assert.isTrue(yield* authority.acquireVoice(voice("later")));
  }).pipe(Effect.scoped),
);

it.effect(
  "lets a crashed predecessor settle the handoff without letting late release clear Voice",
  () =>
    Effect.gen(function* () {
      const authority = yield* makeSharedMicrophoneAuthority;
      const requested = yield* Deferred.make<void>();
      authority.acquireDictation(
        dictation(),
        Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
      );
      const acquiring = yield* authority.acquireVoice(voice()).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      assert.isTrue(authority.releaseOwner(1));
      assert.isTrue(yield* Fiber.join(acquiring));
      assert.isFalse(authority.release(1, "dictation"));
      assert.isFalse(authority.releaseOwner(1));
      assert.deepEqual(authority.readOwner(), voice());
    }).pipe(Effect.scoped),
);

it.effect("a waiting Voice request cannot revive a closed Profile audio authority", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const authority = yield* makeSharedMicrophoneAuthority.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const requested = yield* Deferred.make<void>();
    authority.acquireDictation(
      dictation(),
      Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    );
    const acquiring = yield* authority.acquireVoice(voice()).pipe(Effect.forkChild);
    yield* Deferred.await(requested);
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(yield* Fiber.join(acquiring));
    assert.isNull(authority.readOwner());
    assert.isFalse(authority.acquireDictation(dictation(), Effect.void));
    assert.isFalse(yield* authority.acquireVoice(voice()));
  }).pipe(Effect.scoped),
);

it.effect(
  "a retired Voice window cannot acquire the microphone after a delayed Dictation release",
  () =>
    Effect.gen(function* () {
      const authority = yield* makeSharedMicrophoneAuthority;
      const requested = yield* Deferred.make<void>();
      authority.acquireDictation(
        dictation(),
        Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
      );
      const acquiring = yield* authority.acquireVoice(voice()).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      assert.isTrue(authority.releaseOwner(2));
      authority.release(1, "dictation");
      assert.isFalse(yield* Fiber.join(acquiring));
      assert.isNull(authority.readOwner());
    }).pipe(Effect.scoped),
);
