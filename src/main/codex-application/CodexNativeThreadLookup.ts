import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CodexGateway, type CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";

export class CodexNativeThreadLookupError extends Data.TaggedError("CodexNativeThreadLookupError")<{
  readonly threadId: string;
  readonly cause: unknown;
}> {}
export interface NativeThreadMatch {
  readonly hostId: string;
  readonly manager: MainConversationManager;
  readonly thread: Thread;
}
export class CodexNativeThreadLookup extends Context.Service<
  CodexNativeThreadLookup,
  {
    readonly resolve: (
      threadId: string,
      preferredHostId?: string,
      options?: CodexGatewayRequestOptions,
    ) => Effect.Effect<NativeThreadMatch, CodexNativeThreadLookupError>;
  }
>()("nodex/main/codex-application/CodexNativeThreadLookup") {}

/** Native tasks can exist before a durable workspace entry. Ambiguous host matches stay explicit. */
export const make = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const managers = yield* CodexMainConversationManagers;
  const hosts = yield* ExecutionHostRuntime;
  return CodexNativeThreadLookup.of({
    resolve: (threadId, preferredHostId, options) =>
      Effect.gen(function* () {
        const hostIds = [
          gateway.localHostId,
          ...(yield* SubscriptionRef.get(hosts.activeSshHosts)).keys(),
        ];
        const probe = (hostId: string) =>
          Effect.gen(function* () {
            const manager = yield* managers.get(hostId);
            const response = yield* gateway.requestOnHost(
              hostId,
              "thread/read",
              { threadId, includeTurns: false },
              { ...options, expectedHostId: hostId, expectedGeneration: manager.generation },
            );
            yield* Effect.try({
              try: manager.assertCurrent,
              catch: (cause) => new CodexNativeThreadLookupError({ threadId, cause }),
            });
            return { hostId, manager, thread: response.thread as unknown as Thread };
          }).pipe(Effect.catch(() => Effect.succeed(null)));
        const failedHosts: string[] = [];
        if (preferredHostId !== undefined && hostIds.includes(preferredHostId)) {
          const preferred = yield* probe(preferredHostId);
          if (preferred) return preferred;
          failedHosts.push(preferredHostId);
        }
        const results = yield* Effect.forEach(
          hostIds.filter((hostId) => !failedHosts.includes(hostId)),
          (hostId) => probe(hostId).pipe(Effect.map((match) => ({ hostId, match }))),
          { concurrency: "unbounded" },
        );
        failedHosts.push(
          ...results.filter((result) => result.match === null).map((result) => result.hostId),
        );
        const matches = results.flatMap((result) => (result.match === null ? [] : [result.match]));
        if (matches.length === 1) return matches[0]!;
        const message = matches.length
          ? `Ambiguous Codex thread id ${threadId}; matching hosts: ${matches.map((match) => match.hostId).join(", ")}`
          : `No Codex thread found for threadId: ${threadId}${failedHosts.length ? `. Hosts without a readable match: ${failedHosts.join(", ")}` : ""}`;
        return yield* new CodexNativeThreadLookupError({ threadId, cause: new Error(message) });
      }),
  });
});
