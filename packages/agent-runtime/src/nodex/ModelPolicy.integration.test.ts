import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../../../src/shared/model-policy.ts";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live(
  "refuses person and cross-provider Session/task intake, keeps histories readable, and applies live policy",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-model-policy-" });
      const providers = {
        codex: {
          driver: "codex",
          enabled: false,
          config: { setupMode: "existing", binaryPath: "/missing" },
        },
        nodex_codex_alice: {
          driver: "codex",
          source: "nodex" as const,
          enabled: false,
          config: { setupMode: "existing", binaryPath: "/missing" },
        },
      };
      return yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        let sequence = 0;
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          runtime
            .handle({ id: String(++sequence), method, input })
            .pipe(Effect.map((value) => value as AgentRuntimeOperations[M]["output"]));
        yield* call("project.upsert", { id: "project", title: "Policy", workspaceRoot: home });
        for (const [threadId, instanceId] of [
          ["native", "codex"],
          ["credit", "nodex_codex_alice"],
        ]) {
          yield* call("command.dispatch", {
            command: {
              type: "thread.create",
              commandId: `create:${threadId}`,
              threadId: threadId!,
              projectId: "project",
              title: "Policy",
              modelSelection: { instanceId: instanceId!, model: "gpt-6.1-sol" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: home,
              createdBy: "user",
              creationSource: "web",
            },
          });
        }
        const send = (threadId: string, senderThreadId?: string) =>
          call("command.dispatch", {
            command: {
              type: "message.dispatch",
              commandId: `send:${++sequence}`,
              threadId,
              messageId: `message:${sequence}`,
              text: "No inference",
              attachments: [],
              createdBy: senderThreadId ? "agent" : "user",
              creationSource: senderThreadId ? "mcp" : "web",
              ...(senderThreadId ? { senderThreadId } : {}),
              dispatchMode: { type: "start_immediately" },
            },
          });
        for (const origin of ["person", "nodex-agent"] as const)
          expect(
            yield* call("models.assert", {
              modelSelection: { instanceId: "nodex_codex_alice", model: "gpt-6.1-sol" },
              origin,
            }),
          ).toBeNull();
        expect(
          yield* Effect.flip(
            call("models.assert", {
              modelSelection: { instanceId: "nodex_codex_alice", model: "gpt-6.1-sol" },
              origin: "automatic",
            }),
          ),
        ).toMatchObject({ code: "credit_requires_person" });
        const cross = yield* Effect.flip(send("credit", "native"));
        expect(cross).toMatchObject({ code: "credit_requires_person", retryable: false });
        expect(
          yield* call("models.assert", {
            modelSelection: { instanceId: "nodex_codex_alice", model: "gpt-6.1-sol" },
            origin: "agent",
            caller: { threadId: "credit" },
          }),
        ).toBeNull();
        expect(
          yield* Effect.flip(
            call("models.assert", {
              modelSelection: { instanceId: "nodex_codex_alice", model: "gpt-6.1-sol" },
              origin: "nodex-agent",
              caller: { threadId: "native" },
            }),
          ),
        ).toMatchObject({ code: "credit_requires_person" });
        const off = setModelOn(
          DEFAULT_MODEL_POLICY,
          { instanceId: "nodex_codex_alice", driver: "codex", source: "nodex" },
          "gpt-6.1-sol",
          false,
        );
        yield* call("providers.configure", { providers, modelPolicy: off });
        for (const sender of [undefined, "native", "credit"]) {
          expect(yield* Effect.flip(send("credit", sender))).toMatchObject({
            code: "model_off",
            retryable: false,
            message: "GPT-6.1 Sol on Nodex is off in Settings → Models. Choose another model.",
          });
        }
        expect(
          (yield* call("thread.read", { threadId: "credit" }))?.modelSelection.instanceId,
        ).toBe("nodex_codex_alice");
        const compact = yield* Effect.flip(
          call("thread.compact", { threadId: "credit", requestId: "compact-off" }),
        );
        expect(compact).toMatchObject({ code: "model_off" });
        yield* call("providers.configure", {
          providers,
          modelPolicy: { ...off, providersOff: ["nodex"] },
        });
        expect(
          (yield* call("providers.read", {})).some((provider) => provider.source === "nodex"),
        ).toBe(false);
        expect(
          (yield* call("thread.read", { threadId: "credit" }))?.modelSelection.instanceId,
        ).toBe("nodex_codex_alice");
        // Utilities bypass Session intake; their own common dispatcher must refuse them too.
        const utility = yield* Effect.flip(
          call("text.generate-structured", {
            cwd: home,
            prompt: "No inference",
            modelSelection: { instanceId: "nodex_codex_alice", model: "gpt-6.1-sol" },
            outputSchema: { type: "object" },
          }),
        );
        expect(String(utility)).toContain("off");
      }).pipe(Effect.provide(Application.layer({ home, cwd: home, providers }, () => Effect.void)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a closed Nodex provider never materializes managed instances from bootstrap credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-model-policy-bootstrap-" });
      return yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const providers = yield* runtime.handle({
          id: "closed-catalog",
          method: "providers.read",
          input: {},
        });
        expect(providers).toEqual([]);
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              modelPolicy: { ...DEFAULT_MODEL_POLICY, providersOff: ["nodex"] },
              providers: {
                nodex_codex_alice: {
                  driver: "codex",
                  source: "nodex",
                  enabled: true,
                  config: { setupMode: "existing", binaryPath: "/must-not-launch" },
                  environment: [
                    {
                      name: "NODEX_GATEWAY_API_KEY",
                      value: "synthetic-key-must-not-reach-a-process",
                      sensitive: true,
                    },
                  ],
                },
              },
            },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
