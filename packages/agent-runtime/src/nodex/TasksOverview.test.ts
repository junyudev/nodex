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
        });
        const empty = { items: [], nextCursor: null, hasMore: false, totalCount: 0 };
        expect(yield* request("tasks.overview", { threadId: "thread:overview" })).toEqual({
          active: empty,
          terminal: empty,
        });
      }).pipe(
        Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
