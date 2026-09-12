import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { CodexApplicationProtocolOccurrence } from "../codex-runtime/CodexApplicationRequestInbox";
import { compactCodexApplicationProtocolOccurrences } from "./CodexConversationEventProjection";
type Occurrence = CodexApplicationProtocolOccurrence;
interface Delivery {
  occurrence: Occurrence;
  replay(occurrence: Occurrence): Effect.Effect<boolean>;
  reject(occurrence: Occurrence, reason: unknown): Effect.Effect<void>;
}
/** Native resume admission is below application tools; delivery remains owned by protocol ingress. */
export class CodexResumeIngress extends Context.Service<
  CodexResumeIngress,
  {
    begin(threadId: string, identity?: { hostId: string; generation: number }): boolean;
    has(threadId: string): boolean;
    offer(threadId: string, delivery: Delivery): boolean;
    release(
      threadId: string,
      canonicalState: CodexCanonicalConversationState | null,
    ): Effect.Effect<boolean>;
    discard(threadId: string, reason: unknown): Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexResumeIngress") {}
export const make = Effect.gen(function* () {
  const buffers = new Map<string, Delivery[]>();
  const identities = new Map<string, { hostId: string; generation: number }>();
  const discard = (threadId: string, reason: unknown) =>
    Effect.suspend(() => {
      const deliveries = buffers.get(threadId);
      buffers.delete(threadId);
      identities.delete(threadId);
      return Effect.forEach(
        deliveries ?? [],
        (delivery) => delivery.reject(delivery.occurrence, reason),
        { discard: true },
      );
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...buffers.keys()], (id) => discard(id, new Error("Resume ingress closed")), {
      discard: true,
    }),
  );
  return CodexResumeIngress.of({
    begin: (threadId, identity) => {
      if (buffers.has(threadId)) return false;
      buffers.set(threadId, []);
      if (identity) identities.set(threadId, identity);
      return true;
    },
    has: (threadId) => buffers.has(threadId),
    offer: (threadId, delivery) => {
      const buffer = buffers.get(threadId);
      const identity = identities.get(threadId);
      if (
        !buffer ||
        (identity &&
          (identity.hostId !== delivery.occurrence.hostId ||
            identity.generation !== delivery.occurrence.generation))
      )
        return false;
      buffer.push(delivery);
      return true;
    },
    release: (threadId, canonicalState) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const deliveries = buffers.get(threadId) ?? [];
          buffers.delete(threadId);
          identities.delete(threadId);
          return new Map(
            deliveries.map((delivery) => [delivery.occurrence.occurrenceToken, delivery]),
          );
        }),
        (pending) =>
          Effect.gen(function* () {
            const events = compactCodexApplicationProtocolOccurrences({
              threadId,
              canonicalState,
              events: [...pending.values()].map((delivery) => delivery.occurrence),
            });
            let retire = false;
            for (const event of events) {
              const delivery = pending.get(event.occurrenceToken);
              if (!delivery) continue;
              retire = (yield* delivery.replay(event)) || retire;
              pending.delete(event.occurrenceToken);
            }
            return retire;
          }),
        // Replay owns its detached batch until every occurrence has settled.
        // A successor may already have installed another buffer for this Thread.
        (pending, exit) =>
          exit._tag === "Failure"
            ? Effect.forEach(
                pending.values(),
                (delivery) => delivery.reject(delivery.occurrence, exit.cause),
                { discard: true },
              )
            : Effect.void,
      ),
    discard,
  });
});
export const layer = Layer.effect(CodexResumeIngress, make);
