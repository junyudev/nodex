import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import {
  nativeSessionCatalogTitle,
  type NativeSessionCatalogEntry,
  type NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { nativeSessionCwdAvailable } from "../../platform/node/NativeSessionCatalogPaths";

/** Antigravity's kind of history, as its definition declares it. */
export const antigravityHistory = antigravityAgent.capabilities.nativeHistory;

/** Why an Antigravity conversation can't be offered or copied, in words the person can act on. */
export class AntigravityCatalogRefusal extends Schema.TaggedError<AntigravityCatalogRefusal>()(
  "AntigravityCatalogRefusal",
  { message: Schema.String },
) {}

/**
 * Reads the person's own Antigravity history through one enabled profile. Every profile reads the
 * same history, in one list; the Runtime replays a conversation before Nodex admits its copy.
 */
export const makeAntigravityNativeCatalog = (runtime: AgentRuntimeApplication["Service"]) => {
  const project = (entry: NativeSessionCatalogEntry) =>
    Effect.promise(() => nativeSessionCwdAvailable(entry.cwd)).pipe(
      Effect.map((cwdAvailable) => ({
        ...entry,
        title: nativeSessionCatalogTitle(entry.title, "Antigravity conversation"),
        cwdAvailable,
      })),
    );
  const list = Effect.fn("AntigravityNativeCatalog.list")(function* (
    instanceConfigId: string,
    cursor?: string,
  ) {
    if (cursor !== undefined)
      return yield* new AntigravityCatalogRefusal({
        message: "Antigravity conversations are returned in one list.",
      });
    const page = yield* runtime.listAntigravityHistory(instanceConfigId);
    const entries = yield* Effect.forEach(page.entries, project, { concurrency: 8 });
    return { ...page, entries } satisfies NativeSessionCatalogPage;
  });
  return {
    list,
    /** The conversation as the history lists it now, or null when it is gone. */
    inspect: Effect.fn("AntigravityNativeCatalog.inspect")(function* (
      nativeSessionId: string,
      instanceConfigId: string,
      expectedHome?: string,
    ) {
      const page = yield* runtime.listAntigravityHistory(instanceConfigId);
      if (expectedHome !== undefined && page.nativeHome !== expectedHome)
        return yield* new AntigravityCatalogRefusal({
          message: "Antigravity's history folder changed. Refresh and try again.",
        });
      const match = page.entries.find((entry) => entry.nativeSessionId === nativeSessionId);
      if (!match) return null;
      return {
        ...(yield* project(match)),
        backendKind: antigravityHistory,
        instanceConfigId,
        nativeHome: page.nativeHome,
        model: null,
      };
    }),
    /** Replays the conversation once, so one that can't be copied is refused before admission. */
    verify: Effect.fn("AntigravityNativeCatalog.verify")(function* (source: {
      readonly instanceConfigId: string;
      readonly nativeHome: string;
      readonly nativeSessionId: string;
      readonly cwd: string;
      readonly cwdAvailable: boolean;
    }) {
      if (!source.cwdAvailable)
        return yield* new AntigravityCatalogRefusal({
          message: "The original Antigravity conversation's folder is no longer available.",
        });
      yield* runtime.verifyAntigravityHistory({
        instanceConfigId: source.instanceConfigId,
        home: source.nativeHome,
        sessionId: source.nativeSessionId,
        sourceCwd: source.cwd,
      });
    }),
  };
};
