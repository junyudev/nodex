import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  attachNodexClipboardEnvelope,
  decodeNodexClipboardEnvelope,
  isNodexStructuralClipboardWriteClaim,
  readNodexClipboardWriteClaim,
  type StructuralClipboardAwaitInput,
  type StructuralClipboardBeginInput,
  type StructuralClipboardLifecycleResult,
  type StructuralClipboardResolution,
  type StructuralClipboardSettleInput,
  type StructuralClipboardWriteInput,
  type StructuralClipboardWriteResult,
} from "../../shared/clipboard-paste";
import { ElectronClipboard } from "../platform/electron/ElectronClipboard";
import { RendererClientRuntime } from "./RendererClientRuntime";

export const STRUCTURAL_CLIPBOARD_REGISTRATION_GRACE_MS = 1_000;
export const STRUCTURAL_CLIPBOARD_SESSION_TIMEOUT_MS = 15_000;
export const STRUCTURAL_CLIPBOARD_COMPLETION_RETENTION_MS = 30_000;
const STRUCTURAL_CLIPBOARD_ACTIVE_ENTRY_LIMIT = 32;
const STRUCTURAL_CLIPBOARD_RECENT_COMPLETION_LIMIT = 16;

interface StructuralClipboardEntry {
  readonly writeClaim: string;
  readonly createdAt: number;
  readonly resolution: Deferred.Deferred<StructuralClipboardResolution>;
  actionHint: "copy" | "cut" | null;
  libraryId: string | null;
  storeEpoch: string | null;
  sourceClientId: string | null;
  state: "unregistered" | "preparing" | "awaiting_source_commit" | "settled";
  envelope: StructuralClipboardWriteInput["envelope"] | null;
  completedAt: number | null;
  finalResolution: StructuralClipboardResolution | null;
  waiterCount: number;
}

function writeFinalPresentation(
  clipboard: ElectronClipboard["Service"],
  input: StructuralClipboardWriteInput,
): boolean {
  try {
    clipboard.writePresentation({
      html: attachNodexClipboardEnvelope(input.html, input.envelope, input.writeClaim),
      text: input.text,
    });
    return true;
  } catch {
    return false;
  }
}

function verifyFinalPresentation(
  clipboard: ElectronClipboard["Service"],
  input: StructuralClipboardWriteInput,
): boolean {
  try {
    const readbackHtml = clipboard.readHtml();
    return (
      decodeNodexClipboardEnvelope(readbackHtml)?.capability === input.envelope.capability &&
      readNodexClipboardWriteClaim(readbackHtml) === input.writeClaim &&
      clipboard.readText() === input.text
    );
  } catch {
    return false;
  }
}

export class StructuralClipboardRuntime extends Context.Service<
  StructuralClipboardRuntime,
  {
    readonly begin: (
      input: StructuralClipboardBeginInput,
      sourceClientId: string,
    ) => Effect.Effect<StructuralClipboardLifecycleResult>;
    readonly publish: (
      input: StructuralClipboardWriteInput,
      sourceClientId: string,
    ) => Effect.Effect<StructuralClipboardWriteResult>;
    readonly settle: (
      input: StructuralClipboardSettleInput,
      sourceClientId: string,
    ) => Effect.Effect<StructuralClipboardLifecycleResult>;
    readonly awaitResolution: (
      input: StructuralClipboardAwaitInput,
    ) => Effect.Effect<StructuralClipboardResolution>;
  }
>()("nodex/main/host-runtime/StructuralClipboardRuntime") {}

const ok = (): StructuralClipboardLifecycleResult => ({ ok: true });
const rejected = (
  failure: Exclude<StructuralClipboardLifecycleResult, { readonly ok: true }>["failure"],
): StructuralClipboardLifecycleResult => ({ ok: false, failure });

export const live: Layer.Layer<
  StructuralClipboardRuntime,
  never,
  ElectronClipboard | RendererClientRuntime
> = Layer.effect(
  StructuralClipboardRuntime,
  Effect.gen(function* () {
    const clipboard = yield* ElectronClipboard;
    const rendererClients = yield* RendererClientRuntime;
    const callbacks = yield* FiberSet.makeRuntime<never, void, never>();
    const entries = new Map<string, StructuralClipboardEntry>();
    let closed = false;

    const trimCompleted = (now: number): void => {
      const completed = [...entries.values()]
        .filter((entry) => entry.completedAt !== null)
        .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
      while (completed.length > 0) {
        const entry = completed[0]!;
        const expired =
          now - (entry.completedAt ?? now) >= STRUCTURAL_CLIPBOARD_COMPLETION_RETENTION_MS;
        if (completed.length <= STRUCTURAL_CLIPBOARD_RECENT_COMPLETION_LIMIT && !expired) break;
        if (entries.get(entry.writeClaim) === entry) entries.delete(entry.writeClaim);
        completed.shift();
      }
    };

    const complete = Effect.fn("StructuralClipboardRuntime.complete")(function* (
      entry: StructuralClipboardEntry,
      resolution: StructuralClipboardResolution,
    ) {
      if (entry.completedAt !== null) return;
      entry.state = "settled";
      entry.completedAt = yield* Clock.currentTimeMillis;
      entry.finalResolution = resolution;
      yield* Deferred.succeed(entry.resolution, resolution);
      trimCompleted(entry.completedAt);
      callbacks(
        Effect.sleep(STRUCTURAL_CLIPBOARD_COMPLETION_RETENTION_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (entries.get(entry.writeClaim) === entry) entries.delete(entry.writeClaim);
            }),
          ),
        ),
      );
    });

    const makeEntry = Effect.fn("StructuralClipboardRuntime.makeEntry")(function* (
      writeClaim: string,
    ) {
      const entry: StructuralClipboardEntry = {
        writeClaim,
        createdAt: yield* Clock.currentTimeMillis,
        resolution: yield* Deferred.make<StructuralClipboardResolution>(),
        actionHint: null,
        libraryId: null,
        storeEpoch: null,
        sourceClientId: null,
        state: "unregistered",
        envelope: null,
        completedAt: null,
        finalResolution: null,
        waiterCount: 0,
      };
      entries.set(writeClaim, entry);
      callbacks(
        Effect.sleep(STRUCTURAL_CLIPBOARD_REGISTRATION_GRACE_MS).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              entry.state === "unregistered"
                ? complete(entry, { kind: "portable_fallback", reason: "timeout" })
                : Effect.void,
            ),
          ),
        ),
      );
      callbacks(
        Effect.sleep(STRUCTURAL_CLIPBOARD_SESSION_TIMEOUT_MS).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              entry.state === "awaiting_source_commit"
                ? Effect.void
                : complete(entry, { kind: "portable_fallback", reason: "timeout" }),
            ),
          ),
        ),
      );
      return entry;
    });

    const getOrMakeEntry = Effect.fn("StructuralClipboardRuntime.getOrMakeEntry")(function* (
      writeClaim: string,
    ) {
      return entries.get(writeClaim) ?? (yield* makeEntry(writeClaim));
    });

    const begin = Effect.fn("StructuralClipboardRuntime.begin")(function* (
      input: StructuralClipboardBeginInput,
      sourceClientId: string,
    ) {
      if (closed) return rejected("closed");
      if (
        !input ||
        !isNodexStructuralClipboardWriteClaim(input.writeClaim) ||
        (input.actionHint !== "copy" && input.actionHint !== "cut") ||
        typeof input.storeEpoch !== "string" ||
        input.storeEpoch.length === 0 ||
        typeof sourceClientId !== "string" ||
        sourceClientId.length === 0
      ) {
        return rejected("invalid");
      }
      const activeCount = [...entries.values()].filter(
        (entry) => entry.completedAt === null,
      ).length;
      if (
        !entries.has(input.writeClaim) &&
        activeCount >= STRUCTURAL_CLIPBOARD_ACTIVE_ENTRY_LIMIT
      ) {
        return rejected("capacity");
      }
      const entry = yield* getOrMakeEntry(input.writeClaim);
      if (entry.completedAt !== null) return rejected("superseded");
      if (
        entry.actionHint !== null &&
        (entry.actionHint !== input.actionHint ||
          entry.libraryId !== (input.libraryId ?? null) ||
          entry.storeEpoch !== input.storeEpoch ||
          entry.sourceClientId !== sourceClientId)
      ) {
        return rejected("conflict");
      }
      if (entry.actionHint !== null) return ok();

      entry.actionHint = input.actionHint;
      entry.libraryId = input.libraryId ?? null;
      entry.storeEpoch = input.storeEpoch;
      entry.sourceClientId = sourceClientId;
      entry.state = "preparing";
      return ok();
    });

    const publish = Effect.fn("StructuralClipboardRuntime.publish")(function* (
      input: StructuralClipboardWriteInput,
      sourceClientId: string,
    ) {
      if (closed) return { ok: false, failure: "write_failed" } as const;
      const entry = entries.get(input?.writeClaim);
      if (!entry || entry.sourceClientId !== sourceClientId) {
        return { ok: false, failure: "superseded" } as const;
      }
      if (entry.completedAt !== null) {
        return entry.finalResolution?.kind === "ready"
          ? ({ ok: true } as const)
          : ({ ok: false, failure: "superseded" } as const);
      }
      if (
        entry.actionHint !== input.envelope?.actionHint ||
        entry.storeEpoch !== input.envelope?.storeEpoch ||
        (entry.libraryId !== null && entry.libraryId !== input.envelope?.libraryId)
      ) {
        return { ok: false, failure: "superseded" } as const;
      }
      if (entry.envelope) {
        return entry.envelope.capability === input.envelope.capability
          ? ({ ok: true } as const)
          : ({ ok: false, failure: "superseded" } as const);
      }
      if (clipboard.readStructuralWriteClaim() !== input.writeClaim) {
        yield* complete(entry, { kind: "portable_fallback", reason: "superseded" });
        return { ok: false, failure: "superseded" } as const;
      }
      for (const otherEntry of entries.values()) {
        if (otherEntry.writeClaim === input.writeClaim || otherEntry.completedAt !== null) continue;
        yield* complete(otherEntry, { kind: "portable_fallback", reason: "superseded" });
      }
      if (!writeFinalPresentation(clipboard, input)) {
        yield* complete(entry, { kind: "portable_fallback", reason: "clipboard_failed" });
        return { ok: false, failure: "write_failed" } as const;
      }
      if (!verifyFinalPresentation(clipboard, input)) {
        yield* complete(entry, { kind: "portable_fallback", reason: "clipboard_failed" });
        return { ok: false, failure: "readback_mismatch" } as const;
      }

      entry.envelope = input.envelope;
      if (entry.actionHint === "cut") {
        entry.state = "awaiting_source_commit";
        return { ok: true } as const;
      }
      yield* complete(entry, {
        kind: "ready",
        envelope: input.envelope,
        disposition: "structural",
      });
      return { ok: true } as const;
    });

    const settle = Effect.fn("StructuralClipboardRuntime.settle")(function* (
      input: StructuralClipboardSettleInput,
      sourceClientId: string,
    ) {
      if (closed) return rejected("closed");
      const entry = entries.get(input?.writeClaim);
      if (!entry) return rejected("superseded");
      if (entry.sourceClientId !== sourceClientId) return rejected("conflict");
      if (entry.completedAt !== null) {
        if (input.outcome === "failed") {
          return entry.finalResolution?.kind === "portable_fallback" ? ok() : rejected("conflict");
        }
        const disposition = input.outcome === "cut_committed" ? "structural" : "copy_fallback";
        return entry.finalResolution?.kind === "ready" &&
          entry.finalResolution.disposition === disposition
          ? ok()
          : rejected("conflict");
      }
      if (input.outcome === "failed") {
        yield* complete(entry, { kind: "portable_fallback", reason: input.reason });
        return ok();
      }
      if (
        entry.actionHint !== "cut" ||
        entry.state !== "awaiting_source_commit" ||
        !entry.envelope
      ) {
        return rejected("conflict");
      }
      yield* complete(entry, {
        kind: "ready",
        envelope: entry.envelope,
        disposition: input.outcome === "cut_committed" ? "structural" : "copy_fallback",
      });
      return ok();
    });

    const awaitResolution = Effect.fn("StructuralClipboardRuntime.awaitResolution")(function* (
      input: StructuralClipboardAwaitInput,
    ) {
      if (closed || !input || !isNodexStructuralClipboardWriteClaim(input.writeClaim)) {
        return { kind: "portable_fallback", reason: "timeout" } as const;
      }
      const activeCount = [...entries.values()].filter(
        (entry) => entry.completedAt === null,
      ).length;
      if (
        !entries.has(input.writeClaim) &&
        activeCount >= STRUCTURAL_CLIPBOARD_ACTIVE_ENTRY_LIMIT
      ) {
        return { kind: "portable_fallback", reason: "timeout" } as const;
      }
      const entry = yield* getOrMakeEntry(input.writeClaim);
      entry.waiterCount += 1;
      return yield* Deferred.await(entry.resolution).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.waiterCount = Math.max(0, entry.waiterCount - 1);
          }),
        ),
      );
    });

    yield* rendererClients.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind !== "disposed") return Effect.void;
        return Effect.forEach(
          [...entries.values()].filter(
            (entry) => entry.completedAt === null && entry.sourceClientId === event.clientId,
          ),
          (entry) => complete(entry, { kind: "portable_fallback", reason: "source_closed" }),
          { discard: true },
        );
      }),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        for (const entry of entries.values()) {
          if (entry.completedAt === null) {
            yield* complete(entry, { kind: "portable_fallback", reason: "source_closed" });
          }
        }
        entries.clear();
      }),
    );

    return StructuralClipboardRuntime.of({ begin, publish, settle, awaitResolution });
  }),
);
