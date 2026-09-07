import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { make } from "./ContentQueryAppTools";

it.effect(
  "requires an actor Project for SQL and schema discovery even under Library authority",
  () =>
    Effect.gen(function* () {
      const authority: FrozenNodexAgentTurnAuthority = {
        threadId: "thread",
        turnId: "turn",
        rootThreadId: "thread",
        actorProjectId: null,
        libraryId: "library",
        storeEpoch: "epoch",
        frozenAtMs: 1,
        readOnly: false,
        scope: "library",
        source: "builtin_full_access",
      };
      const execute = yield* make.pipe(
        Effect.provideService(CodexTurnAuthority, {
          capture: () => Effect.succeed(authority),
        } as never),
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
        Effect.provideService(CoreModules, {
          query: { read: () => Effect.die("Projectless SQL must not reach Core") },
        } as never),
      );
      for (const name of ["query_content", "describe_content_schema"] as const) {
        const result = yield* execute({
          name,
          arguments: {},
          caller: {
            threadId: "thread",
            turnId: "turn",
            callId: name,
            hostId: "local",
            generation: 1,
            isActive: () => true,
          },
        });
        assert.isTrue(result.isError);
        assert.deepEqual(result.structuredContent, {
          error: { code: "project_context_required" },
        });
      }
    }),
);
