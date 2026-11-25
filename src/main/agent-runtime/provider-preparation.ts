import * as Effect from "effect/Effect";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";

type ProviderDeclaration = AgentRuntimeConfiguration["providers"][string];

const DETAIL_MAX_LENGTH = 300;

const failureDetail = (cause: unknown) => {
  const text = cause instanceof Error ? cause.message : String(cause);
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > DETAIL_MAX_LENGTH ? `${line.slice(0, DETAIL_MAX_LENGTH - 1)}…` : line;
};

/**
 * Prepares one Agent for execution. An Agent Nodex cannot prepare, such as one whose saved
 * secrets cannot be read or whose folder cannot be created, is declared unavailable with the
 * reason, so every other Agent still starts.
 */
export const preparedProvider = <E, R>(
  instanceId: string,
  identity: Pick<ProviderDeclaration, "driver" | "displayName" | "source">,
  prepare: Effect.Effect<ProviderDeclaration, E, R>,
): Effect.Effect<ProviderDeclaration, never, R> =>
  prepare.pipe(
    Effect.catch((cause) => {
      const detail = failureDetail(cause);
      return Effect.logWarning("An Agent could not be prepared for execution").pipe(
        Effect.annotateLogs({ instanceId, cause }),
        Effect.as<ProviderDeclaration>({
          driver: identity.driver,
          ...(identity.displayName?.trim() ? { displayName: identity.displayName } : {}),
          ...(identity.source ? { source: identity.source } : {}),
          enabled: false,
          unavailable: {
            message: detail
              ? `Nodex couldn’t prepare this Agent: ${detail}`
              : "Nodex couldn’t prepare this Agent.",
          },
        }),
      );
    }),
  );
