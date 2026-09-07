import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import { make } from "./WorkspaceDependencyAppTools";
import type { AppToolInvocation } from "./AppToolInvocationInbox";

it.effect(
  "allows dependency inspection in a read-only Turn but requires current calling authority",
  () =>
    Effect.gen(function* () {
      let authorized = true;
      let active = true;
      let reads = 0;
      const execute = yield* make.pipe(
        Effect.provideService(CodexTurnAuthority, {
          capture: () => Effect.succeed(authorized ? { readOnly: true } : null),
        } as never),
        Effect.provideService(WorkspaceDependencyRuntime, {
          read: Effect.sync(() => {
            reads++;
            return { status: "unavailable" as const, reason: "not_installed" as const };
          }),
        }),
      );
      const input: AppToolInvocation = {
        name: "load_workspace_dependencies",
        arguments: {},
        caller: {
          threadId: "thread",
          turnId: "turn",
          callId: "call",
          hostId: "local",
          generation: 1,
          isActive: () => active,
        },
      };
      assert.deepEqual((yield* execute(input)).structuredContent, {
        status: "unavailable",
        reason: "not_installed",
      });
      assert.strictEqual(reads, 1);
      authorized = false;
      assert.deepEqual((yield* execute(input)).structuredContent, {
        error: { code: "authority_unavailable" },
      });
      active = false;
      assert.deepEqual((yield* execute(input)).structuredContent, {
        error: { code: "call_withdrawn" },
      });
      assert.strictEqual(reads, 1);
    }),
);
