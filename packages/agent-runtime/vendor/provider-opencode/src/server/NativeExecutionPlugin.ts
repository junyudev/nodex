import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { pathToFileURL } from "node:url";

import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

/** Native tool context is attached after model input validation, never accepted from the model. */
export const source = `export default {
  id: "nodex-native-execution",
  async setup({ tool }) {
    await tool.hook("execute.before", (event) => {
      if (!event.tool.startsWith("t3-code-")) return;
      event.input = {
        ...(event.input ?? {}),
        __nodexNativeExecution: {
          nativeThreadId: event.sessionID,
          nativeTurnId: event.messageID,
          nativeCallId: event.id,
        },
      };
    });
  },
};
`;

/** OpenCode 1 publishes each tool's immutable message context before its before-tool hook. */
export const sourceV1 = `export default async function () {
  const calls = new Map();
  const waiting = new Map();
  const keyOf = (sessionID, callID) => JSON.stringify([sessionID, callID]);
  const owns = (tool) => tool.startsWith("t3-code_");
  return {
    event({ event }) {
      if (event.type !== "message.part.updated") return;
      const part = event.properties.part;
      if (part.type !== "tool" || !owns(part.tool)) return;
      const key = keyOf(part.sessionID, part.callID);
      if (part.state.status === "completed" || part.state.status === "error") {
        if (calls.get(key)?.nativeTurnId === part.messageID) calls.delete(key);
        return;
      }
      if (!calls.has(key) && calls.size >= 4096) return;
      const source = { nativeThreadId: part.sessionID, nativeTurnId: part.messageID, nativeCallId: part.callID };
      calls.set(key, source);
      waiting.get(key)?.(source);
    },
    async "tool.execute.before"(input, output) {
      if (!owns(input.tool)) return;
      const key = keyOf(input.sessionID, input.callID);
      const source = calls.get(key) ?? await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiting.delete(key);
          reject(new Error("Native tool call context did not arrive."));
        }, 3000);
        waiting.set(key, (source) => {
          clearTimeout(timeout);
          waiting.delete(key);
          resolve(source);
        });
      });
      output.args.__nodexNativeExecution = source;
    },
    "tool.execute.after"(input) {
      if (owns(input.tool)) calls.delete(keyOf(input.sessionID, input.callID));
    },
  };
}
`;

/** One private, credential-free plugin for the locally owned server's lifetime. */
export const environment = Effect.fn("OpenCode.NativeExecutionPlugin.environment")(function* (
  inherited: NodeJS.ProcessEnv,
  generation: "v1" | "v2" = "v2",
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-opencode-native-" });
  yield* fs.chmod(directory, 0o700);
  yield* fs.writeFileString(`${directory}/index.js`, generation === "v1" ? sourceV1 : source);
  yield* fs.writeFileString(`${directory}/package.json`, '{"type":"module","main":"index.js"}');
  const content = OpenCodeRuntime.resolveOpenCodeConfigContent(inherited);
  const config = yield* Schema.decodeUnknownEffect(
    fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
  )(content);
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      ...(generation === "v1"
        ? {
            plugin: [
              ...(Array.isArray(config.plugin) ? config.plugin : []),
              pathToFileURL(`${directory}/index.js`).href,
            ],
          }
        : {
            plugins: [...(Array.isArray(config.plugins) ? config.plugins : []), directory],
          }),
    }),
  };
  return environment;
});
