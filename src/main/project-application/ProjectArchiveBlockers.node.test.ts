import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import type { ProjectSessionSummary } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { ProjectArchiveBlockers, live } from "./ProjectArchiveBlockers";

it.effect(
  "Project archive sees child execution and background work without opening any transcript",
  () => {
    const activity = vi.fn(() =>
      Effect.succeed({
        snapshotSequence: 12,
        run: { threadId: "child:active", runId: "run:child", status: "running" },
        runtimeRequest: { threadId: "child:waiting", requestId: "request" },
        nativeBackground: { threadId: "root:completed", taskId: "native:background" },
      }),
    );
    const terminals = vi.fn(() =>
      Effect.succeed([{ sessionId: "terminal", projectSessionId: "session" }]),
    );
    const root = {
      id: "session",
      executionRef: { runtimeId: "runtime", threadId: "root" },
    } as ProjectSessionSummary;
    return Effect.gen(function* () {
      const blockers = yield* ProjectArchiveBlockers;
      assert.deepEqual(yield* blockers.list({ project: { id: "project" }, sessions: [root] }), [
        { kind: "terminal", terminalSessionId: "terminal", projectSessionId: "session" },
        { kind: "active-turn", threadId: "child:active", label: null },
        { kind: "pending-request", threadId: "child:waiting", label: null },
        {
          kind: "background-process",
          threadId: "root:completed",
          processId: "native:background",
          label: null,
        },
      ]);
      assert.deepEqual(activity.mock.calls, [["project"]]);
      assert.deepEqual(terminals.mock.calls, [
        [{ conversationIds: new Set(["root"]), projectSessionIds: new Set(["session"]) }],
      ]);
    }).pipe(
      Effect.provide(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AgentRuntimeApplication, {
                projectActivity: activity,
              } as unknown as AgentRuntimeApplication["Service"]),
              Layer.succeed(TerminalSessions, {
                listLiveSessionsForOwners: terminals,
              } as unknown as TerminalSessions["Service"]),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "an unavailable execution owner fails closed, including Projects with no visible Sessions",
  () => {
    const unavailable = new AgentRuntimeApplicationError({
      operation: "project-activity",
      message: "Runtime unavailable",
    });
    return Effect.gen(function* () {
      const blockers = yield* ProjectArchiveBlockers;
      const result = yield* blockers
        .list({ project: { id: "project" }, sessions: [] })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure, unavailable);
    }).pipe(
      Effect.provide(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AgentRuntimeApplication, {
                projectActivity: () => Effect.fail(unavailable),
              } as unknown as AgentRuntimeApplication["Service"]),
              Layer.succeed(TerminalSessions, {
                listLiveSessionsForOwners: () => Effect.succeed([]),
              } as unknown as TerminalSessions["Service"]),
            ),
          ),
        ),
      ),
    );
  },
);
