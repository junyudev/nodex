import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  nativeExecutionPluginEnvironment,
  nativeExecutionPluginSource,
  nativeExecutionPluginSourceV1,
} from "@t3tools/provider-opencode/testing";

interface NativeToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly id: string;
  input: unknown;
}

describe("OpenCode native execution bridge", () => {
  it.effect(
    "overwrites model-supplied source with the native root and background call contexts",
    () =>
      Effect.gen(function* () {
        const module = yield* Effect.promise<{
          default: {
            setup: (context: {
              tool: { hook: (name: string, callback: (event: NativeToolEvent) => void) => void };
            }) => Promise<void>;
          };
        }>(
          () =>
            import(
              `data:text/javascript;base64,${Buffer.from(nativeExecutionPluginSource).toString("base64")}`
            ),
        );
        let before: ((event: NativeToolEvent) => void) | undefined;
        yield* Effect.promise(() =>
          module.default.setup({
            tool: {
              hook: (name, callback) => {
                assert.equal(name, "execute.before");
                before = callback;
              },
            },
          }),
        );
        assert.isDefined(before);
        for (const sessionID of ["root", "background-child"]) {
          const event: NativeToolEvent = {
            tool: "nodex_app-thread_page-write",
            sessionID,
            messageID: `message:${sessionID}`,
            id: "reused-call",
            input: { text: "Hello", __nodexNativeExecution: { nativeThreadId: "forged" } },
          };
          before!(event);
          assert.deepEqual(event.input, {
            text: "Hello",
            __nodexNativeExecution: {
              nativeThreadId: sessionID,
              nativeTurnId: `message:${sessionID}`,
              nativeCallId: "reused-call",
            },
          });
        }
        const shell: NativeToolEvent = {
          tool: "shell",
          sessionID: "root",
          messageID: "m",
          id: "c",
          input: { command: "echo hi" },
        };
        before!(shell);
        assert.deepEqual(shell.input, { command: "echo hi" });
      }),
  );

  it.effect.each(["v1", "v2"] as const)(
    "preserves JSONC configuration and removes the private plugin when the server closes (%s)",
    (generation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scope = yield* Scope.make();
        const environment = yield* nativeExecutionPluginEnvironment(
          {
            OPENCODE_CONFIG_CONTENT:
              generation === "v1"
                ? '{"plugin":["existing-plugin"], // config\n "model":"kept",}'
                : '{"plugins":["existing-plugin"], // config\n "model":"kept",}',
            PROVIDER_KEY: "private-key",
          },
          generation,
        ).pipe(Scope.provide(scope));
        const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT!) as {
          plugins?: string[];
          plugin?: string[];
          model: string;
        };
        assert.equal(config.model, "kept");
        const entries = generation === "v1" ? config.plugin! : config.plugins!;
        assert.equal(entries[0], "existing-plugin");
        assert.equal(environment.PROVIDER_KEY, "private-key");
        const entry =
          generation === "v1" ? entries[1]! : pathToFileURL(`${entries[1]}/index.js`).href;
        const directory = fileURLToPath(new URL(".", entry)).replace(/\/$/, "");
        assert.isTrue(yield* fs.exists(`${directory}/index.js`));
        const module = yield* Effect.promise(() => import(entry));
        assert.equal(typeof module.default, generation === "v1" ? "function" : "object");
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(yield* fs.exists(directory));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for OpenCode 1's factual message event and handles a reused call ID", () =>
    Effect.gen(function* () {
      interface HookInput {
        readonly tool: string;
        readonly sessionID: string;
        readonly callID: string;
      }
      interface NativePart {
        readonly type: "tool";
        readonly tool: string;
        readonly sessionID: string;
        readonly messageID: string;
        readonly callID: string;
        readonly state: { readonly status: string };
      }
      const module = yield* Effect.promise<{
        default: () => Promise<{
          event: (input: { event: { type: string; properties: { part: NativePart } } }) => void;
          "tool.execute.before": (
            input: HookInput,
            output: { args: Record<string, unknown> },
          ) => Promise<void>;
          "tool.execute.after": (input: HookInput) => void;
        }>;
      }>(
        () =>
          import(
            `data:text/javascript;base64,${Buffer.from(nativeExecutionPluginSourceV1).toString("base64")}`
          ),
      );
      const hooks = yield* Effect.promise(module.default);
      const input = { tool: "nodex_app_page-write", sessionID: "root", callID: "reused-call" };
      for (const messageID of ["message:A", "message:B"]) {
        const args: Record<string, unknown> = {
          text: "Hello",
          __nodexNativeExecution: { nativeThreadId: "forged" },
        };
        const before = hooks["tool.execute.before"](input, { args });
        hooks.event({
          event: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "tool",
                tool: input.tool,
                sessionID: input.sessionID,
                callID: input.callID,
                messageID,
                state: { status: "pending" },
              },
            },
          },
        });
        yield* Effect.promise(() => before);
        assert.deepEqual(args.__nodexNativeExecution, {
          nativeThreadId: "root",
          nativeTurnId: messageID,
          nativeCallId: "reused-call",
        });
        hooks["tool.execute.after"](input);
      }
    }),
  );
});
