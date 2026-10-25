import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live(
  "publishes captured auth configuration and stable revisions across real peer reads and duplicate starts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-auth-metadata-" });
      const log = `${home}/requests.jsonl`;
      yield* fs.writeFileString(log, "");
      const provider = {
        driver: "acpRegistry",
        enabled: true,
        config: {
          source: "local",
          discovery: "explicit",
          commandPath: process.execPath,
          commandArgs: [
            fileURLToPath(new URL("./testing/acp-management-peer.mjs", import.meta.url)),
          ],
        },
        environment: [
          { name: "HOME", value: home, sensitive: false },
          { name: "ACP_MANAGEMENT_LOG", value: log, sensitive: false },
        ],
      };
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          runtime
            .handle({ id: method, method, input })
            .pipe(Effect.map((output) => output as AgentRuntimeOperations[M]["output"]));
        const target = { instanceId: "first", ownerId: "window" };
        const idle = yield* call("acp.auth.read", target);
        expect(idle).toMatchObject({ phase: "idle", cancellable: false });
        expect(idle.runtimeGeneration.length).toBeGreaterThan(0);
        const started = yield* call("acp.auth.start", { ...target, methodId: "login" });
        expect(started).toMatchObject({
          configurationRevision: idle.configurationRevision,
          runtimeGeneration: idle.runtimeGeneration,
          cancellable: true,
        });
        yield* fs.readFileString(log).pipe(
          Effect.repeat({
            until: (text) => text.includes('"auth/login"'),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        const live = yield* call("acp.auth.read", target);
        expect(live.revision).toBeGreaterThanOrEqual(started.revision);
        const passive = yield* call("acp.auth.read", { ...target, ownerId: "other-window" });
        expect(passive).toMatchObject({
          flowId: null,
          cancellable: false,
          configurationRevision: started.configurationRevision,
        });
        expect(yield* call("acp.auth.read", target)).toEqual(live);
        expect(yield* call("acp.auth.start", { ...target, methodId: "login" })).toEqual(live);
        expect((yield* fs.readFileString(log)).split('"auth/login"')).toHaveLength(2);
        yield* call("providers.configure", {
          providers: { first: provider, unrelated: { ...provider, enabled: false } },
        });
        expect(yield* call("acp.auth.read", target)).toEqual(live);
        expect(
          (yield* call("acp.auth.read", { ...target, ownerId: "other-window" }))
            .configurationRevision,
        ).toBe(started.configurationRevision);
        const cancelled = yield* call("acp.auth.cancel", { ...target, flowId: started.flowId! });
        expect(cancelled).toMatchObject({
          phase: "cancelled",
          cancellable: false,
          configurationRevision: started.configurationRevision,
        });
        expect(cancelled.revision).toBeGreaterThan(live.revision);
        const next = yield* call("acp.auth.start", { ...target, methodId: "login" });
        expect(next.flowId).not.toBe(started.flowId);
        expect(next.configurationRevision).toBeGreaterThan(started.configurationRevision);
        expect(next.runtimeGeneration).toBe(started.runtimeGeneration);
        yield* call("acp.auth.cancel", { ...target, flowId: next.flowId! });
      }).pipe(
        Effect.provide(
          Application.layer({ home, cwd: home, providers: { first: provider } }, () => Effect.void),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
