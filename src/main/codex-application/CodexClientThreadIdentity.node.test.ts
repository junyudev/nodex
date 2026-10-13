import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistedAtomStore } from "../local-store/persisted-atoms";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { make } from "./CodexClientThreadIdentity";

it.effect(
  "publishes actual hosted launch readiness only after its sole Profile identity commits",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-m13-identity-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const store = new PersistedAtomStore(join(directory, "atoms.json"));
      const events: CodexApplicationEvent[] = [];
      const identity = yield* make(store).pipe(
        Effect.provideService(ProjectWorkspace, {
          getProjectSession: () => Effect.die("No Session command"),
          getThread: () => Effect.die("No Thread command"),
        } as unknown as ProjectWorkspace["Service"]),
        Effect.provideService(CodexApplicationEventHub, {
          events: Stream.empty,
          publish: (event) => events.push(event),
        }),
      );
      const client = "client-new-thread:ready";
      yield* identity.remember("native:one", client, "ssh:owner");
      assert.strictEqual(yield* identity.threadIdFor(client, "ssh:owner"), "native:one");
      assert.isNull(yield* identity.threadIdFor(client, "local"));
      assert.deepStrictEqual(events, [
        {
          kind: "codex",
          value: {
            type: "createdThreadTargetChanged",
            hostId: "ssh:owner",
            threadId: "native:one",
            clientThreadId: client,
          },
        },
      ]);
      assert.isTrue(
        Exit.isFailure(
          yield* identity.remember("native:other", client, "ssh:owner").pipe(Effect.exit),
        ),
      );
      assert.strictEqual(events.length, 1);
      yield* identity.forget("native:one", "ssh:owner");
      assert.isNull(yield* identity.threadIdFor(client, "ssh:owner"));
    }),
);
