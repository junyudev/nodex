import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProjectSession } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexSidebarSectionSync } from "../codex-application/CodexSidebarSectionSync";
import { ProjectSessionCommands, live } from "./ProjectSessionCommands";

const fixture = () => {
  const calls: Array<{ method: string; command: unknown }> = [];
  const browsers: string[] = [];
  const sections: string[] = [];
  let denied = false;
  let committed = false;
  const mutation = (method: string) => (command: unknown) =>
    Effect.gen(function* () {
      calls.push({ method, command });
      if (denied)
        return yield* new AgentRuntimeApplicationError({
          operation: method,
          message: "Scope denied",
          ...(committed ? { committedOperationId: "operation" } : {}),
        });
      return {
        value: {
          id: "session",
          thread: null,
          executionRef: { runtimeId: "runtime", threadId: "engine" },
        } as ProjectSession,
        apply: {} as never,
      };
    });
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentRuntimeApplication, {
          renameSession: mutation("rename"),
          archiveSession: mutation("archive"),
          unarchiveSession: mutation("unarchive"),
          setPinnedSession: mutation("pin"),
          deleteSession: (command: unknown) =>
            mutation("delete")(command).pipe(Effect.map(({ apply }) => ({ value: true, apply }))),
        } as unknown as AgentRuntimeApplication["Service"]),
        Layer.succeed(BrowserApplication, {
          closeConversation: (id: string) =>
            Effect.sync(() => browsers.push(id)).pipe(Effect.asVoid),
        } as unknown as BrowserApplication["Service"]),
        Layer.succeed(CodexSidebarSectionSync, {
          request: (reason: string) =>
            Effect.sync(() => {
              sections.push(reason);
            }),
        } as unknown as CodexSidebarSectionSync["Service"]),
      ),
    ),
  );
  return {
    calls,
    browsers,
    sections,
    layer,
    deny: () => {
      denied = true;
    },
    committedFailure: () => {
      denied = true;
      committed = true;
    },
  };
};
it.effect(
  "Session organization uses one semantic execution owner and closes browser resources after accepted deletion",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const commands = yield* ProjectSessionCommands;
      const target = { operationId: "operation", payload: { sessionId: "session" } };
      yield* commands.rename({
        ...target,
        payload: { ...target.payload, input: { title: "Named" } },
      });
      yield* commands.archive(target);
      yield* commands.unarchive(target);
      yield* commands.setPinned({ ...target, payload: { ...target.payload, pinned: true } });
      yield* commands.delete(target);
      assert.deepEqual(
        f.calls.map(({ method }) => method),
        ["rename", "archive", "unarchive", "pin", "delete"],
      );
      assert.deepEqual(f.browsers, ["session"]);
      assert.equal(f.sections.length, 5);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "accepted deletion closes product resources even when durable execution cleanup needs retry",
  () => {
    const f = fixture();
    f.committedFailure();
    return Effect.gen(function* () {
      const commands = yield* ProjectSessionCommands;
      const result = yield* commands
        .delete({ operationId: "operation", payload: { sessionId: "session" } })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.committedOperationId, "operation");
      assert.deepEqual(f.browsers, ["session"]);
      assert.deepEqual(f.sections, ["local-mutation"]);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "a rejected Session command does not close its browser or publish a catalog mutation",
  () => {
    const f = fixture();
    f.deny();
    return Effect.gen(function* () {
      const commands = yield* ProjectSessionCommands;
      const result = yield* commands
        .delete({ operationId: "operation", payload: { sessionId: "session" } })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(f.browsers, []);
      assert.deepEqual(f.sections, []);
    }).pipe(Effect.provide(f.layer));
  },
);
