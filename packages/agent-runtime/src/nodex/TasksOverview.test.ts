import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";

it.live("serves each task overview section with its total", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-task-overview-" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const request = (method: string, input: unknown = {}) =>
          runtime.handle({ id: method, method, input });
        yield* request("project.upsert", {
          id: "project:overview",
          title: "Overview",
          workspaceRoot: home,
        });
        yield* request("command.dispatch", {
          command: {
            type: "thread.create",
            commandId: "command:overview",
            threadId: "thread:overview",
            projectId: "project:overview",
            title: "Overview",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: home,
            createdBy: "user",
            creationSource: "web",
          },
        });
        expect(
          (yield* request("command.dispatch", {
            command: {
              type: "background-task.settle",
              commandId: "command:forged-settle",
              threadId: "thread:overview",
              providerThreadId: "provider:forged",
              taskId: "still-running",
              turnItemIds: [],
            },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const empty = { items: [], nextCursor: null, hasMore: false, totalCount: 0 };
        expect(
          yield* request("background.output", { threadId: "thread:overview", taskId: "missing" }),
        ).toBeNull();
        for (const taskIds of [
          undefined,
          [],
          ["duplicate", "duplicate"],
          Array.from({ length: 26 }, (_, i) => `task:${i}`),
        ]) {
          expect(
            (yield* request("background.stop", {
              threadId: "thread:overview",
              commandId: "command:invalid-stop",
              taskIds,
            }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          yield* request("background.stop", {
            threadId: "thread:overview",
            commandId: "command:stop-one-empty",
            taskIds: ["missing"],
          }),
        ).toEqual({ stopping: [] });
        const cancel = yield* request("tasks.cancel", {
          threadId: "thread:overview",
          taskId: "missing",
          commandId: "command:cancel-missing",
        }).pipe(Effect.result);
        expect(cancel._tag).toBe("Failure");
        expect(yield* request("tasks.overview", { threadId: "thread:overview" })).toEqual({
          active: empty,
          terminal: empty,
        });
        yield* request("command.dispatch", {
          command: {
            type: "thread.pull-request.watch",
            commandId: "command:overview-watch",
            threadId: "thread:overview",
            host: "github.com",
            repository: "acme/app",
            number: 1,
            watching: true,
            link: { url: "https://github.com/acme/app/pull/1", source: "agent" },
          },
        });
        const stop = {
          threadId: "thread:overview",
          commandId: "command:overview-stop",
          taskIds: ["pull-request-watch:github.com/acme/app#1"],
        };
        expect(yield* request("background.stop", stop)).toEqual({
          stopping: [],
        });
        expect(yield* request("background.stop", stop)).toEqual({
          stopping: [],
        });
      }).pipe(
        Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
